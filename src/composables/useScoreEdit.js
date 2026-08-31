import { computed, ref, shallowRef } from 'vue'
import { usePlayer, scoreEditHost } from '@/composables/usePlayer'
import {
  MAX_FRET,
  MIN_FRET,
  deleteNotes,
  RETUNE_KEEP_PITCH,
  RETUNE_REASSIGN,
  applyScoreTempo,
  describeNote,
  renameTrack,
  retuneTrack,
  notesInTickRange,
  setNoteFret,
  shiftNoteString,
  shiftNotesFret,
  shiftNotesString,
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
//   scoreEdits.js       writes the model, and nothing else. Pure, named, tested.
//   this file           decides what the write invalidates, and tracks selection.
//   TrackEditPanel.vue  render flat reactive data and call the functions below.
//   ScoreEditPanel.vue  Split by SCOPE: one edits a track, the other the score.
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

// The notes covered by a click-and-drag range, in a PLAIN array for the same
// reason `selected` is a plain variable: these are model objects.
//
// alphaTab already builds and DRAWS this selection for its loop range, and
// exposes it through `playbackRangeHighlightChanged` with the start and end
// beats. So the range costs no new interaction code and no new marker - the
// highlight blocks alphaTab paints are the marker.
let rangeNotes = []

// Flat description of that range, for the panel: which track, how many notes,
// which bars. Null when there is no range.
const selectedRange = shallowRef(null)

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
    message('error', result.reason)
    return result
  }
  message(null, null)
  if (!result.changed) return result

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

function bind() {
  const api = scoreEditHost.api
  if (!api || api === boundApi) return
  boundApi = api
  // A new api means a new model, so nothing that was selected still exists.
  clearSelection()

  // Note selection needs `core.includeNoteBounds` in usePlayer's settings, which
  // defaults to false: without it alphaTab never runs the note hit-test and this
  // handler is never called. See the comment at that setting.
  api.noteMouseDown.on((note) => {
    missedNote = false
    clearRange()
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

  // The click-and-drag range, straight from alphaTab's own loop selection.
  //
  // A plain click fires this with EMPTY args: `_cursorSelectRange` triggers `{}`
  // when the start and end beats are the same, which is exactly what
  // distinguishes a click from a drag. alphaTab also normalises the order
  // itself, so `startBeat` is always the earlier one.
  //
  // The range is taken as a TICK WINDOW on the track the drag STARTED on. A drag
  // that wanders onto another staff still edits the track it began on, which is
  // the track the user was looking at - and it keeps every operation
  // single-track, like the transposition and the retuning.
  api.playbackRangeHighlightChanged.on((args) => {
    const { startBeat, endBeat } = args ?? {}
    if (!startBeat || !endBeat) {
      clearRange()
      return
    }
    const track = startBeat.voice?.bar?.staff?.track ?? null
    if (!track) {
      clearRange()
      return
    }

    const startTick = startBeat.absolutePlaybackStart
    const endTick = endBeat.absolutePlaybackStart + endBeat.playbackDuration
    rangeNotes = notesInTickRange(track, startTick, endTick)

    if (rangeNotes.length === 0) {
      clearRange()
      return
    }

    // A range and a single note are two different things to act on, so having
    // both would make Alt+arrow ambiguous. The range wins, since it is the more
    // deliberate gesture.
    clearSelection()
    selectedTrackIndex.value = track.index
    selectedRange.value = {
      trackIndex: track.index,
      trackName: track.name?.trim() || `Track ${track.index + 1}`,
      noteCount: rangeNotes.length,
      startBar: startBeat.voice.bar.masterBar.index,
      endBar: endBeat.voice.bar.masterBar.index,
    }
    // Ring every note the batch will touch, with the same marker the single
    // selection uses.
    refreshSelectionRects()
    message(null, null)
  })

  // A click that landed on a beat but not on a note head DESELECTS.
  //
  // Clicking a bar is a normal seek, not a mistake, so this is silent: the ring
  // vanishing is the feedback, and a message on every seek would be noise.
  //
  // How the miss is detected: alphaTab fires `beatMouseDown` and then, in the
  // same synchronous handler, `noteMouseDown` if the hit-test found a note head.
  // So the flag set here is still true by the time the microtask runs only when
  // no note was hit.
  //
  // Limit worth knowing: alphaTab only fires `beatMouseDown` when the click is
  // inside a bar (`if (beat)` guards it), so clicking the page well away from
  // any staff does not reach this and leaves the selection alone.
  api.beatMouseDown.on(() => {
    missedNote = true
    queueMicrotask(() => {
      if (!missedNote) return
      missedNote = false
      clearSelection()
      message(null, null)
    })
  })

  // Closing a score has no alphaTab event, so usePlayer calls this directly.
  // Dropping the selection is what lets the old score graph be collected.
  scoreEditHost.onScoreCleared = () => {
    clearSelection()
    clearRange()
    selectedTrackIndex.value = 0
    message(null, null)
  }

  // A new score means a new object graph, so the old Note points into a model
  // that is no longer displayed. This also covers a revert, which reloads the
  // original bytes.
  api.scoreLoaded.on(() => {
    clearSelection()
    clearRange()
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

function clearRange() {
  rangeNotes = []
  selectedRange.value = null
  // The rings went with it, unless a single note is selected.
  refreshSelectionRects()
}

// Re-read the rectangles for everything currently selected, single note or
// dragged range, from the bounds lookup.
//
// ONE marker for both, deliberately. alphaTab's own selection band cannot do
// this job: it spans the full bar height across every displayed staff, while a
// batch edit touches exactly one track, so as edit feedback it says "all tracks"
// about a single-track operation. It also cannot express the range rule ("beats
// that START inside the selection") - a beat straddling the edge looks included
// when it is not.
//
// So the two visuals keep two distinct jobs: the band is the time span, which is
// also alphaTab's loop range (mouseUp calls `applyPlaybackRangeFromHighlight`),
// and a ring means "this note will be edited". The single note is then just the
// N=1 case.
//
// Called on every selection change and after every render, because a render
// rebuilds the lookup and the old coordinates are then meaningless.
// `includeNoteBounds` in usePlayer's settings is what makes `beatBounds.notes`
// non-empty at all.
function refreshSelectionRects() {
  const lookup = scoreEditHost.api?.boundsLookup ?? null
  const notes = selected ? [selected] : rangeNotes
  if (notes.length === 0 || !lookup) {
    selectedNoteRects.value = []
    return
  }

  // Grouped by beat rather than looked up per note: `findBeats` returns the
  // bounds for a whole beat, so a chord of six notes would otherwise repeat the
  // same lookup six times.
  const wanted = new Set(notes)
  const rects = []
  for (const beat of new Set(notes.map((note) => note.beat))) {
    for (const beatBounds of lookup.findBeats(beat) ?? []) {
      for (const noteBounds of beatBounds.notes ?? []) {
        if (!wanted.has(noteBounds.note)) continue
        const b = noteBounds.noteHeadBounds
        rects.push({ x: b.x, y: b.y, w: b.w, h: b.h })
      }
    }
  }
  selectedNoteRects.value = rects
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

  function refused(reason) {
    message('error', reason)
    return { ok: false, changed: false, reason }
  }

  function refusePlayback() {
    const reason = 'Pause playback to edit the score.'
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

  // The midi program. The write itself already lives in usePlayer (it needs the
  // automation rewrite from trackSound.js), so this only adds the playback gate
  // and the panel's error reporting on top of it.
  function setInstrument(program) {
    if (!canEdit.value) return refusePlayback()
    const index = editedTrack.value?.index
    if (typeof index !== 'number') return refused('No track selected.')
    if (editedTrack.value?.isPercussion) {
      return refused('Percussion plays on the drum channel and has no program number.')
    }
    player.setTrackProgram(index, program)
    message(null, null)
    return { ok: true, changed: true, reason: null }
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
      scoreEditHost.previewNote(selected)
    }
    return propagate(result, {
      render: true,
      midi: 'onPlay',
      firstChangedBar: bar,
    })
  }

  // Delete / Backspace: replace whatever is selected with silence.
  //
  // Works on one note or a whole dragged range, and empties every beat it fully
  // covers - `Beat.isRest` is a getter, so a beat with no notes left is already
  // a rest of the same duration.
  //
  // The selection goes with it: the notes no longer exist, so nothing could be
  // pointed at afterwards.
  //
  // The one edit with no way back except `Revert`, so it is a plain action with
  // no confirmation: asking every time would make it useless for one note, and a
  // threshold on the count would be arbitrary. `isDirty` already warns before
  // the score is replaced or closed.
  function deleteSelection() {
    if (!canEdit.value) return refusePlayback()

    const notes = selected ? [selected] : rangeNotes
    if (notes.length === 0) {
      return { ok: false, changed: false, reason: 'Nothing selected to delete.' }
    }

    const trackIndex = selected
      ? (selectedNote.value?.trackIndex ?? null)
      : (selectedRange.value?.trackIndex ?? null)
    const bar = selected
      ? (selectedNote.value?.barIndex ?? null)
      : (selectedRange.value?.startBar ?? null)

    const result = deleteNotes(notes, scoreEditHost.api?.settings)
    if (result.changed) {
      clearSelection()
      clearRange()
      if (typeof trackIndex === 'number') scoreEditHost.syncTrack(trackIndex)
    }
    // `deleteNotes` already ran finish(), which recomputes the tick grid - but it
    // recomputes it to the same values, since removing a note does not change any
    // duration. So the midi can still wait for the next play.
    return propagate(result, { render: true, midi: 'onPlay', firstChangedBar: bar })
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

    // A dragged range takes precedence: it is the more deliberate gesture, and
    // selecting one excludes the other.
    if (rangeNotes.length > 0) return nudgeRangeString(delta)

    if (!selected) return { ok: false, changed: false, reason: 'No note selected.' }

    const bar = selectedNote.value?.barIndex ?? null
    const trackIndex = selectedNote.value?.trackIndex ?? null
    const strings = selectedNote.value?.stringCount ?? 0
    const target = selected.string + delta

    // The edge of the fretboard: silent.
    if (target < 1 || target > strings) {
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

  // The same two operations over a dragged range. All or nothing, so a refusal
  // is loud rather than silent: with twelve notes selected there is no way to
  // guess which one hit the end of the neck, and a repeated key is not going to
  // walk out of it the way a single note does.
  function nudgeRangeString(delta) {
    const result = shiftNotesString(rangeNotes, delta)
    if (result.changed) {
      scoreEditHost.syncTrack(selectedRange.value?.trackIndex)
      refreshSelectionRects()
    }
    return propagate(result, {
      render: true,
      midi: 'onPlay',
      firstChangedBar: selectedRange.value?.startBar ?? null,
    })
  }

  function nudgeRangeFret(delta) {
    const result = shiftNotesFret(rangeNotes, delta)
    if (result.changed) {
      scoreEditHost.syncTrack(selectedRange.value?.trackIndex)
      refreshSelectionRects()
      // Sound the chord the range starts on rather than all of it: playing forty
      // notes at once would be noise, and the first beat says what changed.
      scoreEditHost.previewBeat(rangeNotes[0]?.beat)
    }
    return propagate(result, {
      render: true,
      midi: 'onPlay',
      firstChangedBar: selectedRange.value?.startBar ?? null,
    })
  }

  // Alt + SHIFT + arrow. A refusal at the bounds is left SILENT on purpose: this
  // is a repeatable key, and a message per press would be noise. The reason is
  // still returned, so a caller that wants it can show it.
  function nudgeSelectedFret(delta) {
    if (!canEdit.value) return refusePlayback()
    if (rangeNotes.length > 0) return nudgeRangeFret(delta)
    if (!selected) return { ok: false, changed: false, reason: 'No note selected.' }
    const target = selected.fret + delta
    if (target < MIN_FRET || target > MAX_FRET) {
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
    selectedRange,
    clearRange,
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
    setInstrument,
    setTempo,
    transposeByTuning,
    transposeByFrets,
    retune,
    setSelectedFret,
    nudgeSelectedFret,
    nudgeSelectedString,
    deleteSelection,

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
