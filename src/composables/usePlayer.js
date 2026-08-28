import { ref, shallowRef, watch } from 'vue'
import * as alphaTab from '@coderline/alphatab'
import { familyOf, programName } from '@/utils/gmPrograms'
import { applyTrackProgram, applyTrackBalance } from '@/utils/trackSound'

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

const masterVolume = ref(0.8)
const playbackSpeed = ref(1)
const isLooping = ref(false)
const metronome = ref(false)

const VOLUME_KEY = 'alphatab_viewer_volume'

const storedVolume = Number.parseFloat(localStorage.getItem(VOLUME_KEY) ?? '')
if (Number.isFinite(storedVolume)) {
  masterVolume.value = Math.min(1, Math.max(0, storedVolume))
}

function trackDescriptor(track, renderedIndexes) {
  const program = track.playbackInfo?.program ?? 0
  return {
    index: track.index,
    name: track.name?.trim() || `Track ${track.index + 1}`,
    isPercussion: track.isPercussion,
    // Percussion is driven by the drum channel, not by a program number, so
    // the sound picker is meaningless there.
    program: track.isPercussion ? null : program,
    programLabel: track.isPercussion ? 'Percussion kit' : programName(program),
    family: track.isPercussion ? 'Drums' : familyOf(program),
    color: colorToCss(track.color),
    rendered: renderedIndexes.has(track.index),
    volume: 1,
    // 0-16, 8 = centre. Seeded from the file, which usually pans tracks apart.
    balance: track.playbackInfo?.balance ?? 8,
    isMute: false,
    isSolo: false,
  }
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

    api = new alphaTab.AlphaTabApi(element, {
      core: {
        fontDirectory: `${import.meta.env.BASE_URL}font/`,
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
    })

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
    tracks.value = []
    scoreInfo.value = null
    scoreTracks = []
    api?.stop()
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
    descriptor.program = value
    descriptor.programLabel = programName(value)
    descriptor.family = familyOf(value)

    // The midi is generated from the data model, so a program change only takes
    // effect after the midi is rebuilt.
    pendingRestore = { tick: api.tickPosition, wasPlaying: isPlaying.value }
    api.loadMidiForScore()
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
    pendingRestore = { tick: api.tickPosition, wasPlaying: isPlaying.value }
    api.loadMidiForScore()
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
      pendingRestore = { tick: api.tickPosition, wasPlaying: isPlaying.value }
      api.loadMidiForScore()
    }
  }

  // ---- transport ----------------------------------------------------------

  function playPause() {
    api?.playPause()
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

    setTrackRendered,
    showOnlyTrack,
    showAllTracks,
    setTrackProgram,
    setTrackVolume,
    setTrackBalance,
    setTrackMute,
    setTrackSolo,
    resetMixer,

    playPause,
    stop,
    seekToTime,

    isScoreLoaded,
    isPlayerReady,
    isRendering,
    isPlaying,
    loadError,
    fileName,
    tracks,
    scoreInfo,
    position,
    masterVolume,
    playbackSpeed,
    isLooping,
    metronome,
  }
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
