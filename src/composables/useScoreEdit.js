import { computed, ref, shallowRef } from 'vue'
import { usePlayer, scoreEditHost } from '@/composables/usePlayer'
import {
  BAR_EXACT,
  BAR_OVER,
  DURATION_LONGER,
  DURATION_SHORTER,
  MAX_FRET,
  MIN_FRET,
  appendBar,
  barFill,
  deleteBars,
  insertBarBefore,
  describeBarFill,
  describeDuration,
  deleteNotes,
  placeRest,
  stepBeatsDuration,
  toggleBeatsDot,
  writeNoteAtString,
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
  shiftNotesOctave,
  shiftNotesString,
  tempoInfo,
  transposeTrackByFrets,
  transposeTrackByTuning,
  tuningChoices,
} from '@/utils/scoreEdits'
import {
  barRects,
  cursorRects as rectsForCursor,
  positionAtPoint,
} from '@/utils/scoreGeometry'
import { downloadScoreAsGp } from '@/utils/exportScore'
import { createHistory } from '@/utils/scoreHistory'

// Editing state and orchestration: selection, the "modified" flag, and deciding
// what has to be re-rendered or re-generated after each edit.
//
// The division of labour, which is the point of the whole design:
//   scoreEdits.js       writes the model, and nothing else. Pure, named, tested.
//   this file           decides what the write invalidates, and tracks selection.
//   TrackEditPanel.vue      render flat reactive data and call the functions
//   ScoreEditPanel.vue      below. Split by SCOPE, one panel each: a whole
//   SelectionEditPanel.vue  track, the document, and whatever is selected.
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

// Double-click detection, done from alphaTab's own `beatMouseDown` rather than
// from a DOM `dblclick`.
//
// Why not the DOM event: it would need the coordinates hit-tested against
// `boundsLookup` all over again, or a listener on alphaTab's host reaching for
// the beat some other way. `beatMouseDown` has already done that work and hands
// over the Beat.
//
// What is given up is the OS double-click interval, replaced by a fixed one. The
// SAME beat is required, not just two clicks in a row, so two quick clicks on
// different beats stay two clicks - which is what someone moving the playhead
// twice means.
const DOUBLE_CLICK_MS = 400
let lastBeatDown = null
let lastBeatDownAt = 0

// Worth knowing when touching this: the two presses of a double click are two
// separate TASKS in the browser, so the deselection microtask queued by the
// first press runs before the second press arrives. Anything that resets the
// state below must therefore not sit on that path. A test that emits both
// presses synchronously will not notice.

// Set by `beatMouseDown` and cleared by `noteMouseDown`. See the handlers below.
let missedNote = false

// ---- typing a fret ---------------------------------------------------------
//
// How long a second digit still belongs to the first, so that "1" then "2" is
// fret 12 rather than fret 1 followed by fret 2.
//
// Three options were weighed and this is the one that never makes the user
// wait: the first digit is written IMMEDIATELY, and a second one inside the
// window REPLACES it. The alternatives both cost something on every single
// note - a latency of half a second before any one-digit fret appears, or an
// extra key to confirm each one - to serve the frets above 9.
//
// The correction it can produce is visible on the score and undoable, which the
// half-second of nothing is not.
const MULTI_DIGIT_MS = 800

// The note the last digit wrote, so a second digit knows whether it is still
// typing the same fret. Identity, not position: cleared by `setCursor`, so any
// arrow, click or edit in between starts a new number.
let lastDigitNote = null
let lastDigitAt = 0
let lastDigitFret = 0

function forgetTypedDigits() {
  lastDigitNote = null
  lastDigitAt = 0
  lastDigitFret = 0
}

// ---- the cursor ------------------------------------------------------------
//
// A POSITION rather than an object, which is the whole difference: a selection
// can only ever designate something that exists, and writing music means
// pointing at somewhere empty.
//
// The cursor and the selected note are the SAME thing, not two states to keep in
// step. Clicking a note selects it; the arrows navigate from it; and the only
// thing this adds is that the position may land where no note is, in which case
// `selected` is simply null and the cursor is still there. There are two
// notions in this file, not three: a position, and a range.
//
// Held as the Beat itself in a plain variable, for the reason `selected` is one:
// a Beat sits in the same cyclic graph and must never be deep-proxied. It is
// also the right key - a render rebuilds every bound rectangle but never touches
// the model, so a Beat survives exactly as long as the score does.
let cursorBeat = null

// Which string of that beat, 1-based and counting up from the lowest (pitfall 2
// in scoreEdits.js). Null is a real value and means "this beat, no string": a
// click on a standard-notation staff, or on percussion, where a Y coordinate
// carries no string information.
let cursorString = null

// The flat description of the cursor, for the UI. Same rule as `selectedNote`.
const cursorInfo = shallowRef(null)

// Where to draw the cursor, ready to place, in the host's coordinate space.
//
// EMPTY whenever the cursor sits on a note: the selection ring is already
// marking that position, and two markers on one place would say there are two.
const cursorRects = shallowRef([])

// The bar the cursor is in, as a rectangle to wash in behind it.
//
// This is OUR "current measure", following the edit cursor and the arrow keys.
// alphaTab has a bar highlight of its own but it follows the PLAYHEAD, which is
// a different question - where playback is, not where you are working - and the
// two part company the moment you press an arrow while paused.
//
// One track's bar, not the whole column across every displayed staff. Same rule
// the ring already follows: the cursor belongs to one track, and a band spanning
// every staff would say "all tracks" about a position that is in exactly one.
const cursorBarRects = shallowRef([])

// The bars holding more than their time signature allows, as rectangles.
//
// This is not decoration. alphaTab's model, its midi generator and its .gp
// exporter all accept an overfull bar without a word (pitfall 8), so nothing
// else in the stack will ever tell anyone that a bar is invalid - not while
// editing, and not when the file is written.
const overfullRects = shallowRef([])

// How full the cursor's bar is, for the counter in the action bar. Null with no
// cursor: it describes a specific bar, and without a cursor there is none.
const cursorBarFill = shallowRef(null)

// Bumped by every cursor MOVE, and by nothing else.
//
// ScoreViewer watches it to scroll the cursor back into view. It cannot watch
// the rectangles instead: those are also rebuilt after every render, with the
// same values, and scrolling on a render would fight alphaTab's own scrolling
// during playback. A counter says "the user moved", which is the only moment
// following them is right.
const cursorMoves = ref(0)

// The coordinates of the last click on the score, captured from the DOM.
//
// alphaTab's typed `beatMouseDown` carries the Beat and NO coordinates, which is
// enough to select a note (the note hit-test already ran) but not to place a
// cursor on an empty string. The DOM `alphaTab.beatMouseDown` CustomEvent it
// dispatches alongside carries `originalEvent`, the real MouseEvent - verified
// in alphaTab 1.8.4, `UiFacade.triggerEvent`, which sets it whenever the event
// came from the mouse.
//
// Order matters and is guaranteed by alphaTab: `_onBeatMouseDown` fires the
// typed event, then the DOM one, and only then `_onNoteMouseDown`. So this is
// already up to date by the time the deselect microtask runs.
let lastClickPoint = null

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

// The undo stack. Bounded, and holding field-level restore records rather than
// snapshots - see scoreHistory.js for the measurements that rule snapshots out.
//
// It has to be CLEARED whenever the score is replaced or closed: its records
// hold references to Note objects, and a Note reaches the whole score graph
// through its back-references, so a stale stack would pin an entire discarded
// score in memory. Same reasoning as the selection.
const history = createHistory()

// Mirrors of the stacks for the UI, since a plain object is not reactive.
const undoDepth = ref(0)
const undoLabel = shallowRef(null)
const redoDepth = ref(0)
const redoLabel = shallowRef(null)

function syncHistory() {
  undoDepth.value = history.size
  undoLabel.value = history.nextLabel
  redoDepth.value = history.redoSize
  redoLabel.value = history.nextRedoLabel
}

// Record an edit so it can be undone, and keep the dirty flag honest.
//
// An empty stack means every edit has been undone, so the score is back to how
// it was loaded - UNLESS the bound has thrown a record away, in which case older
// edits are still applied and `isClean` says so.
function remember(label, result) {
  if (!result?.changed || typeof result.undo !== 'function') return
  history.push(label, result.undo)
  syncHistory()
}

function forgetHistory() {
  history.clear()
  syncHistory()
}

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

// What a press on the score should take the focus off, or null.
//
// Split out from the listener for the reason `guardUnload` is: the rule is worth
// testing and the DOM around it is not. Nothing here needs a document.
//
// Blurring the body would be a no-op, so it needs no case of its own - the two
// that matter are an element with no `blur` (not everything focusable in a test
// or a future DOM has one) and anything alphaTab put inside its own host, which
// is never ours to interfere with.
export function focusToRelease(active, host) {
  if (!active || typeof active.blur !== 'function') return null
  if (host && (active === host || host.contains?.(active))) return null
  return active
}

// ---- cursor reads and writes -----------------------------------------------

// The flat description of a position, for the UI and for the shortcuts.
//
// `hasNote` is what tells "on a note" from "on an empty string", which is the
// distinction the whole cursor exists for, and it is derived rather than stored
// so it cannot disagree with `selectedNote`.
function describeCursor(beat, string) {
  if (!beat) return null
  const bar = beat.voice?.bar ?? null
  const staff = bar?.staff ?? null
  return {
    trackIndex: staff?.track?.index ?? null,
    staffIndex: staff?.index ?? null,
    // The MASTER bar index, for the same reason describeNote uses it: it is what
    // `RenderHints.firstChangedMasterBar` wants.
    barIndex: bar?.masterBar?.index ?? null,
    voiceIndex: beat.voice?.index ?? null,
    beatIndex: beat.index ?? null,
    string,
    stringCount: staff?.tuning?.length ?? 0,
    hasNote: string == null ? false : !!beat.getNoteOnString(string),
    // The duration the next thing written here will take, which is simply the
    // duration of the beat the cursor is ON. There is no fourth piece of cursor
    // state holding it, and that is the whole of "a quarter note by default":
    // `new Beat()` is born a quarter and so are the placeholders alphaTab pads
    // an unwritten bar with, so the default falls out of the model instead of
    // being a constant somewhere that could disagree with it.
    duration: beat.duration,
    durationName: describeDuration(beat.duration),
    dots: beat.dots,
    // Whether this beat sounds at all, and whether anybody has written it yet.
    // `isEmpty` is alphaTab's placeholder marker, not "a rest": a bar nobody has
    // touched holds one of those, and it is the difference between placing a
    // rest in place and inserting one beside it.
    isRest: beat.isRest,
    isUnwritten: !!beat.isEmpty,
  }
}

// Put the cursor somewhere, and bring everything that follows from it in line.
//
// This is the ONE place `selected` is written from a position, which is what
// keeps the cursor and the selection from being two states that can disagree.
// `note` is passed explicitly only where the note is already known and cannot be
// found back from the string: a percussion note reports `string: -1`, so
// `getNoteOnString` would answer null and clicking a drum would stop selecting
// anything.
function setCursor(beat, string, note = undefined) {
  if (!beat) {
    clearSelection()
    return false
  }

  // A range and a cursor are the two notions, and only one at a time: having
  // both would make every key ambiguous about what it acts on. Cleared here
  // rather than through `clearRange()`, which would refresh the rectangles a
  // second time for nothing.
  //
  // alphaTab's own selection has to go as well, or it survives this and comes
  // back on the next render - and the playhead moves here too, so play starts
  // from where the cursor is. Unconditional, unlike the range clearing it grew
  // out of: following the cursor is the point, not a tidy-up. See
  // syncPlayheadToCursor.
  rangeNotes = []
  selectedRange.value = null
  syncPlayheadToCursor(beat)

  // Any move ends the number being typed, which is what makes a second digit
  // mean "still the same fret" and nothing else. See MULTI_DIGIT_MS.
  forgetTypedDigits()

  cursorBeat = beat
  cursorString = string ?? null
  selected = note !== undefined ? note : (cursorString == null ? null : beat.getNoteOnString(cursorString) ?? null)
  selectedNote.value = describeNote(selected)
  cursorInfo.value = describeCursor(cursorBeat, cursorString)
  missedNote = false

  // Landing anywhere is also how the user says which track they are working on.
  const trackIndex = cursorInfo.value?.trackIndex
  if (typeof trackIndex === 'number') selectedTrackIndex.value = trackIndex

  refreshSelectionRects()
  refreshBarFill()
  return true
}

// A click on a note head. The string comes from the note rather than from the
// geometry, since the hit-test already answered it exactly.
function setCursorFromNote(note) {
  if (!note) return false
  return setCursor(note.beat, note.isStringed ? note.string : null, note)
}

// How full the cursor's bar is. Re-read on every cursor move, and by hand after
// every write that changes a duration or adds a beat - those move it without
// moving the cursor, and it is derived from `playbackDuration`, which is itself
// derived (pitfall 7).
function refreshBarFill() {
  const bar = cursorBeat?.voice?.bar ?? null
  cursorBarFill.value = bar ? describeBarFill(bar) : null
}

// The overfull bars, re-read from the lookup after every render for the same
// reason the selection rectangles are: a render rebuilds every rectangle, and
// the old coordinates then point nowhere.
function refreshOverfullRects() {
  const lookup = scoreEditHost.api?.boundsLookup ?? null
  overfullRects.value = lookup
    ? barRects(lookup, (bar) => barFill(bar)?.state === BAR_OVER)
    : []
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
//   label           what the undo control offers to take back. Every result that
//                   changed something carries its own `undo`; this is the human
//                   name for it.
function propagate(result, { render = false, midi = false, firstChangedBar = null, label = null } = {}) {
  if (!result.ok) {
    message('error', result.reason)
    return result
  }
  message(null, null)
  if (!result.changed) return result

  remember(label, result)
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
    // Selecting a note is putting the cursor ON it: one notion, so there is no
    // second state to keep in step. setCursor also points the panel at the
    // track that was clicked, and drops any range.
    setCursorFromNote(note)
    message(null, null)
  })

  // The coordinates of the click, which the typed events do not carry.
  //
  // alphaTab dispatches this DOM CustomEvent on its host element for every typed
  // event, with the Beat in `detail` and - when the event came from the mouse -
  // the original MouseEvent in `originalEvent`. That is the only route to the X
  // and Y of a click, and without them a click on an EMPTY string has nothing to
  // resolve: there is no Beat of its own to hand over, only a place.
  //
  // Recorded here and consumed by the `beatMouseDown` handler below rather than
  // acted on directly, so that the whole click keeps ONE ordered handler. Two
  // handlers on the same event is the arrangement that already worked only by
  // accident once, and this would be the third job on it.
  const host = scoreEditHost.hostElement

  // Clicking the score takes the focus off whatever had it.
  //
  // alphaTab calls `preventDefault()` on its own mousedown when
  // `enableUserInteraction` is on, and that SUPPRESSES THE FOCUS CHANGE - so
  // without this, clicking a note leaves the focus in whatever field or select
  // was last used. The bars-per-row select was where it showed: pick a value,
  // click the score, and the arrow keys still moved that select instead of the
  // cursor, with nothing on screen to say why.
  //
  // A plain DOM `mousedown` on the host rather than alphaTab's own event,
  // because alphaTab only fires that one when the press lands inside a bar,
  // while a press anywhere on the rendered surface should hand the keyboard
  // back.
  //
  // Blurring also COMMITS: the panels write their fields on `change`, which
  // fires on blur, so a half-typed tempo is applied rather than lost - the same
  // reason `Ctrl+S` blurs before exporting.
  host?.addEventListener('mousedown', () => {
    focusToRelease(document.activeElement, host)?.blur()
  })

  host?.addEventListener('alphaTab.beatMouseDown', (event) => {
    const mouse = event.originalEvent ?? null
    if (!mouse || !host.isConnected) {
      lastClickPoint = null
      return
    }
    // The same origin the selection marker is positioned from, which is what
    // makes these directly comparable to `boundsLookup` coordinates with no
    // scroll maths: the overlay lives inside the scrolled content.
    const box = host.getBoundingClientRect()
    lastClickPoint = { x: mouse.clientX - box.left, y: mouse.clientY - box.top }
  })

  // The other half of `gestureOnScore`. alphaTab fires this for every release
  // that followed a mousedown on the score, with or without a beat under the
  // pointer, and its own handler has already applied the selection by then - so
  // from here on the state is ours to touch again.
  api.beatMouseUp.on(() => {
    gestureOnScore = false
  })

  // A render rebuilds the bounds lookup, so every rectangle has to be re-read
  // from it. This covers every path at once: an edit, a track change, a resize,
  // a bars-per-row change.
  api.postRenderFinished.on(() => {
    refreshSelectionRects()
    refreshOverfullRects()
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
    setRangeFromBeats(startBeat, endBeat)
  })



  // ONE handler for beatMouseDown, doing two jobs in a deliberate order.
  //
  // Two separate handlers would have worked by accident: the deselection below
  // is armed synchronously and disarmed by `clearSelection()` inside the bar
  // selection, so it depended on which handler alphaTab happened to call first.
  // Written out here, the order is the code rather than a coincidence.
  //
  // Job 1, DOUBLE CLICK: two presses on the same beat inside DOUBLE_CLICK_MS
  // select the whole measure. The state resets on every non-matching press, so a
  // slow second click starts over rather than pairing with something older.
  //
  // Job 2, THE CURSOR: a click that landed on a beat but not on a note head puts
  // the cursor where it landed - on the empty string of that beat, which is the
  // one thing a selection could never designate. Silent, like the deselection it
  // replaces: clicking a bar is a normal seek, not a mistake.
  //
  // It falls back to dropping WHATEVER was selected, note or range, when the
  // coordinates are missing or resolve to nothing (a keyboard-driven event, a
  // stale lookup). Both are cleared, not just the note: leaving a measure
  // selected after a click elsewhere would mean Alt+arrow still acted on it.
  //
  // How the miss is detected: alphaTab fires `beatMouseDown` and then, in the
  // SAME synchronous handler, `noteMouseDown` if the hit-test found a note head.
  // So the flag set here is still true by the time the microtask runs only when
  // no note was hit. A bar selection disarms it explicitly, because it has just
  // put a range where the microtask would wipe the rings.
  //
  // Limit worth knowing: alphaTab only fires `beatMouseDown` when the click is
  // inside a bar (`if (beat)` guards it), so clicking the page well away from
  // any staff does not reach this and leaves the selection alone.
  api.beatMouseDown.on((beat) => {
    // alphaTab owns its selection from here until the release. See
    // `gestureOnScore`.
    gestureOnScore = true
    const now = Date.now()
    const isDouble = beat && beat === lastBeatDown && now - lastBeatDownAt <= DOUBLE_CLICK_MS
    lastBeatDown = isDouble ? null : beat
    lastBeatDownAt = now

    missedNote = true
    queueMicrotask(() => {
      if (!missedNote) return
      missedNote = false
      if (!placeCursorAtLastClick()) {
        clearSelection()
        clearRange()
      }
      message(null, null)
    })

    if (isDouble && selectBar(beat)) {
      // The bar is now the selection, so the deselection above must not run.
      missedNote = false
    }
  })

  // Closing a score has no alphaTab event, so usePlayer calls this directly.
  // Dropping the selection is what lets the old score graph be collected.
  scoreEditHost.onScoreCleared = () => {
    gestureOnScore = false
    clearSelection()
    clearRange()
    forgetLastClick()
    forgetHistory()
    overfullRects.value = []
    selectedTrackIndex.value = 0
    message(null, null)
  }

  // A new score means a new object graph, so the old Note points into a model
  // that is no longer displayed. This also covers a revert, which reloads the
  // original bytes.
  api.scoreLoaded.on(() => {
    gestureOnScore = false
    clearSelection()
    clearRange()
    forgetLastClick()
    // Rebuilt by the render that follows; cleared here so a failed load cannot
    // leave the previous score's red bars floating over an empty stage.
    overfullRects.value = []
    // A new object graph: every record points at notes that are no longer in the
    // score, and holding them would pin the discarded one in memory.
    forgetHistory()
    selectedTrackIndex.value = 0
    message(null, null)
  })
}

// The double-click state, reset only when the score goes away.
//
// Deliberately NOT part of `clearRange()`: that runs on every click that misses
// a note head, which is exactly what happens between the two presses of a double
// click, so resetting it there stops any double click from ever being seen.
function forgetLastClick() {
  lastBeatDown = null
  lastBeatDownAt = 0
  lastClickPoint = null
}

function clearSelection() {
  selected = null
  selectedNote.value = null
  selectedNoteRects.value = []
  // The cursor goes with it. It is the same notion as the selected note, so
  // leaving one behind would be leaving half a state.
  cursorBeat = null
  cursorString = null
  cursorInfo.value = null
  cursorRects.value = []
  cursorBarRects.value = []
  cursorBarFill.value = null
  missedNote = false
  forgetTypedDigits()
}

// Resolve the last click into a position and put the cursor there.
//
// Returns false when there is nothing to resolve, which is what makes the caller
// fall back to plain deselection rather than leaving a stale cursor behind.
function placeCursorAtLastClick() {
  const point = lastClickPoint
  lastClickPoint = null
  const lookup = scoreEditHost.api?.boundsLookup ?? null
  if (!point || !lookup) return false

  const position = positionAtPoint(lookup, point.x, point.y)
  if (!position?.beat) return false
  return setCursor(position.beat, position.string)
}

// Turn a pair of beats into the current range: the notes in their tick window on
// the track the FIRST beat belongs to.
//
// Shared by the drag subscription and the double click, so the two cannot end up
// meaning different things by "a selected passage".
function setRangeFromBeats(startBeat, endBeat) {
  if (!startBeat || !endBeat) {
    clearRange()
    return false
  }
  const track = startBeat.voice?.bar?.staff?.track ?? null
  if (!track) {
    clearRange()
    return false
  }

  const startTick = startBeat.absolutePlaybackStart
  const endTick = endBeat.absolutePlaybackStart + endBeat.playbackDuration
  rangeNotes = notesInTickRange(track, startTick, endTick)
  if (rangeNotes.length === 0) {
    clearRange()
    return false
  }

  // A range and a single note are two different things to act on, so having both
  // would make Alt+arrow ambiguous. The range wins, since it is the more
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
  return true
}

// Select every note of the bar a beat sits in.
//
// The visual band comes from alphaTab, via `highlightPlaybackRange`, which is
// documented for exactly this - "building custom selection systems". That also
// sets the loop range through `applyPlaybackRangeFromHighlight`, so a
// double-clicked bar looks and loops like a dragged one.
//
// The notes then come from `setRangeFromBeats` directly rather than from the
// event the highlight fires, because of one edge alphaTab cannot express: it
// reports an EMPTY range when the start and end beats are the same, so a bar
// holding a single beat (a whole-bar chord, a full-bar rest) would highlight to
// nothing. Calling the highlight first and setting the range after means that
// empty event lands before the range is built, so it cannot wipe it.
function selectBar(beat) {
  // The beats of the VOICE that was clicked, not `bar.voices[0]`: a bar holds
  // several voices and the highlight should span the one the click landed in.
  // The notes come from the tick window either way, so every voice of the bar is
  // included regardless.
  const beats = beat?.voice?.beats ?? []
  if (beats.length === 0) return false

  const first = beats[0]
  const last = beats[beats.length - 1]

  scoreEditHost.api?.highlightPlaybackRange(first, last)
  scoreEditHost.api?.applyPlaybackRangeFromHighlight()

  return setRangeFromBeats(first, last)
}

// Guards `syncPlayheadToCursor` against itself. Resetting alphaTab's selection
// makes it fire `playbackRangeHighlightChanged`, which lands back in
// `setRangeFromBeats` and calls `clearRange` again - so without this the two
// call each other until the stack runs out.
let droppingRange = false

// True from a mousedown on the score until the release that ends it.
//
// While it is true, alphaTab OWNS its selection: the mousedown has just recorded
// where a drag would start, every mousemove extends it, and the mouseup applies
// it. Touching that state in between is what broke click-and-drag - and our own
// deselect microtask runs exactly in between, on every single press.
//
// Two ways it went wrong, both from one `highlightPlaybackRange` + `apply` pair:
// the start alphaTab recorded was REPLACED by the beat our own hit-test
// resolved (which uses Y where alphaTab's uses X only, so on a multi-track score
// they need not agree), and the `apply` then cleared it outright, which left
// nothing for the drag to draw from.
//
// If a release ever happens somewhere that fires no mouseup - alphaTab listens
// on its own container, so letting go outside it does - this stays true until
// the next complete press and release inside the score. What is lost meanwhile
// is the playhead following the cursor, not correctness.
let gestureOnScore = false

// Drop the selection alphaTab keeps of its OWN, which is not the same object as
// ours and does not go away when ours does.
//
// This is what made a range come back from the dead. `_onPostRenderFinished`
// re-applies alphaTab's highlight after EVERY render:
//
//   if (this._selectionStart) this.highlightPlaybackRange(...)   // 1.8.4
//
// so a cursor move cleared our range, and then the next edit's `api.render()`
// re-fired the highlight event, `setRangeFromBeats` rebuilt the range from it,
// and the cursor was wiped - which looked like the selection re-selecting
// itself a moment after the note moved.
//
// Collapsing the selection onto ONE beat is the public way out, and the pair of
// calls below does it: `highlightPlaybackRange(beat, beat)` makes the selection
// degenerate, which `_cursorSelectRange` draws as nothing, and
// `applyPlaybackRangeFromHighlight` then takes the same-beat branch, which
// clears `_selectionStart` and the playback range outright. The post-render echo
// has nothing left to replay.
//
// That second call also SEEKS, which is the other half of this function's job:
// the playhead follows the cursor, so pressing play starts from where you were
// working rather than from wherever the transport was left. alphaTab guards its
// own cursor repaint on being paused, and passes `shouldScroll: false`, so this
// does not fight our own scroll-into-view.
//
// Only while PAUSED, though. Seeking under a running transport would make
// navigating during playback impossible - every arrow would jump the music.
// While playing, the cursor still moves and alphaTab's selection is still
// dropped; only the seek is skipped.
//
// The playback range going with it also fixes a small bug of its own: a loop
// range that outlives the selection it was made from meant you could drag a
// passage, click away, and still have playback loop the passage.
function syncPlayheadToCursor(beat) {
  const api = scoreEditHost.api
  if (!api || droppingRange || gestureOnScore) return
  droppingRange = true
  try {
    if (!beat) {
      if (api.playbackRange) api.playbackRange = null
      return
    }
    api.highlightPlaybackRange(beat, beat)
    if (!scoreEditHost.isPlaying) {
      api.applyPlaybackRangeFromHighlight()
      // And PUT THE START BACK, which is not a tidy-up: it is the difference
      // between a working drag and a crash.
      //
      // `applyPlaybackRangeFromHighlight` on a degenerate range clears
      // `_selectionStart` and LEAVES `_selectionEnd` set, and alphaTab 1.8.4
      // cannot survive that half-state - it reads the start without checking it:
      //
      //   applyPlaybackRangeFromHighlight() {
      //     if (this._selectionEnd) {
      //       const startTick = ... this._selectionStart.beat ...     // throws
      //
      //   _cursorSelectRange(startBeat, endBeat) {
      //     if (!startBeat || ...) { trigger({}); return }            // no band
      //
      // Left half, the mousedown of the next drag landed in it (our own
      // deselect microtask runs between that mousedown and the first mousemove),
      // so the drag drew nothing at all and its mouseup threw
      // `TypeError: can't access property "beat", this._selectionStart is
      // undefined`.
      //
      // A second same-beat highlight restores the pair. alphaTab draws nothing
      // for it - `_cursorSelectRange` bails on start === end - so it is
      // invisible, and every path that reads the pair afterwards finds it whole:
      // the post-render echo re-collapses it to nothing, and the next mousedown
      // overwrites both halves anyway.
      api.highlightPlaybackRange(beat, beat)
    }
  } finally {
    droppingRange = false
  }
}

function clearRange() {
  const hadRange = rangeNotes.length > 0
  rangeNotes = []
  selectedRange.value = null
  if (hadRange) syncPlayheadToCursor(cursorBeat)
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

  // The wash behind the cursor's own bar. Computed here rather than in its own
  // pass because it is invalidated by exactly the same two things as the rings:
  // the cursor moving, and a render rebuilding every rectangle in the lookup.
  const cursorBar = cursorBeat?.voice?.bar ?? null
  cursorBarRects.value =
    lookup && cursorBar ? barRects(lookup, (bar) => bar === cursorBar) : []

  // The cursor's own rectangle, drawn only where the ring is NOT.
  //
  // On a note the ring already marks the position, and a second marker on the
  // same place would read as two positions. On an empty string there is no ring
  // to draw - there is no note head to measure - so the rectangle is computed
  // from the string spacing instead of read from the lookup.
  cursorRects.value =
    lookup && cursorBeat && !selected ? rectsForCursor(lookup, cursorBeat, cursorString) : []

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

// ---- navigating with the cursor --------------------------------------------

// Navigation is NOT an edit: it writes nothing, so it is not gated on playback
// and never goes near `propagate`. It returns the same result shape anyway, so
// a caller cannot tell the two apart at the call site and a refusal still
// carries its reason.
function moved() {
  cursorMoves.value += 1
  return { ok: true, changed: true, reason: null }
}

function stalled(reason) {
  return { ok: false, changed: false, reason }
}

// Where a bare arrow starts from.
//
// Usually the cursor. With a dragged range and no cursor, it collapses onto the
// range and moves from there: the LAST note going right, the FIRST going left,
// which is the edge the arrow is travelling away from. Up and down have no such
// side, so they take the first note - the beat the drag started on.
function cursorAnchor(delta) {
  if (cursorBeat) return { beat: cursorBeat, string: cursorString }
  if (rangeNotes.length === 0) return null

  // By TICK, not by array order: `notesInTickRange` walks staff by staff, so on
  // a two-staff track its order groups by staff rather than running in time.
  let anchor = rangeNotes[0]
  for (const note of rangeNotes) {
    const tick = note.beat?.absolutePlaybackStart ?? 0
    const best = anchor.beat?.absolutePlaybackStart ?? 0
    if (delta > 0 ? tick > best : tick < best) anchor = note
  }
  return { beat: anchor.beat, string: anchor.isStringed ? anchor.string : null }
}

// The beat before or after this one, crossing bars.
//
// Stays on the same staff and the same voice index, which is what makes the
// walk predictable: a voice is a line someone is reading along, and stepping
// sideways into another one mid-bar would be a different gesture.
//
// Empty bars are walked THROUGH rather than stopped at. A bar with no beats in
// this voice is a hole in the line, not the end of it, and stopping there would
// look like the arrow key had died.
function neighbourBeat(beat, delta) {
  const voice = beat?.voice ?? null
  const bar = voice?.bar ?? null
  const staff = bar?.staff ?? null
  if (!voice || !staff) return null

  const within = voice.beats?.[beat.index + delta] ?? null
  if (within) return within

  for (let index = bar.index + delta; index >= 0 && index < staff.bars.length; index += delta) {
    const nextBar = staff.bars[index]
    const nextVoice = nextBar.voices?.[voice.index] ?? nextBar.voices?.[0] ?? null
    const beats = nextVoice?.beats ?? []
    if (beats.length === 0) continue
    return delta > 0 ? beats[0] : beats[beats.length - 1]
  }
  return null
}

// Left and right: the previous or next beat, keeping the string.
//
// Running off either end is left SILENT, like running out of frets or strings:
// it is the natural end of a repeatable key, and a message per press would be
// noise.
//
// Pure navigation, and it stays that way: it writes nothing, so it is not gated
// on playback and never goes near `propagate`. Adding a bar past the end IS a
// write, so it is layered on top of this by the composable - see `moveCursorBeat`
// there - rather than folded in here.
function navigateBeat(delta) {
  const anchor = cursorAnchor(delta)
  if (!anchor) return stalled('Click a note or a bar in the score first.')

  const next = neighbourBeat(anchor.beat, delta)
  if (!next) return stalled(delta > 0 ? 'End of the score.' : 'Start of the score.')

  setCursor(next, anchor.string)
  return moved()
}

// Whether a beat is the last one of its bar AND that bar is not exactly full,
// which is where the right arrow makes room instead of moving on.
//
// "Not exactly full" is the whole test - "is this bar exactly right", not "does
// it have room" - so an overfull bar counts too. The beat itself must not be
// alphaTab's placeholder: an untouched voice has nothing to insert after, and
// `Enter` turns that placeholder into a rest in place.
//
// The bar is judged by the reading the counter and the red outline already show,
// so the three cannot disagree. On a multi-voice bar that reading is its FULLEST
// voice, so walking a short voice of an otherwise full bar moves on rather than
// inserting.
function needsRoomAfter(beat) {
  const voice = beat?.voice ?? null
  if (!voice || beat.isEmpty) return false
  if (beat.index !== voice.beats.length - 1) return false
  return barFill(voice.bar)?.state !== BAR_EXACT
}

// Whether a beat is the very last one of the whole score, which is the only
// place the right arrow is allowed to write.
//
// Both halves are checked rather than trusting `navigateBeat` having failed:
// that only proves there is no later beat on THIS staff, and a staff with fewer
// bars than the score would then grow the score from the wrong end.
function isLastBeatOfScore(beat) {
  const voice = beat?.voice ?? null
  const bar = voice?.bar ?? null
  const staff = bar?.staff ?? null
  const score = staff?.track?.score ?? null
  if (!voice || !bar || !staff || !score) return false
  if (beat.index !== voice.beats.length - 1) return false
  if (bar.index !== staff.bars.length - 1) return false
  return bar.masterBar?.index === score.masterBars.length - 1
}

// Up and down: the next string of the same beat.
//
// Up means the higher-pitched string, which is also the higher line on the
// tablature, so the cursor moves the way the key points - the same convention
// Alt+arrow already uses for moving a note.
//
// From a position with no string yet, the first press enters the fretboard from
// the far edge in the direction of travel: up starts at the lowest string, down
// at the highest, so the next press continues the same way instead of doubling
// back.
//
// That is a narrower case than it used to be. A click is now projected onto the
// tablature row whatever notation it landed on, so the only positions left
// without a string are on staves that have NO tablature - and of those, only a
// stringed staff with its tab hidden gets here at all, since a percussion staff
// has no strings to move between and is refused above.
function moveCursorString(delta) {
  const anchor = cursorAnchor(delta)
  if (!anchor) return stalled('Click a note or a bar in the score first.')

  const strings = anchor.beat?.voice?.bar?.staff?.tuning?.length ?? 0
  if (strings === 0) return stalled('This staff has no strings to move between.')

  const target = anchor.string == null ? (delta > 0 ? 1 : strings) : anchor.string + delta
  if (target < 1 || target > strings) return stalled(`There is no string ${target}.`)

  setCursor(anchor.beat, target)
  return moved()
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

  // "Something in the score is designated", which is what four keys stand down
  // on: the bare arrows, the two duration keys and the two bar keys. One
  // computed behind three names, because each name answers a different question
  // and the day one of them stops accepting a dragged passage they part company.
  const hasTarget = computed(
    () => cursorInfo.value !== null || selectedRange.value !== null,
  )

  const canUndo = computed(() => canEdit.value && undoDepth.value > 0)
  const canRedo = computed(() => canEdit.value && redoDepth.value > 0)

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
    return propagate(result, { render: true, label: 'Rename track' })
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
    const before = editedTrack.value?.program ?? null
    player.setTrackProgram(index, program)
    message(null, null)
    // usePlayer owns the write (it needs the automation rewrite from
    // trackSound.js), so the undo goes back through it rather than touching the
    // model here.
    remember('Change instrument', {
      changed: true,
      undo: () => player.setTrackProgram(index, before),
    })
    scoreEditHost.markDirty()
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
    return propagate(result, { render: true, midi: 'now', label: 'Tempo' })
  }

  // Both transposition modes change the notation and the pitches.
  function transposeByTuning(semitones) {
    if (!canEdit.value) return refusePlayback()
    const index = editedTrack.value?.index
    const result = transposeTrackByTuning(scoreEditHost.trackAt(index ?? -1), semitones)
    if (result.changed) scoreEditHost.syncTrack(index)
    return propagate(result, { render: true, midi: 'onPlay', label: 'Detune track' })
  }

  function transposeByFrets(semitones) {
    if (!canEdit.value) return refusePlayback()
    const index = editedTrack.value?.index
    const result = transposeTrackByFrets(scoreEditHost.trackAt(index ?? -1), semitones)
    if (result.changed) {
      scoreEditHost.syncTrack(index)
      refreshSelection()
    }
    return propagate(result, { render: true, midi: 'onPlay', label: 'Transpose frets' })
  }

  function retune(tunings, mode) {
    if (!canEdit.value) return refusePlayback()
    const index = editedTrack.value?.index
    const result = retuneTrack(scoreEditHost.trackAt(index ?? -1), tunings, mode)
    if (result.changed) {
      scoreEditHost.syncTrack(index)
      refreshSelection()
    }
    return propagate(result, { render: true, midi: 'onPlay', label: 'Retune track' })
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
      refreshSelection()
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
      label: 'Change pitch',
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
  // A plain action with no confirmation: asking every time would make it useless
  // for one note, and a threshold on the count would be arbitrary. `undo` takes
  // it back, and `isDirty` warns before the score is replaced or closed.
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

    // Where the cursor was, so a single-note delete can stay there. Silencing a
    // note does not remove its beat - `Beat.isRest` is a getter over
    // `notes.length` - so the position outlives the note and is exactly where
    // someone would want to be next.
    const wasAt = selected && cursorBeat ? { beat: cursorBeat, string: cursorString } : null

    const result = deleteNotes(notes, scoreEditHost.api?.settings)
    if (result.changed) {
      clearSelection()
      clearRange()
      // A range delete has nowhere to go back to; a single note does.
      if (wasAt) setCursor(wasAt.beat, wasAt.string)
      if (typeof trackIndex === 'number') scoreEditHost.syncTrack(trackIndex)
    }
    // `deleteNotes` already ran finish(), which recomputes the tick grid - but it
    // recomputes it to the same values, since removing a note does not change any
    // duration. So the midi can still wait for the next play.
    return propagate(result, {
      render: true,
      midi: 'onPlay',
      firstChangedBar: bar,
      label: result.noteCount === 1 ? 'Silence note' : `Silence ${result.noteCount} notes`,
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
      refreshSelection()
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
      label: 'Move to another string',
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
      label: 'Move selection to another string',
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
      label: 'Transpose selection',
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

  // Alt + PageUp / PageDown: a whole octave, re-fingered.
  //
  // Not a fret shift. Measured on two real files, going DOWN an octave is
  // physically impossible for 22 % of the notes of one and 85 % of the other -
  // the instrument does not reach that low - so an octave has to aim at a pitch
  // and look for a string and fret that can hold it. See `shiftNotesOctave`.
  //
  // On a range this is the one operation that is best effort rather than all or
  // nothing, and the message afterwards is the only place that shows it. It is
  // posted AFTER `propagate`, which clears the message on a success: nothing in
  // the result contract changes, an existing channel is simply used by a caller,
  // which any caller can already do.
  function shiftSelectedOctave(direction) {
    if (!canEdit.value) return refusePlayback()

    const isRange = rangeNotes.length > 0
    const notes = isRange ? rangeNotes : selected ? [selected] : []
    if (notes.length === 0) return { ok: false, changed: false, reason: 'No note selected.' }

    const trackIndex = isRange
      ? (selectedRange.value?.trackIndex ?? null)
      : (selectedNote.value?.trackIndex ?? null)
    const bar = isRange
      ? (selectedRange.value?.startBar ?? null)
      : (selectedNote.value?.barIndex ?? null)

    const result = shiftNotesOctave(notes, direction)
    if (result.changed) {
      if (typeof trackIndex === 'number') scoreEditHost.syncTrack(trackIndex)
      refreshSelection()
      refreshSelectionRects()
      // An octave changes the pitch, so it sounds - unlike the string move,
      // which keeps it. One note, or the chord a range starts on: sounding forty
      // notes at once would be noise.
      if (isRange) scoreEditHost.previewBeat(notes[0]?.beat)
      else scoreEditHost.previewNote(selected)
    }

    const outcome = propagate(result, {
      render: true,
      midi: 'onPlay',
      firstChangedBar: bar,
      label: direction > 0 ? 'Up an octave' : 'Down an octave',
    })

    if (outcome.ok && outcome.blockedCount) {
      const n = outcome.blockedCount
      message('info', `${n} ${n === 1 ? 'note was' : 'notes were'} already as ${direction > 0 ? 'high' : 'low'} as this tuning goes, and stayed put.`)
    }
    return outcome
  }

  // ---- writing -------------------------------------------------------------
  //
  // Everything below this line CREATES or DESTROYS structure, or moves a tick.
  // Three consequences that the tiers above never had to deal with, and that are
  // the whole cost of this one:
  //
  //   `finish()` runs on the typing path. Measured end to end on the real files
  //   rather than guessed: 0.9-3.4ms a keystroke at 77 and 118 bars, with an
  //   occasional first call up to 9.7ms. The plan budgeted 16ms and called this
  //   the main risk; 16ms is the COLD first finish on a freshly imported score,
  //   and it settles to under 2ms after that. What keeps it small is that none
  //   of these keys repeats - a held one would re-derive the whole score at the
  //   keyboard's repeat rate.
  //
  //   The bar fill has to be re-read by hand. It is derived from
  //   `playbackDuration`, which is derived from `duration` (pitfall 7), so a
  //   duration edit moves it and a `setCursor` does not necessarily follow.
  //
  //   A bar can now be overfull for real. The red outline stopped being a
  //   diagnostic on other people's files the moment these landed, which is
  //   exactly why it was built first.

  // Type a fret at the cursor: the keyboard's digits.
  //
  // The multi-digit rule is "replace, never wait": the first digit is written at
  // once and a second one inside MULTI_DIGIT_MS replaces it with the two-digit
  // number, when that number is a fret this neck has. So `1` `2` gives fret 12
  // and `3` `5` gives fret 3 then fret 5, because 35 is off the end of any neck.
  //
  // It leaves TWO undo records for one two-digit fret - the note as it was first
  // written, then the correction - which is honest rather than tidy: both states
  // really existed in the model, and coalescing them would mean a record whose
  // "before" was never on screen.
  function typeFret(digit) {
    if (!canEdit.value) return refusePlayback()

    const value = Math.round(Number(digit))
    if (!Number.isFinite(value) || value < 0 || value > 9) return refused('Type a digit 0-9.')
    if (!cursorBeat) return refused('Click a note or a bar in the score first.')

    // Still typing the same number, on the same note, inside the window - and
    // the result has to be a fret that exists. `lastDigitFret > 0` keeps "0"
    // from being a leading zero.
    const combined = lastDigitFret * 10 + value
    const continues =
      lastDigitNote !== null &&
      lastDigitFret > 0 &&
      combined <= MAX_FRET &&
      Date.now() - lastDigitAt <= MULTI_DIGIT_MS &&
      cursorString != null &&
      cursorBeat.getNoteOnString(cursorString) === lastDigitNote

    const fret = continues ? combined : value
    const bar = cursorInfo.value?.barIndex ?? null
    const trackIndex = cursorInfo.value?.trackIndex ?? null

    const result = writeNoteAtString(cursorBeat, cursorString, fret, scoreEditHost.api?.settings)
    if (result.changed) {
      // Through `setCursor` rather than `refreshSelection`, because the note may
      // not have existed a moment ago: this is what puts the ring on it, points
      // the panel at it and re-reads the bar fill, which moved if the note was
      // the first thing written into an untouched bar.
      setCursor(cursorBeat, cursorString, result.note)
      if (typeof trackIndex === 'number') scoreEditHost.syncTrack(trackIndex)
      // Sound it, straight from the model. Same reason as the fret nudge: this
      // is why the midi rebuild is deferred, since doing it now would call
      // stop() and cut the preview off.
      scoreEditHost.previewNote(result.note)
    }

    // Armed on `ok` and not on `changed`, which is not a detail: typing "12" on
    // a note that already reads 1 makes the first press a no-op, and only the
    // second one changes anything. Armed on `changed` that press would find no
    // number in progress and write fret 2. Set AFTER `setCursor`, which clears
    // it.
    if (result.ok) {
      lastDigitNote = result.note ?? null
      lastDigitAt = Date.now()
      lastDigitFret = fret
    }

    return propagate(result, {
      render: true,
      midi: 'onPlay',
      firstChangedBar: bar,
      label: result.created ? 'Write a note' : 'Change pitch',
    })
  }

  // `+` and `-`: one step along the duration ladder.
  //
  // `+` SHORTENS and `-` lengthens, following the number that is written: a
  // quarter is a 4 and an eighth an 8, so "more" is a shorter note. The panel
  // says "Shorter" and "Longer" in words, because the keys alone cannot.
  //
  // THE DURATION BELONGS TO THE BEAT. Changing "this note's length" changes the
  // whole chord it is in, which is the musical model and not a limitation - see
  // `stepBeatsDuration`.
  //
  // On a dragged passage every beat moves, all or nothing. Worth knowing what
  // that does NOT cover: a range is a set of NOTES, so a rest sitting inside the
  // passage belongs to no note and keeps its own length.
  //
  // `now` rather than `onPlay`: it changes TIMING, and the loaded midi is what
  // maps a scrub position to a tick, so a stale one would make the transport
  // disagree with the score. Until this tier the tempo was the only edit that
  // did; now an inserted rest and an added bar do too.
  function changeDuration(direction) {
    if (!canEdit.value) return refusePlayback()

    const target = durationTarget()
    if (!target) return refused('Click a note or a bar in the score first.')

    const result = stepBeatsDuration(target.beats, direction, scoreEditHost.api?.settings)
    if (result.changed) {
      if (typeof target.trackIndex === 'number') scoreEditHost.syncTrack(target.trackIndex)
      refreshSelection()
      refreshSelectionRects()
      // By hand, because no cursor move happened: the ticks under the cursor
      // changed while the position did not.
      refreshBarFill()
    }
    return propagate(result, {
      render: true,
      midi: 'now',
      firstChangedBar: target.bar,
      label: direction === DURATION_SHORTER ? 'Shorten' : 'Lengthen',
    })
  }

  // What the length keys act on: every beat of a dragged passage, or the one the
  // cursor is on.
  //
  // Shared by `+`, `-` and the dot, so the three cannot drift apart about what
  // "this note's length" means. Null when nothing is designated.
  function durationTarget() {
    const isRange = rangeNotes.length > 0
    const beats = isRange
      ? [...new Set(rangeNotes.map((note) => note.beat))]
      : cursorBeat
        ? [cursorBeat]
        : []
    if (beats.length === 0) return null
    return {
      beats,
      trackIndex: isRange
        ? (selectedRange.value?.trackIndex ?? null)
        : (cursorInfo.value?.trackIndex ?? null),
      bar: isRange
        ? (selectedRange.value?.startBar ?? null)
        : (cursorInfo.value?.barIndex ?? null),
    }
  }

  // The dot key, which is the other half of a duration.
  //
  // Same scope as `+` and `-` in every way - the beat under the cursor, or every
  // beat of a dragged passage - because a dot IS part of how long the beat
  // lasts. Shares the target logic with them for that reason: two keys that
  // disagreed about what they act on would be the worst of both.
  function toggleDot() {
    if (!canEdit.value) return refusePlayback()
    const target = durationTarget()
    if (!target) return refused('Click a note or a bar in the score first.')

    const result = toggleBeatsDot(target.beats, scoreEditHost.api?.settings)
    if (result.changed) {
      if (typeof target.trackIndex === 'number') scoreEditHost.syncTrack(target.trackIndex)
      refreshSelection()
      refreshSelectionRects()
      refreshBarFill()
    }
    return propagate(result, {
      render: true,
      midi: 'now',
      firstChangedBar: target.bar,
      label: result.dots ? 'Dot' : 'Undot',
    })
  }

  // Enter: a rest where nothing has been written yet, and a step along the bar
  // where something has.
  //
  // One rule, read off the position rather than off the key: Enter goes to the
  // next beat, and WRITES that beat when it does not exist yet. Which gives four
  // cases, in this order:
  //
  //   1. The cursor is on alphaTab's placeholder - a bar nobody has touched.
  //      Nothing exists here yet either, so the rest is placed IN PLACE and the
  //      cursor stays on it.
  //   2. There is another beat in this bar. Pure navigation, nothing written.
  //   3. This is the last beat of the bar and the bar is not exactly full. The
  //      beat after it does not exist, so it is inserted - the same step the
  //      right arrow makes, so the two keys agree wherever they overlap.
  //   4. The bar is exactly full. Enter moves on to the next bar, and stops at
  //      the end of the score: adding a bar is the right arrow's job.
  function insertRest() {
    if (!canEdit.value) return refusePlayback()
    if (!cursorBeat) return refused('Click a note or a bar in the score first.')

    if (!cursorBeat.isEmpty && !needsRoomAfter(cursorBeat)) return navigateBeat(1)
    return writeRestAt(cursorBeat, cursorString)
  }

  // The write itself, shared by Enter and by the right arrow.
  //
  // Both mean "there should be a beat here and there is not", so both do the
  // same thing and carry the same undo label - which is what keeps the undo
  // control readable when a passage was written with a mixture of the two.
  // What differs is WHEN each one decides that, and those two decisions are in
  // their own callers.
  //
  // The bar and the track come off the beat rather than off `cursorInfo`,
  // because the right arrow's position can come from a dragged range, which has
  // no cursor for the descriptor to describe.
  function writeRestAt(beat, string) {
    const bar = beat?.voice?.bar?.masterBar?.index ?? null
    const trackIndex = beat?.voice?.bar?.staff?.track?.index ?? null

    const result = placeRest(beat, scoreEditHost.api?.settings)
    // `placeRest` lands the rest on the anchor when the anchor is a placeholder
    // and after it otherwise, and `result.beat` is whichever it turned out to
    // be - so the cursor follows the write rather than guessing.
    //
    if (result.changed) {
      // Onto the rest itself: afterwards the cursor is always standing on a
      // fresh silence, ready for a fret to be typed into it.
      setCursor(result.beat, string)
      cursorMoves.value += 1
      if (typeof trackIndex === 'number') scoreEditHost.syncTrack(trackIndex)
    }
    return propagate(result, {
      render: true,
      // An inserted beat moves every tick after it, so this is a timing change
      // for the same reason a duration is.
      midi: 'now',
      firstChangedBar: bar,
      label: result.inserted ? 'Insert a rest' : 'Add a rest',
    })
  }

  // One more bar, at the very end of the score.
  //
  // Reached only from the right arrow, and only past the last beat of the last
  // bar - so no bar can ever be inserted into the MIDDLE of a piece, which is
  // the guard that matters here. Under the same undo stack as every other write.
  function addBarAtEnd(anchor) {
    const result = appendBar(scoreEditHost.score, scoreEditHost.api?.settings)
    if (result.changed) {
      // The bar count in the document strip.
      scoreEditHost.syncScoreInfo()
      // Onto the first beat of the new bar, on the staff and voice the cursor
      // was already walking, so the arrow key carries on where it was going.
      const staff = anchor.beat?.voice?.bar?.staff ?? null
      const added = staff?.bars?.[staff.bars.length - 1] ?? null
      const voice = added?.voices?.[anchor.beat.voice.index] ?? added?.voices?.[0] ?? null
      const beat = voice?.beats?.[0] ?? null
      if (beat) {
        setCursor(beat, anchor.string)
        cursorMoves.value += 1
      }
    }
    return propagate(result, {
      // A full render: a new bar re-flows the system it lands on, and there is
      // no earlier bar to keep.
      render: true,
      // The score is longer, so the transport's own end moves.
      midi: 'now',
      label: 'Add a bar',
    })
  }

  // Which bars `Ctrl+Insert` and `Ctrl+Delete` act on.
  //
  // A dragged passage first, since it is the more deliberate gesture and the
  // only way to name more than one bar; otherwise the cursor's own bar. Both
  // report MASTER bar indexes, which is what the bar operations take.
  function targetBars() {
    const range = selectedRange.value
    if (range) return { from: range.startBar, to: range.endBar }
    const at = cursorInfo.value?.barIndex
    return typeof at === 'number' ? { from: at, to: at } : null
  }

  // Put the cursor on the first beat of a bar by INDEX, after the bars around it
  // have moved.
  //
  // By index rather than by object, because that is the whole point: after an
  // insertion the bar at this index is the new one, and after a deletion it is
  // whatever moved up into the hole. Clamped, so deleting the last bars of a
  // score lands on the new last one rather than nowhere.
  function landOnBar(staff, index, voiceIndex, string) {
    const bars = staff?.bars ?? []
    const bar = bars[Math.min(index, bars.length - 1)] ?? null
    const voice = bar?.voices?.[voiceIndex] ?? bar?.voices?.[0] ?? null
    const beat = voice?.beats?.[0] ?? null
    if (!beat) {
      clearSelection()
      clearRange()
      return
    }
    setCursor(beat, string)
    cursorMoves.value += 1
  }

  // Where the cursor is standing, in terms that survive the bars around it being
  // spliced: the staff and voice objects rather than their indexes, and the
  // string. Read before the write, used after it.
  function cursorLane() {
    const anchor = cursorAnchor(1)
    return {
      staff: anchor?.beat?.voice?.bar?.staff ?? null,
      voiceIndex: anchor?.beat?.voice?.index ?? 0,
      string: anchor?.string ?? null,
    }
  }

  // Ctrl+Insert: one more bar, before this one.
  //
  // The counterpart to the right arrow's bar, which can only ever land at the
  // END of the score - and that limit is why this exists. Everything after the
  // insertion point moves along, which needs the renumbering pass alphaTab does
  // not do for us and the tempo move when the new bar becomes the first one. See
  // `insertBarBefore`.
  //
  // The cursor follows onto the new bar rather than staying with the music it
  // displaced: asking for a bar here is asking for somewhere to write.
  function insertBar() {
    if (!canEdit.value) return refusePlayback()
    const target = targetBars()
    if (!target) return refused('Click a note or a bar in the score first.')

    const lane = cursorLane()
    const result = insertBarBefore(scoreEditHost.score, target.from, scoreEditHost.api?.settings)
    if (result.changed) {
      // The bar count in the document strip, and the tempo with it: inserting
      // before the first bar moves the automations that `score.tempo` reads.
      scoreEditHost.syncScoreInfo()
      landOnBar(lane.staff, target.from, lane.voiceIndex, lane.string)
    }
    return propagate(result, {
      // A full render, and no `firstChangedMasterBar`: every bar after the
      // insertion point has moved, so there is no prefix worth keeping and the
      // systems re-flow from there anyway.
      render: true,
      // Every tick after the insertion point moved, and the score is longer.
      midi: 'now',
      label: 'Insert a bar',
    })
  }

  // Ctrl+Delete: this bar, or every bar of a dragged passage.
  //
  // The most destructive key here, and deliberately without a confirmation - the
  // same call the note delete made, for the same reasons: a prompt every time
  // would make it useless, a threshold on the count would be arbitrary, `Ctrl+Z`
  // takes it back in one step, and `isDirty` warns before the score is replaced
  // or closed. The score visibly shrinks, which is the feedback.
  //
  // `syncAllTracks` here and not on the insert: the panel's fret range and
  // natural-harmonic count are read off the notes, and this is the operation
  // that removes some.
  function removeBars() {
    if (!canEdit.value) return refusePlayback()
    const target = targetBars()
    if (!target) return refused('Click a note or a bar in the score first.')

    const lane = cursorLane()
    const result = deleteBars(
      scoreEditHost.score,
      target.from,
      target.to,
      scoreEditHost.api?.settings,
    )
    if (result.changed) {
      // Whatever was selected is gone with the bar, so neither the rings nor the
      // cursor can point at it any more.
      clearSelection()
      clearRange()
      scoreEditHost.syncScoreInfo()
      scoreEditHost.syncAllTracks()
      landOnBar(lane.staff, target.from, lane.voiceIndex, lane.string)
    }
    return propagate(result, {
      render: true,
      midi: 'now',
      label: result.barCount === 1 ? 'Delete a bar' : `Delete ${result.barCount} bars`,
    })
  }

  // The left and right arrows, whole job included.
  //
  // The LEFT arrow only ever walks. The right arrow walks too, until it reaches
  // the last beat of its bar - and there it makes room, which is what turns it
  // into the key a passage is written with:
  //
  //   | the bar the cursor is in | the right arrow |
  //   | exactly full            | goes to the next bar, adding one past the end |
  //   | anything else           | inserts a rest after the cursor |
  //
  // "Anything else" is both incomplete AND overfull, deliberately: the test is
  // "is this bar exactly right", not "does it have room". A bar nobody has
  // written into reads as exactly full - every voice of it is empty, which is an
  // implicit whole-bar rest - so the arrow leaves it alone and moves on, which
  // is what makes "add a bar, then another" possible without writing anything
  // into either.
  //
  // Two things make this acceptable on a key that also navigates:
  //
  //   `canWrite` is false for an auto-REPEAT, so a held arrow only walks - it
  //   crosses an incomplete bar instead of filling it with rests at the
  //   keyboard's repeat rate.
  //
  //   While PLAYING it only walks, too. Refusing with "pause playback to edit"
  //   on every incomplete bar would make the arrow useless during playback,
  //   which is the one thing the bare arrows have always been good for.
  function moveCursorBeat(delta, { canWrite = false } = {}) {
    if (delta <= 0 || !canWrite || !canEdit.value) return navigateBeat(delta)

    const anchor = cursorAnchor(delta)
    if (!anchor) return navigateBeat(delta)

    if (needsRoomAfter(anchor.beat)) return writeRestAt(anchor.beat, anchor.string)

    const result = navigateBeat(delta)
    if (result.ok || !isLastBeatOfScore(anchor.beat)) return result
    return addBarAtEnd(anchor)
  }

  // Re-read the selected note after an edit that may have moved it, and bring
  // the cursor with it.
  //
  // The cursor has to follow, not just the descriptor: `Alt` + up moves the note
  // to another string, and a cursor still pointing at the old one would make the
  // next bare arrow start from a place the note has left. They are one notion,
  // so they move together.
  function refreshSelection() {
    if (!selected) return
    selectedNote.value = describeNote(selected)
    if (cursorBeat !== selected.beat) return
    cursorString = selected.isStringed ? selected.string : null
    cursorInfo.value = describeCursor(cursorBeat, cursorString)
  }

  // ---- undo ---------------------------------------------------------------

  // Take back the most recent edit.
  //
  // Gated by playback like every other edit, since it writes the model just as
  // much as the edit it reverses. And it clears the selection: an undone delete
  // brings notes back, an undone string move puts them elsewhere, so whatever
  // was selected may no longer be what the rings are drawn on.
  //
  // The dirty flag follows the stack: once every edit has been undone the score
  // really is back to how it was loaded - unless the bound dropped a record, in
  // which case older edits are still applied and `isClean` says false.
  // Undo and redo do the same work: they call one record's swap and then bring
  // the whole app back in line with a model that changed underneath it. Only the
  // stack and the wording differ, so they share this.
  //
  // The selection goes either way: an undone delete brings notes back, a redone
  // string move puts them elsewhere, so whatever was selected may no longer be
  // what the rings are drawn on.
  function applyHistoryStep(step, verb) {
    if (!canEdit.value) return refusePlayback()

    const label = step()
    if (label === null) return null
    syncHistory()

    clearSelection()
    clearRange()
    scoreEditHost.syncAllTracks()
    scoreEditHost.syncScoreInfo()
    // The dirty flag follows the UNDO stack: empty means every edit has been
    // taken back, so a redo pushing one on makes it dirty again.
    if (history.isClean) scoreEditHost.clearDirty()
    else scoreEditHost.markDirty()

    scoreEditHost.api?.render({ reuseViewport: true })
    scoreEditHost.markMidiStale()

    message('ok', `${verb}: ${label}.`)
    return { ok: true, changed: true, reason: null, label }
  }

  function undo() {
    if (canEdit.value && history.size === 0) {
      // Said out loud rather than failing silently. A key that does nothing and
      // explains nothing is indistinguishable from a key that never arrived.
      const reason = history.hasDropped
        ? 'Nothing left to undo: the last 30 edits have been taken back. Use Revert in the Score tab to get the file back.'
        : 'Nothing to undo.'
      message('info', reason)
      return { ok: false, changed: false, reason }
    }
    return (
      applyHistoryStep(() => history.undo(), 'Undone') ?? {
        ok: false,
        changed: false,
        reason: 'Nothing to undo.',
      }
    )
  }

  // Re-apply what was just undone. The record's swap runs a second time, which is
  // why there is no separate redo closure anywhere in scoreEdits.js.
  function redo() {
    if (canEdit.value && history.redoSize === 0) {
      const reason = 'Nothing to redo.'
      message('info', reason)
      return { ok: false, changed: false, reason }
    }
    return (
      applyHistoryStep(() => history.redo(), 'Redone') ?? {
        ok: false,
        changed: false,
        reason: 'Nothing to redo.',
      }
    )
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

    // the cursor: a position, which may or may not hold a note
    cursor: cursorInfo,
    cursorRects,
    cursorBarRects,
    cursorMoves,
    moveCursorBeat,
    moveCursorString,
    // Whether a bare arrow key has anywhere to navigate FROM. Read by the
    // shortcut table rather than by a component, because `appliesTo` has to
    // answer before `preventDefault()` runs: deciding inside `run` would be too
    // late and the page would have stopped scrolling either way.
    canNavigate: hasTarget,

    // writing
    typeFret,
    changeDuration,
    toggleDot,
    insertRest,
    insertBar,
    removeBars,
    // What the writing keys stand down on, and there are two conditions rather
    // than one. A digit and a rest need a POSITION to write at, which only a
    // cursor is; a duration and a whole bar are named by a dragged passage just
    // as well, with no cursor on any of it.
    //
    // Read from `appliesTo` for the reason `canNavigate` is: bare digits are
    // characters, and a key that is not going to be used has to be left alone
    // BEFORE `preventDefault()`, not after.
    canWriteNote: computed(() => cursorInfo.value !== null),
    canChangeDuration: hasTarget,
    canEditBars: hasTarget,
    DURATION_SHORTER,
    DURATION_LONGER,

    // bar filling
    cursorBarFill,
    overfullRects,

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
    shiftSelectedOctave,
    deleteSelection,

    // undo / redo
    undo,
    canUndo,
    undoLabel,
    undoDepth,
    redo,
    canRedo,
    redoLabel,
    redoDepth,

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
