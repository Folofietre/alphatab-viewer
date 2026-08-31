import { computed, ref, shallowRef } from 'vue'
import { usePlayer, scoreEditHost } from '@/composables/usePlayer'
import {
  MAX_FRET,
  MIN_FRET,
  RETUNE_KEEP_PITCH,
  RETUNE_REASSIGN,
  applyScoreTempo,
  describeNote,
  renameTrack,
  retuneTrack,
  setNoteFret,
  shiftNoteString,
  tempoInfo,
  transposeTrackByFrets,
  transposeTrackByTuning,
  tuningChoices,
} from '@/utils/scoreEdits'
import { downloadScoreAsGp } from '@/utils/exportScore'

// Editing state and orchestration: selection, the "modified" flag, and deciding
// what has to be re-rendered or re-generated after each edit.
//
// The division of labour, which is the point of the whole design:
//   scoreEdits.js  writes the model, and nothing else. Pure, named, tested.
//   this file       decides what the write invalidates, and tracks selection.
//   EditPanel.vue   renders flat reactive data and calls the functions below.
//
// No component ever touches the alphaTab model, so a command stack could be
// added later by giving each function in scoreEdits.js an inverse, without
// rewriting any UI.
//
// Module-level state, exactly like usePlayer: there is one score and one api, so
// there is one selection.

// The selected Note, in a PLAIN variable.
//
// Never a reactive ref: a Note sits in a cyclic graph (note -> beat -> voice ->
// bar -> staff -> track -> score, all with back-references) and deep-proxying it
// would be slow and would risk breaking alphaTab internals. The UI reads the
// flat `selectedNote` descriptor instead. Same rule as `scoreTracks` in
// usePlayer.
let selected = null

// alphaTab has no edit-selection API, so this is built on `noteMouseDown`, which
// it already emits because `enableUserInteraction` is on.
//
// Keyed on the API INSTANCE rather than on a boolean, so `bind()` is idempotent
// for a given api but re-subscribes when the api is replaced. `ScoreViewer`
// calls `destroy()` on unmount and `init()` on mount, so a new AlphaTabApi is a
// real possibility (a hot reload is enough), and a plain latch would leave the
// selection silently dead against an api nobody is listening to.
//
// Nothing is ever unsubscribed: a destroyed api takes its emitters with it.
let boundApi = null

// Set by `beatMouseDown` and cleared by `noteMouseDown`. See the handlers below.
let missedNote = false

// Which track the panel edits. Deliberately NOT the same thing as which tracks
// are DISPLAYED (`descriptor.rendered`): a user can have five staves on screen
// and still be renaming one of them.
const selectedTrackIndex = ref(0)

// Flat, plain description of the selected note. shallowRef because the value is
// replaced wholesale, never mutated in place.
const selectedNote = shallowRef(null)

// The last thing an edit had to say. Refusals land here with their reason; a
// successful edit clears it. Nothing else writes it, so a message on screen is
// always about the most recent attempt.
const editMessage = shallowRef(null)

const isExporting = ref(false)

// Where to draw the selection marker, as plain rectangles in the coordinate
// space of alphaTab's host element: [{ x, y, w, h }].
//
// Why an overlay rather than colouring the note itself: alphaTab CAN colour a
// note natively through `note.style` (verified - the renderer honours it, and it
// does not leak into an exported .gp), but a style change only shows after
// `api.render()`, so highlighting on click would re-lay out the score on every
// click. Positioning a div costs nothing.
//
// Why not CSS: the SVG groups elements per BEAT (`<g class="b80">`), not per
// note, so a stylesheet cannot isolate one note of a chord.
//
// The coordinates need no scroll maths. This is exactly how alphaTab positions
// its own playback cursor: an absolutely positioned child of the host, moved
// with `transform: translate(bounds.x, bounds.y)`. Being inside the scrolled
// content, it follows the score for free.
//
// Usually TWO rectangles, not one: a note appears once as a head on the standard
// notation staff and once as a fret number on the tablature, and `findBeats()`
// returns one BeatBounds per staff. Marking both is the point.
const selectedNoteRects = shallowRef([])


function message(kind, text) {
  editMessage.value = text ? { kind, text } : null
}

// Apply the propagation matrix for one edit result.
//
// Getting this wrong is the expensive mistake in an editor: too little and the
// display is stale, too much and every keystroke re-lays out the whole score.
//
//   render          the notation changed (a label, a fret, a tuning, a tempo
//                   marking). `api.render()` re-lays out the notation only; it
//                   leaves the synth and the playhead alone.
//   midi            what is PLAYED changed, so the midi has to be regenerated
//                   from the model. Two flavours:
//                     'now'    - rebuild immediately. For TIMING changes (the
//                                tempo), because the loaded midi is what maps a
//                                scrub position to a tick, and a stale one makes
//                                the transport lie.
//                     'onPlay' - mark it stale and let usePlayer rebuild when
//                                playback starts. For pitch and fingering
//                                changes: it costs nothing while editing, and
//                                `loadMidiForScore()` calls `stop()` internally,
//                                which would cut the note preview short.
//   firstChangedBar the index of the first master bar that changed, passed as a
//                   RenderHint so alphaTab can keep the unchanged part. Only
//                   worth setting for a single-note edit; a transposition
//                   changes bar 0 onwards anyway.
function propagate(result, { render = false, midi = false, firstChangedBar = null } = {}) {
  if (!result.ok) {
    log('propagate: REFUSED -', result.reason)
    message('error', result.reason)
    return result
  }
  message(null, null)
  if (!result.changed) {
    log('propagate: edit applied but nothing changed (already that value)')
    return result
  }

  log('propagate: applied. render =', render, '| midi =', midi,
    '| firstChangedBar =', firstChangedBar)
  scoreEditHost.markDirty()

  if (render) {
    const api = scoreEditHost.api
    // `reuseViewport` tells alphaTab the new score is "similar" to the old one,
    // which is the documented live-editing hint: it skips clearing the viewport,
    // so the update reads as a change rather than as a flash.
    if (firstChangedBar === null) api?.render({ reuseViewport: true })
    else api?.render({ reuseViewport: true, firstChangedMasterBar: firstChangedBar })
  }

  if (midi === 'now') scoreEditHost.reloadMidi()
  else if (midi === 'onPlay') scoreEditHost.markMidiStale()

  return result
}

// ---------------------------------------------------------------------------
// TEMPORARY DIAGNOSTIC - remove once note selection is confirmed in a browser.
// ---------------------------------------------------------------------------
const DEBUG = '[edit-debug]'
function log(...args) {
  console.log(DEBUG, ...args)
}
function describeTarget(el) {
  if (!el) return 'null'
  return `${el.tagName ?? '?'}${el.type ? `[type=${el.type}]` : ''}${el.className ? `.${String(el.className).split(' ')[0]}` : ''}`
}
// ---------------------------------------------------------------------------

function bind() {
  const api = scoreEditHost.api
  if (!api || api === boundApi) {
    log('bind() skipped:', !api ? 'no api yet' : 'already bound to this api')
    return
  }
  boundApi = api

  // The single most important line: if this says false, note selection CANNOT
  // work and no amount of clicking will help. It has to be set when the
  // AlphaTabApi is constructed, so a hard reload is needed after changing it.
  log('bind() subscribing. core.includeNoteBounds =', api.settings?.core?.includeNoteBounds,
    '| player.enableUserInteraction =', api.settings?.player?.enableUserInteraction)
  // A new api means a new model, so nothing that was selected still exists.
  clearSelection()

  // Note selection needs `core.includeNoteBounds` in usePlayer's settings, which
  // defaults to false: without it alphaTab never runs the note hit-test and this
  // handler is never called. See the comment at that setting.
  api.noteMouseDown.on((note) => {
    log('noteMouseDown FIRED. string =', note?.string, 'fret =', note?.fret,
      'isStringed =', note?.isStringed, 'harmonicType =', note?.harmonicType)
    missedNote = false
    selected = note
    selectedNote.value = describeNote(note)
    // Selecting a note is also how the user says which track they are working
    // on, so keep the panel pointing at the same place they just clicked.
    const trackIndex = selectedNote.value?.trackIndex
    if (typeof trackIndex === 'number') selectedTrackIndex.value = trackIndex
    refreshSelectionRects()
    message(null, null)
  })

  // A render rebuilds the bounds lookup, so the marker has to be re-read from
  // it. This covers every path at once: an edit, a track change, a resize,
  // a bars-per-row change.
  api.postRenderFinished.on(() => {
    refreshSelectionRects()
  })

  // Say so when a click landed on a beat but not on a note head.
  //
  // alphaTab's hit-test is a STRICT rectangle over `note.noteHeadBounds`, with
  // no tolerance, so clicking a hair off a fret digit selects nothing. Without
  // this, that failure is completely silent and indistinguishable from the
  // shortcut being broken.
  //
  // How it detects the miss: alphaTab fires `beatMouseDown` and then, in the
  // same synchronous handler, `noteMouseDown` if a note was hit. So the flag set
  // here is still true by the time the microtask runs only when no note was hit.
  api.beatMouseDown.on((beat) => {
    log('beatMouseDown fired (bar', beat?.voice?.bar?.masterBar?.index,
      '). Waiting to see whether noteMouseDown follows...')
    missedNote = true
    queueMicrotask(() => {
      if (!missedNote) {
        log('  -> a note WAS hit, selection updated.')
        return
      }
      missedNote = false
      log('  -> NO note hit: the click landed on the beat but outside every note head.')
      message('info', 'No note there. Click directly on a note head to select it.')
    })
  })

  // Closing a score has no alphaTab event, so usePlayer calls this directly.
  // Dropping the selection is what lets the old score graph be collected.
  scoreEditHost.onScoreCleared = () => {
    clearSelection()
    selectedTrackIndex.value = 0
    message(null, null)
  }

  // A new score means a new object graph, so the old Note points into a model
  // that is no longer displayed. This also covers a revert, which reloads the
  // original bytes.
  api.scoreLoaded.on(() => {
    clearSelection()
    selectedTrackIndex.value = 0
    message(null, null)
  })
}

function clearSelection() {
  selected = null
  selectedNote.value = null
  selectedNoteRects.value = []
  missedNote = false
}

// Re-read the selected note's rectangles from the bounds lookup.
//
// Called on selection and after every render, because a render rebuilds the
// lookup and the old coordinates are then meaningless. `includeNoteBounds` in
// usePlayer's settings is what makes `beatBounds.notes` non-empty at all.
function refreshSelectionRects() {
  const lookup = scoreEditHost.api?.boundsLookup ?? null
  if (!selected || !lookup) {
    selectedNoteRects.value = []
    return
  }
  const rects = []
  for (const beatBounds of lookup.findBeats(selected.beat) ?? []) {
    for (const noteBounds of beatBounds.notes ?? []) {
      if (noteBounds.note !== selected) continue
      const b = noteBounds.noteHeadBounds
      rects.push({ x: b.x, y: b.y, w: b.w, h: b.h })
    }
  }
  selectedNoteRects.value = rects
  log('selection marker rects:', JSON.stringify(rects))
}

export function useScoreEdit() {
  const player = usePlayer()
  bind()

  // The descriptor of the track being edited, from usePlayer's flat reactive
  // list. Falls back to the first track so the panel is never blank when the
  // selected index outlives a score change.
  const editedTrack = computed(
    () =>
      player.tracks.value.find((t) => t.index === selectedTrackIndex.value) ??
      player.tracks.value[0] ??
      null,
  )

  // Tuning choices for the edited track. Read through the host because it needs
  // the Staff, and a Staff is model data that never reaches a component.
  const tuningOptions = computed(() => {
    const track = scoreEditHost.trackAt(editedTrack.value?.index ?? -1)
    const staff = (track?.staves ?? []).find((s) => s.isStringed)
    return staff ? tuningChoices(staff) : []
  })

  // The tempo as the score holds it, plus how many automations there are. Above
  // one, the BPM field is moving a tempo MAP and the UI has to say so.
  const tempo = computed(() => {
    // scoreInfo is refreshed on load and after a tempo edit, so it is the right
    // reactive trigger for a value that otherwise lives in the model.
    const info = player.scoreInfo.value
    return info ? tempoInfo(scoreEditHost.score) : { tempo: null, automationCount: 0 }
  })

  // Editing is only allowed while paused.
  //
  // Rather than making every edit survive being applied mid-playback (a moving
  // playhead, a midi rebuild that stops the sound, a preview note fighting the
  // score), the whole panel stands down. `isPlaying` is the right flag for this
  // even though a note preview also makes the synth play: `playOneTimeMidiFile`
  // sets the synth's `state` field directly, and `state` is a plain field with
  // no setter and no event, so a preview fires no `playerStateChanged` and
  // cannot lock the panel against itself.
  const canEdit = computed(() => player.isScoreLoaded.value && !player.isPlaying.value)

  function refusePlayback() {
    const reason = 'Pause playback to edit the score.'
    log('edit BLOCKED: isPlaying =', player.isPlaying.value,
      '| isScoreLoaded =', player.isScoreLoaded.value)
    message('error', reason)
    return { ok: false, changed: false, reason }
  }

  function selectTrack(index) {
    if (!player.tracks.value.some((t) => t.index === index)) return
    selectedTrackIndex.value = index
    message(null, null)
  }

  // ---- the seven operations ------------------------------------------------

  // Renaming touches the stave label and nothing that is played.
  function rename(name) {
    if (!canEdit.value) return refusePlayback()
    const index = editedTrack.value?.index
    const result = renameTrack(scoreEditHost.trackAt(index ?? -1), name)
    if (result.changed) scoreEditHost.syncTrack(index)
    return propagate(result, { render: true })
  }

  // The tempo marking is drawn on the score AND drives playback. `now` rather
  // than `onPlay`, because this is the one edit that changes TIMING: the loaded
  // midi is what maps a scrub position to a tick, so leaving it stale would make
  // the transport bar disagree with the score.
  function setTempo(bpm) {
    if (!canEdit.value) return refusePlayback()
    const result = applyScoreTempo(scoreEditHost.score, bpm)
    if (result.changed) scoreEditHost.syncScoreInfo()
    return propagate(result, { render: true, midi: 'now' })
  }

  // Both transposition modes change the notation and the pitches.
  function transposeByTuning(semitones) {
    if (!canEdit.value) return refusePlayback()
    const index = editedTrack.value?.index
    const result = transposeTrackByTuning(scoreEditHost.trackAt(index ?? -1), semitones)
    if (result.changed) scoreEditHost.syncTrack(index)
    return propagate(result, { render: true, midi: 'onPlay' })
  }

  function transposeByFrets(semitones) {
    if (!canEdit.value) return refusePlayback()
    const index = editedTrack.value?.index
    const result = transposeTrackByFrets(scoreEditHost.trackAt(index ?? -1), semitones)
    if (result.changed) {
      scoreEditHost.syncTrack(index)
      refreshSelection()
    }
    return propagate(result, { render: true, midi: 'onPlay' })
  }

  function retune(tunings, mode) {
    if (!canEdit.value) return refusePlayback()
    const index = editedTrack.value?.index
    const result = retuneTrack(scoreEditHost.trackAt(index ?? -1), tunings, mode)
    if (result.changed) {
      scoreEditHost.syncTrack(index)
      refreshSelection()
    }
    return propagate(result, { render: true, midi: 'onPlay' })
  }

  // One note. Renders incrementally from the bar that changed, and defers the
  // midi rebuild so a held arrow key does not queue one per repeat.
  function setSelectedFret(fret) {
    if (!canEdit.value) return refusePlayback()
    if (!selected) {
      message('error', 'Click a note in the score first.')
      return { ok: false, changed: false, reason: 'No note selected.' }
    }
    const bar = selectedNote.value?.barIndex ?? null
    const trackIndex = selectedNote.value?.trackIndex ?? null

    const result = setNoteFret(selected, fret)
    if (result.changed) {
      selectedNote.value = describeNote(selected)
      if (typeof trackIndex === 'number') scoreEditHost.syncTrack(trackIndex)
      // Sound the new pitch. Straight from the model, so it is already correct
      // by this point and needs no midi rebuild - which is exactly why the
      // rebuild is deferred to `onPlay`: doing it now would call stop() and cut
      // this off.
      const sounded = scoreEditHost.previewNote(selected)
      log('preview note:', sounded ? 'played' : 'NOT played (player not ready?)',
        '| midi key =', selected.realValue)
    }
    return propagate(result, {
      render: true,
      midi: 'onPlay',
      firstChangedBar: bar,
    })
  }

  // Alt + arrow: move the selected note to the adjacent string, keeping its
  // pitch. Only the fingering moves, so the score sounds identical.
  //
  // Running out of strings is left SILENT, like running out of frets below: it
  // is the natural end of a repeatable key and a message per press would be
  // noise. Every other refusal - an occupied string, a fret that would land off
  // the neck, a natural harmonic - is explained, because those are surprising.
  function nudgeSelectedString(delta) {
    if (!canEdit.value) return refusePlayback()
    log('nudgeSelectedString(', delta, ') | a note is selected:', !!selected,
      selected ? `(string ${selected.string}, fret ${selected.fret})` : '')
    if (!selected) {
      log('  -> ABORT: nothing selected. Click a note head first.')
      return { ok: false, changed: false, reason: 'No note selected.' }
    }

    const bar = selectedNote.value?.barIndex ?? null
    const trackIndex = selectedNote.value?.trackIndex ?? null
    const strings = selectedNote.value?.stringCount ?? 0
    const target = selected.string + delta

    // The edge of the fretboard: silent.
    if (target < 1 || target > strings) {
      log('  -> refused silently: no string', target, '(staff has', strings, ')')
      return { ok: false, changed: false, reason: `There is no string ${target}.` }
    }

    const result = shiftNoteString(selected, delta)
    if (result.changed) {
      selectedNote.value = describeNote(selected)
      if (typeof trackIndex === 'number') scoreEditHost.syncTrack(trackIndex)
      // No preview here, deliberately: this move keeps the pitch, so there
      // would be nothing new to hear. The silence is the tell that separates it
      // from the semitone nudge, which does sound.
    }
    // The pitch is unchanged, but the midi still has to follow: the generator
    // reads `beat.hasNoteOnString()` to work out where a let-ring stops.
    return propagate(result, {
      render: true,
      midi: 'onPlay',
      firstChangedBar: bar,
    })
  }

  // Alt + SHIFT + arrow. A refusal at the bounds is left SILENT on purpose: this
  // is a repeatable key, and a message per press would be noise. The reason is
  // still returned, so a caller that wants it can show it.
  function nudgeSelectedFret(delta) {
    if (!canEdit.value) return refusePlayback()
    log('nudgeSelectedFret(', delta, ') | a note is selected:', !!selected,
      selected ? `(string ${selected.string}, fret ${selected.fret})` : '')
    if (!selected) {
      log('  -> ABORT: nothing selected. Click a note head first.')
      return { ok: false, changed: false, reason: 'No note selected.' }
    }
    const target = selected.fret + delta
    if (target < MIN_FRET || target > MAX_FRET) {
      log('  -> refused silently: fret', target, 'is out of the', MIN_FRET, '-', MAX_FRET, 'range')
      return { ok: false, changed: false, reason: `Fret ${target} is out of range.` }
    }
    // Anything else that refuses - a natural harmonic, say - keeps its message:
    // only the bounds are silent, and they were already checked above.
    return setSelectedFret(target)
  }

  // Re-read the selected note after an edit that may have moved it.
  function refreshSelection() {
    if (selected) selectedNote.value = describeNote(selected)
  }

  // ---- saving -------------------------------------------------------------

  function download() {
    const score = scoreEditHost.score
    if (!score) {
      message('error', 'No score to save.')
      return null
    }
    isExporting.value = true
    try {
      const saved = downloadScoreAsGp(score, scoreEditHost.api?.settings, player.fileName.value)
      // The file is on disk, so there is nothing unsaved any more.
      scoreEditHost.clearDirty()
      message('ok', `Saved ${saved.fileName}.`)
      return saved
    } catch (error) {
      message('error', error?.message || 'Could not export this score.')
      return null
    } finally {
      isExporting.value = false
    }
  }

  // Throw away every edit. The confirmation is the caller's job, because only
  // the UI knows whether it can ask.
  function revert() {
    if (!player.revertToOriginal()) {
      message('error', 'The original file is no longer available.')
      return false
    }
    message('ok', 'Reverted to the file as it was opened.')
    return true
  }

  return {
    // Wiring the selection needs a live api, and `useShortcuts()` runs in a
    // parent's setup, before ScoreViewer has called `init()`. Callers hand this
    // back a chance in onMounted, where children have already mounted. It is
    // guarded, so calling it repeatedly is free.
    bindSelection: bind,

    // selection
    selectedTrackIndex,
    selectedNote,
    selectedNoteRects,
    editedTrack,
    selectTrack,
    clearSelection,

    // reads for the UI
    tuningOptions,
    tempo,
    canEdit,
    editMessage,
    isExporting,
    isDirty: player.isDirty,

    // edits
    rename,
    setTempo,
    transposeByTuning,
    transposeByFrets,
    retune,
    setSelectedFret,
    nudgeSelectedFret,
    nudgeSelectedString,

    // saving
    download,
    revert,
    canRevert: player.canRevert,

    // constants the UI needs for its input bounds
    MIN_FRET,
    MAX_FRET,
    RETUNE_KEEP_PITCH,
    RETUNE_REASSIGN,
  }
}
