import { ref, shallowRef, watch } from 'vue'
import * as alphaTab from '@coderline/alphatab'
import { familyOf, programName } from '@/utils/gmPrograms'
import { applyTrackProgram, applyTrackBalance } from '@/utils/trackSound'
import { countNaturalHarmonics, describeTuning, fretRange } from '@/utils/scoreEdits'

// Single shared alphaTab instance for the whole app.
//
// Module-level state (not a store) keeps this simple: ScoreViewer.vue owns the
// host element and calls `init()`, every other component just calls
// `usePlayer()` and reads/acts on the same state.
//
// Deliberate rule: the alphaTab `Score` / `Track` objects are NEVER put into a
// reactive ref. They are large cyclic object graphs (score → tracks → staves →
// bars → voices → beats → notes, with parent back-references) and letting Vue
// deep-proxy them would be both slow and a source of subtle breakage inside
// alphaTab. They live in the plain variables below; the UI reads the flat
// `tracks` descriptors instead.

let api = null
let scoreTracks = [] // raw alphaTab Track objects, indexed by track.index

// Set right before loadMidiForScore() so the midiLoaded handler can put the
// playhead back where it was and resume if we were playing.
let pendingRestore = null

// The bytes of the file that was opened, kept so an edit session always has a
// way back. There is no undo stack - a stack of score snapshots is not viable,
// `JsonConverter` costs 108ms and 4.4MB per snapshot on an 85-bar score - so
// this one buffer covers the worst case for the price of a reference to data
// that was read anyway.
//
// The buffer itself is a plain variable (it is data, not UI state) with a
// reactive companion flag, because the Revert button's enabled state has to
// follow it and a getter function would never re-evaluate.
let originalBytes = null
const canRevert = ref(false)

// True as soon as any edit has been applied to the model, false again after an
// export or after (re)loading a file. Lives here rather than in useScoreEdit
// because it is score-lifecycle state: `scoreLoaded` is what has to clear it,
// and that handler is here.
const isDirty = ref(false)

const isScoreLoaded = ref(false) // a score is loaded and rendered
const isPlayerReady = ref(false) // soundfont + midi loaded, playback possible
const isRendering = ref(false)
const isPlaying = ref(false)
const loadError = ref(null)
const fileName = ref('')

// Flat, reactive description of the score's tracks. One entry per track, in
// score order. `rendered` drives api.renderTracks, the rest drive the mixer.
const tracks = ref([])

const scoreInfo = shallowRef(null) // { title, artist, album, tempo, barCount }
const position = ref({ currentTime: 0, endTime: 0, currentTick: 0, endTick: 0 })

// Score layout: force a fixed number of bars on every system (row), or leave
// alphaTab to wrap as it sees fit.
const forceBarsPerRow = ref(false)
const barsPerRow = ref(4)

const masterVolume = ref(0.8)
const playbackSpeed = ref(1)
const isLooping = ref(false)
const metronome = ref(false)

const VOLUME_KEY = 'alphatab_viewer_volume'

const storedVolume = Number.parseFloat(localStorage.getItem(VOLUME_KEY) ?? '')
if (Number.isFinite(storedVolume)) {
  masterVolume.value = Math.min(1, Math.max(0, storedVolume))
}

// The MODEL-DERIVED half of a track descriptor: everything read straight off
// the Track, and therefore everything an edit can invalidate. Split out from
// the mixer half so `syncTrackFields()` can refresh it after an edit without
// resetting volume, mute, solo or what is displayed - those are app state, not
// file state.
//
// The editing fields (tuning, fret range, harmonic count) are what let
// TrackEditPanel stay a pure reader of flat reactive data, per the rule that no
// component ever touches the alphaTab model. They cost one walk of the track's notes, which is
// sub-millisecond even on a 3700-note score.
function trackModelFields(track) {
  const program = track.playbackInfo?.program ?? 0
  const staff = (track.staves ?? []).find((s) => s.isStringed) ?? null
  const frets = staff ? fretRange(staff) : { count: 0, min: 0, max: 0 }
  return {
    index: track.index,
    name: track.name?.trim() || `Track ${track.index + 1}`,
    shortName: track.shortName ?? '',
    isPercussion: track.isPercussion,
    // Percussion is driven by the drum channel, not by a program number, so
    // the sound picker is meaningless there.
    program: track.isPercussion ? null : program,
    programLabel: track.isPercussion ? 'Percussion kit' : programName(program),
    family: track.isPercussion ? 'Drums' : familyOf(program),
    color: colorToCss(track.color),

    // Editing fields. A track with no stringed staff (percussion) reports
    // isStringed false, and every fret or tuning operation refuses it.
    isStringed: !!staff,
    stringCount: staff?.tuning.length ?? 0,
    tuning: staff ? [...staff.tuning] : [],
    tuningName: staff?.tuningName || '',
    tuningLabel: staff ? describeTuning(staff.tuning) : '',
    frets,
    // Notes whose pitch does not follow their fret, which is what makes the
    // fret-based operations refuse. See pitfall 4 in scoreEdits.js.
    naturalHarmonics: staff ? countNaturalHarmonics(staff) : 0,
  }
}

function trackDescriptor(track, renderedIndexes) {
  return {
    ...trackModelFields(track),
    rendered: renderedIndexes.has(track.index),
    volume: 1,
    // 0-16, 8 = centre. Seeded from the file, which usually pans tracks apart.
    balance: track.playbackInfo?.balance ?? 8,
    isMute: false,
    isSolo: false,
  }
}

// Re-read the model half of one descriptor after an edit. Mutates in place so
// Vue sees a property-level change rather than a whole new array.
function syncTrackFields(index) {
  const track = scoreTracks.find((t) => t.index === index)
  const descriptor = tracks.value.find((t) => t.index === index)
  if (!track || !descriptor) return
  Object.assign(descriptor, trackModelFields(track))
}

// Rebuild the midi from the data model.
//
// `loadMidiForScore()` STOPS playback by design, so the tick and the playing
// state are recorded first and put back by the `midiLoaded` handler. Every
// model-side change the synth cannot be told about directly goes through here
// rather than reimplementing that dance: the midi program, the balance, and
// every edit that changes what is played.
//
// Module scope rather than inside usePlayer(), because `scoreEditHost` below
// needs it too and it only ever touches module state.
function reloadMidi(wasPlaying = isPlaying.value) {
  if (!api) return
  midiStale = false
  pendingRestore = { tick: api.tickPosition, wasPlaying }
  api.loadMidiForScore()
}

// An edit has changed what would be PLAYED, but the midi has not been rebuilt.
//
// Note-level edits mark the midi stale rather than rebuilding it, and the
// rebuild happens when playback actually starts. Two reasons, and the second is
// the one that matters:
//
//  - It is free. Rebuilding costs 0-1ms on a 4-bar score, 5-15ms at 77 bars and
//    16-39ms at 118 (measured), so paying it once at the moment audio starts is
//    imperceptible, while paying it per keystroke is waste.
//  - `loadMidiForScore()` calls `stop()` internally, which would CUT the note
//    preview short. A preview is one quarter note (960 ticks, ~500ms at 120bpm),
//    so any timer short enough to feel responsive would have truncated it.
//
// Edits that change TIMING (the tempo) still rebuild immediately: the loaded
// midi is what maps a scrub position to a tick, so leaving it stale would make
// the transport lie.
let midiStale = false

// Rebuild now if an edit left the midi stale. Returns true when it did, in which
// case playback (if asked for) is resumed by the `midiLoaded` handler rather
// than by the caller.
function flushMidi(thenPlay) {
  if (!midiStale || !api) return false
  reloadMidi(thenPlay)
  return true
}

function colorToCss(color) {
  if (!color) return null
  const { r, g, b } = color
  if ([r, g, b].some((c) => typeof c !== 'number')) return null
  return `rgb(${r}, ${g}, ${b})`
}

function readScoreInfo(loaded) {
  const barCount = loaded?.masterBars?.length ?? 0
  return {
    title: loaded?.title?.trim() || '',
    artist: loaded?.artist?.trim() || '',
    album: loaded?.album?.trim() || '',
    tempo: loaded?.tempo ?? null,
    barCount,
    trackCount: loaded?.tracks?.length ?? 0,
  }
}

// The alphaTab settings this app runs on.
//
// Extracted from init() so it can be asserted without a DOM: `includeNoteBounds`
// below is load-bearing for a whole feature and was already got wrong once, and
// a test that needs an AlphaTabApi could never have caught it.
export function playerSettings(scrollElement) {
  return {
    core: {
      fontDirectory: `${import.meta.env.BASE_URL}font/`,
      // REQUIRED for note selection, and not obvious: `api.noteMouseDown` is
      // gated on this setting, which defaults to FALSE. alphaTab's click
      // handler reads
      //   if (this.settings.core.includeNoteBounds) {
      //     const note = boundsLookup?.getNoteAtPos(beat, relX, relY)
      //     if (note) this._onNoteMouseDown(e, note)
      //   }
      // and with it off the renderer builds NO note bounding boxes at all -
      // measured headlessly: 0 boxes off, 984 boxes on, on the same score. So
      // only `beatMouseDown` ever fires and the edit panel can never learn
      // which note was clicked, which is exactly how "Alt + arrow does nothing"
      // happens with no error anywhere.
      //
      // `enableUserInteraction` is a different setting entirely: it governs
      // click-to-seek and drag-to-select-a-range.
      //
      // The cost is one note-level bounding box per note head, built during
      // rendering, which is what makes note hit-testing possible at all.
      includeNoteBounds: true,
    },
    player: {
      enablePlayer: true,
      enableCursor: true,
      enableAnimatedBeatCursor: true,
      enableElementHighlighting: true,
      // A viewer wants click-to-seek and drag-to-select-a-range; the game
      // deliberately disabled this, we deliberately enable it.
      enableUserInteraction: true,
      soundFont: `${import.meta.env.BASE_URL}soundfont/sonivox.sf2`,
      scrollElement,
      scrollMode: alphaTab.ScrollMode.Continuous,
      // Land the system a little below the top edge instead of flush against
      // it. Negative, because the target scroll position is barY + this.
      scrollOffsetY: -12,
    },
    display: {
      layoutMode: alphaTab.LayoutMode.Page,
    },
  }
}

export function usePlayer() {
  // `element` hosts the alphaTab render output; `scrollElement` is the element
  // that actually scrolls and MUST be a distinct ancestor of `element`.
  //
  // Why it must be distinct: with LayoutMode.Page + ScrollMode.Continuous,
  // alphaTab's VerticalContinuousScrollHandler scrolls to
  //   getOffset(scrollContainer, api.container).y + barY + scrollOffsetY
  // and getOffset() computes
  //   container.rect.top + scrollContainer.scrollTop - scrollContainer.rect.top
  // When the scroll container IS the alphaTab container, the two rect.top terms
  // are the same number and cancel, leaving plain `scrollTop`. Every system
  // change then scrolls to `scrollTop + barY` instead of `barY`, so the view
  // runs away to the end of the score while the cursor is still mid-song, and
  // the playing bar ends up far above the viewport.
  //
  // With a real ancestor, the inner container's rect moves up as the wrapper
  // scrolls, so the expression correctly collapses to 0 and the target is barY.
  function init(element, scrollElement) {
    if (api || !element || !scrollElement) return

    api = new alphaTab.AlphaTabApi(element, playerSettings(scrollElement))

    api.masterVolume = masterVolume.value

    api.error.on((error) => {
      loadError.value = error?.message || 'alphaTab failed to load this file.'
      isScoreLoaded.value = false
      isRendering.value = false
    })

    api.renderStarted.on(() => {
      isRendering.value = true
    })
    api.postRenderFinished.on(() => {
      isRendering.value = false
    })

    api.scoreLoaded.on((loaded) => {
      scoreTracks = loaded?.tracks ?? []
      loadError.value = null

      // alphaTab renders only the first track when `load` is called without
      // explicit track indexes. Mirror whatever it actually rendered rather
      // than assuming, so the checkboxes match the display.
      const renderedIndexes = new Set((api.tracks ?? []).map((t) => t.index))
      if (renderedIndexes.size === 0 && scoreTracks.length > 0) {
        renderedIndexes.add(scoreTracks[0].index)
      }

      tracks.value = scoreTracks.map((t) => trackDescriptor(t, renderedIndexes))
      scoreInfo.value = readScoreInfo(loaded)

      // Clear any mixer state left over from the previous score.
      api.changeTrackMute(scoreTracks, false)
      api.changeTrackSolo(scoreTracks, false)
      api.changeTrackVolume(scoreTracks, 1)

      // A freshly loaded model has no edits in it, whether this was a new file
      // or a revert to the bytes we kept.
      isDirty.value = false
      midiStale = false

      isScoreLoaded.value = true
      position.value = { currentTime: 0, endTime: 0, currentTick: 0, endTick: 0 }
    })

    api.playerReady.on(() => {
      isPlayerReady.value = true
    })

    api.playerStateChanged.on((args) => {
      isPlaying.value = args.state === alphaTab.synth.PlayerState.Playing
    })

    api.playerPositionChanged.on((args) => {
      position.value = {
        currentTime: args.currentTime,
        endTime: args.endTime,
        currentTick: args.currentTick,
        endTick: args.endTick,
      }
    })

    // loadMidiForScore() stops playback by design. Restore the playhead (and
    // resume if we interrupted a playing song) once the new midi is in.
    api.midiLoaded.on((args) => {
      position.value = {
        currentTime: args.currentTime,
        endTime: args.endTime,
        currentTick: args.currentTick,
        endTick: args.endTick,
      }
      if (!pendingRestore) return
      const { tick, wasPlaying } = pendingRestore
      pendingRestore = null
      if (tick > 0) api.tickPosition = tick
      if (wasPlaying) api.play()
    })
  }

  function destroy() {
    api?.destroy()
    api = null
    scoreTracks = []
    originalBytes = null
    canRevert.value = false
    tracks.value = []
    scoreInfo.value = null
    isScoreLoaded.value = false
    isPlayerReady.value = false
    isPlaying.value = false
  }

  // ---- loading ------------------------------------------------------------

  function loadFile(file) {
    if (!api || !file) return
    loadError.value = null
    isScoreLoaded.value = false
    fileName.value = file.name
    const reader = new FileReader()
    reader.onload = (e) => {
      // Keep the bytes so `revertToOriginal()` can put this exact file back.
      // A copy, because alphaTab's importer reads from the buffer and we do not
      // want to depend on it leaving it untouched.
      originalBytes = e.target.result.slice(0)
      canRevert.value = true
      // alphaTab reports parse failures through the `error` event, not by
      // throwing, so there is nothing to catch here.
      api.load(e.target.result)
    }
    reader.onerror = () => {
      loadError.value = `Could not read ${file.name}.`
    }
    reader.readAsArrayBuffer(file)
  }

  function clearScore() {
    fileName.value = ''
    loadError.value = null
    isScoreLoaded.value = false
    isDirty.value = false
    tracks.value = []
    scoreInfo.value = null
    scoreTracks = []
    originalBytes = null
    canRevert.value = false
    // A held Note keeps its whole score graph alive through its back-references,
    // so closing has to drop the selection or nothing is actually freed. There
    // is no alphaTab event for "score closed" - `scoreLoaded` only fires on a
    // LOAD - hence the explicit hook.
    scoreEditHost.onScoreCleared?.()
    midiStale = false
    api?.stop()
  }

  // Throw away every edit and reload the file exactly as it was opened.
  //
  // This is the whole safety net for this tier of editing: there is no undo, so
  // the guarantees are that range operations refuse rather than clamp, that the
  // download is available before anything risky, and that the file as loaded is
  // always one click away.
  function revertToOriginal() {
    if (!api || !originalBytes) return false
    // scoreLoaded clears isDirty and re-seeds every descriptor.
    api.load(originalBytes.slice(0))
    return true
  }

  // ---- track rendering ----------------------------------------------------

  function applyRenderedTracks() {
    if (!api) return
    const selected = scoreTracks.filter(
      (t) => tracks.value.find((d) => d.index === t.index)?.rendered,
    )
    if (selected.length === 0) return
    api.renderTracks(selected)
  }

  function setTrackRendered(index, rendered) {
    const descriptor = tracks.value.find((t) => t.index === index)
    if (!descriptor) return
    // Never end up with an empty stave: alphaTab needs at least one track.
    if (!rendered && tracks.value.filter((t) => t.rendered).length === 1) return
    descriptor.rendered = rendered
    applyRenderedTracks()
  }

  function showOnlyTrack(index) {
    if (!tracks.value.some((t) => t.index === index)) return
    // This is now the primary click target in the track list, so bail out when
    // the track is already the only one displayed: re-laying out a score is
    // expensive and clicking the current selection is a no-op.
    const rendered = tracks.value.filter((t) => t.rendered)
    if (rendered.length === 1 && rendered[0].index === index) return
    for (const t of tracks.value) t.rendered = t.index === index
    applyRenderedTracks()
  }

  function showAllTracks() {
    for (const t of tracks.value) t.rendered = true
    applyRenderedTracks()
  }

  // ---- sound (midi program) ----------------------------------------------

  function setTrackProgram(index, program) {
    if (!api) return
    const track = scoreTracks.find((t) => t.index === index)
    const descriptor = tracks.value.find((t) => t.index === index)
    if (!track || !descriptor || track.isPercussion) return

    const value = Math.min(127, Math.max(0, Math.round(program)))
    if (track.playbackInfo.program === value) return

    if (!applyTrackProgram(track, value)) return
    syncTrackFields(index)

    // The midi is generated from the data model, so a program change only takes
    // effect after the midi is rebuilt.
    reloadMidi()
    // This writes the model, so it goes out with the exported file: it is an
    // edit, not a listening preference like volume or master volume.
    isDirty.value = true
  }

  // ---- mixer --------------------------------------------------------------

  function setTrackVolume(index, volume) {
    if (!api) return
    const track = scoreTracks.find((t) => t.index === index)
    const descriptor = tracks.value.find((t) => t.index === index)
    if (!track || !descriptor) return
    const value = Math.min(2, Math.max(0, volume))
    descriptor.volume = value
    api.changeTrackVolume([track], value)
  }

  // Panning, 0-16 with 8 = centre.
  //
  // Unlike volume/mute/solo there is no live synth setter, so this goes through
  // the data model and a full midi rebuild. That is far too expensive to run on
  // every `input` event of a drag, so callers preview with commit=false while
  // dragging and commit once on release.
  function setTrackBalance(index, balance, commit = true) {
    const track = scoreTracks.find((t) => t.index === index)
    const descriptor = tracks.value.find((t) => t.index === index)
    if (!track || !descriptor) return

    const value = Math.min(16, Math.max(0, Math.round(balance)))
    descriptor.balance = value
    if (!commit) return
    if (!api || track.playbackInfo.balance === value) return

    applyTrackBalance(track, value)
    reloadMidi()
    // Model-side, like the program: it is written into the exported file.
    isDirty.value = true
  }

  function setTrackMute(index, muted) {
    if (!api) return
    const track = scoreTracks.find((t) => t.index === index)
    const descriptor = tracks.value.find((t) => t.index === index)
    if (!track || !descriptor) return
    descriptor.isMute = muted
    api.changeTrackMute([track], muted)
  }

  function setTrackSolo(index, solo) {
    if (!api) return
    const track = scoreTracks.find((t) => t.index === index)
    const descriptor = tracks.value.find((t) => t.index === index)
    if (!track || !descriptor) return
    descriptor.isSolo = solo
    api.changeTrackSolo([track], solo)
  }

  function resetMixer() {
    if (!api) return
    api.changeTrackMute(scoreTracks, false)
    api.changeTrackSolo(scoreTracks, false)
    api.changeTrackVolume(scoreTracks, 1)

    // Balance is model-side, so it needs a midi rebuild. Do it once for the
    // whole score rather than once per track.
    let balanceChanged = false
    for (const track of scoreTracks) {
      if (track.playbackInfo.balance !== 8) {
        applyTrackBalance(track, 8)
        balanceChanged = true
      }
    }

    for (const t of tracks.value) {
      t.volume = 1
      t.balance = 8
      t.isMute = false
      t.isSolo = false
    }

    if (balanceChanged) {
      reloadMidi()
      isDirty.value = true
    }
  }

  // ---- score layout -------------------------------------------------------

  // alphaTab's `display.barsPerRow` limits how many bars go into one system,
  // with -1 meaning "wrap automatically". It is only honoured by
  // LayoutMode.Page, which is what this app uses.
  //
  // Verified against the implementation rather than the docs: the shipped
  // defaults are `barsPerRow = -1`, `layoutMode = Page` and
  // `systemsLayoutMode = 0` (Automatic). The generated docs claim
  // systemsLayoutMode defaults to `1` (UseModelLayout), which is wrong and
  // would have meant the file's own layout overriding this setting.
  //
  // A settings change needs updateSettings() to propagate and render() to take
  // effect. render() only re-lays out the notation; it leaves the synth and the
  // playback position alone, unlike loadMidiForScore().
  function applyBarsPerRow() {
    if (!api) return
    const value = forceBarsPerRow.value
      ? Math.min(32, Math.max(1, Math.round(barsPerRow.value)))
      : -1
    if (api.settings.display.barsPerRow === value) return
    api.settings.display.barsPerRow = value
    api.updateSettings()
    api.render()
  }

  function setForceBarsPerRow(enabled) {
    forceBarsPerRow.value = !!enabled
    applyBarsPerRow()
  }

  // Callers commit on `change`, not `input`: every call re-lays out the whole
  // score, so this must not fire per keystroke or per spinner tick held down.
  function setBarsPerRow(count) {
    if (!Number.isFinite(count)) return
    barsPerRow.value = Math.min(32, Math.max(1, Math.round(count)))
    if (forceBarsPerRow.value) applyBarsPerRow()
  }

  // ---- transport ----------------------------------------------------------

  function playPause() {
    if (!api) return
    // Starting playback is the moment a stale midi would be heard, so this is
    // where the rebuild is paid for. `midiLoaded` starts the playback once the
    // new midi is in, which is why there is no api.playPause() on this path.
    if (!isPlaying.value && flushMidi(true)) return
    api.playPause()
  }

  function stop() {
    api?.stop()
  }

  function seekToTime(ms) {
    if (!api) return
    api.timePosition = Math.max(0, ms)
  }

  return {
    init,
    destroy,
    loadFile,
    clearScore,
    revertToOriginal,

    setTrackRendered,
    showOnlyTrack,
    showAllTracks,
    setTrackProgram,
    setTrackVolume,
    setTrackBalance,
    setTrackMute,
    setTrackSolo,
    resetMixer,

    setForceBarsPerRow,
    setBarsPerRow,

    playPause,
    stop,
    seekToTime,

    isScoreLoaded,
    isPlayerReady,
    isRendering,
    isPlaying,
    isDirty,
    // Reactive, so the Revert control can follow it: true once a file has been
    // read, false again after clearScore().
    canRevert,
    loadError,
    fileName,
    tracks,
    scoreInfo,
    position,
    forceBarsPerRow,
    barsPerRow,
    masterVolume,
    playbackSpeed,
    isLooping,
    metronome,
  }
}

// The seam `useScoreEdit` writes through.
//
// Editing needs three things that stay module-private on purpose: the api, the
// raw alphaTab Track objects (never in a reactive ref - see the note at the top
// of this file), and the pendingRestore dance that survives a midi rebuild.
// Exposing them as an explicit named object beats either duplicating the
// playhead-restore logic in a second composable or widening the public
// `usePlayer()` surface with model internals that no component may touch.
//
// `useScoreEdit` is the only intended consumer.
export const scoreEditHost = {
  get api() {
    return api
  },
  get score() {
    return api?.score ?? null
  },
  trackAt(index) {
    return scoreTracks.find((t) => t.index === index) ?? null
  },
  // Re-read the flat descriptor for one track after an edit wrote to it.
  syncTrack(index) {
    syncTrackFields(index)
  },
  // Re-read the document strip after an edit changed the tempo.
  syncScoreInfo() {
    if (api?.score) scoreInfo.value = readScoreInfo(api.score)
  },
  // Shorthand, not a method body: `reloadMidi() { reloadMidi() }` would shadow
  // the module function with itself and recurse forever.
  reloadMidi,
  // Defer the rebuild to the moment playback starts. See `midiStale`.
  markMidiStale() {
    midiStale = true
  },
  // Sound one note, straight from the model.
  //
  // `api.playNote()` generates a ONE-NOTE midi file from the current model and
  // plays it as a one-time file, so it needs no rebuild of the score midi and
  // reflects an edit immediately (measured at 0.1ms).
  //
  // It does not disturb `isPlaying`: `playOneTimeMidiFile` sets the synth's
  // `state` field directly, and `state` is a plain field with no setter and no
  // event, so no `playerStateChanged` is fired either when the preview starts or
  // when it ends. That is what lets "edit only while paused" use `isPlaying`
  // without a preview locking the panel.
  previewNote(note) {
    if (!api || !note || !isPlayerReady.value) return false
    api.playNote(note)
    return true
  },
  // Set by useScoreEdit. Called by clearScore(), which has no alphaTab event to
  // hang off.
  onScoreCleared: null,
  markDirty() {
    isDirty.value = true
  },
  clearDirty() {
    isDirty.value = false
  },
}

// These four are plain user preferences: mirror them onto the api whenever they
// change, wherever they were changed from.
watch(masterVolume, (v) => {
  if (api) api.masterVolume = v
  localStorage.setItem(VOLUME_KEY, String(v))
})
watch(playbackSpeed, (v) => {
  if (api) api.playbackSpeed = v
})
watch(isLooping, (v) => {
  if (api) api.isLooping = v
})
watch(metronome, (v) => {
  if (api) api.metronomeVolume = v ? 1 : 0
})
