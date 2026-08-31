# Editing internals

How the editing features are built: how a note gets selected, how an
edit reaches the screen and the speakers, and how it gets taken back.

## Note selection needs `core.includeNoteBounds`, which defaults to false

`api.noteMouseDown` is gated on it:

```js
if (this.settings.core.includeNoteBounds) {
  const note = boundsLookup?.getNoteAtPos(beat, relX, relY)
  if (note) this._onNoteMouseDown(e, note)
}
```

With it off, the renderer builds **no** note bounding boxes at all - measured
headlessly on the same score: 0 boxes off, 984 boxes on - so the hit-test has
nothing to find and the event never fires. `enableUserInteraction` is a different
setting entirely: it governs click-to-seek and drag-to-select-a-range. Conflating
the two costs you a feature that looks like a broken keyboard shortcut, with no
error anywhere.

The settings live in an exported `playerSettings()` rather than inline in
`init()`, so a test can assert this without needing an `AlphaTabApi` and a DOM.

Two consequences of how the hit-test works:

- It is a **strict rectangle** over `note.noteHeadBounds`, with no tolerance
  (11x9 to 22x14 CSS px on a default render). Clicking a hair off a fret digit
  selects nothing, so a click that lands on a bar but on no note head
  **deselects**, silently: clicking a bar is a normal seek rather than a mistake,
  and the ring vanishing is the feedback. The miss is detected by watching
  whether `noteMouseDown` follows `beatMouseDown` in the same synchronous
  handler. alphaTab only fires `beatMouseDown` when the click is inside a bar, so
  clicking the page well away from any staff leaves the selection alone.
- alphaTab calls `preventDefault()` on its mousedown, which **suppresses the
  focus change**. Clicking a note does not move focus out of whatever field the
  user last typed in, which is why the arrow bindings stand down only for
  `<select>` (it owns Alt+Down) and not for text fields. No text field owns
  Alt+Up/Down anyway: word-wise caret movement is Alt+Left/Right.

## Selecting a passage costs no new interaction code

alphaTab already builds and draws a click-and-drag selection for its loop range.
`playbackRangeHighlightChanged` hands it over as it happens, with `startBeat` and
`endBeat` as real `Beat` objects, so the range needs no mouse handling at all.

Three details make it usable:

- A plain click fires the event with **empty args**. `_cursorSelectRange`
  triggers `{}` when the start and end beats are the same, which is exactly what
  distinguishes a click from a drag.
- alphaTab **normalises the order** itself, so `startBeat` is always the earlier
  one and a right-to-left drag needs no special case.
- The range is turned into a **tick window** on the track the drag or double
  click STARTED on,
  using `beat.absolutePlaybackStart`. That field is model-absolute, so it ignores
  repeats and is comparable across staves and voices, which the per-voice
  `beat.index` is not. A drag that wanders onto another staff still edits the
  track it began on, which keeps every operation single-track like the
  transposition and the retuning.

The rule for what is in the range is "beats that **start** inside it", not "beats
that overlap it": a user can predict the first, while the second would silently
pull in a note they never dragged over.

One trap in the batch write. Moving a chord up one string means the note leaving
string 4 and the note arriving on string 4 are both in the batch, so writing them
one at a time lets the departing note's `delete` erase the arriving note's entry
in `Beat.noteStringLookup` (pitfall 5), or the reverse, depending on order.
`applyNoteStringMoves()` therefore drops **every** mover from its lookup first
and only then writes, which makes the result independent of order.

## Double click a bar: detected from alphaTab, not from the DOM

There is no `dblclick` in alphaTab's event set, and using the DOM one would mean
hit-testing the coordinates against `boundsLookup` all over again. `beatMouseDown`
has already done that work and hands over the `Beat`, so the detector is two
presses on the **same** beat inside 400ms. Requiring the same beat is what keeps
two quick clicks on different beats meaning two clicks, which is what someone
moving the playhead twice means. What is given up is the OS double-click
interval, replaced by a fixed one.

The band then comes from alphaTab itself:
`highlightPlaybackRange(first, last)` - documented for exactly this, "building
custom selection systems" - followed by `applyPlaybackRangeFromHighlight()`, so a
double-clicked bar looks and loops like a dragged one.

The notes are set directly rather than taken from the event that highlight fires,
because of one edge alphaTab cannot express: `_cursorSelectRange` reports an
**empty** range when the start and end beats are the same, so a bar holding a
single beat (a whole-bar chord, a full-bar rest) would highlight to nothing.
Calling the highlight first and setting the range after means that empty event
lands *before* the range is built and cannot wipe it.

Both jobs on `beatMouseDown` - the double click and the click-off-a-note
deselection - live in **one** handler. Two handlers would have worked by
accident: the deselection is armed synchronously and disarmed by the bar
selection, so it depended on which one alphaTab happened to call first. In one
handler the order is the code rather than a coincidence.

## Two selection visuals, two jobs

The drag leaves alphaTab's translucent band over the passage AND the ring on each
selected note. That is deliberate, not a leftover: they mean different things, and
neither can do the other's job.

**The band is the time span, and the loop range.** On mouseUp alphaTab calls
`applyPlaybackRangeFromHighlight()`, so a drag also sets `api.playbackRange`.
Suppressing it (`clearPlaybackRangeHighlight()` exists) would break
select-then-loop.

**The band is wrong as edit feedback, in two ways.** It spans the full bar height
across every displayed staff, while a batch edit touches exactly one track - the
one the drag started on - so it says "all tracks" about a single-track operation.
And it cannot express the range rule: a beat straddling the edge of the band looks
included when "beats that START inside" excludes it.

So the ring is the edit marker in both cases, and a single note is just the N=1
case of it. One rule for the reader: a band is where you are, a ring is what will
change.

The rects are looked up **per beat**, not per note: `findBeats(beat)` returns the
bounds for a whole beat, so a six-note chord would otherwise repeat the same
lookup six times.

## Marking the selected note

Three routes exist, and the one used is the cheapest of them.

**Not CSS.** With `enableElementHighlighting`, alphaTab's SVG groups elements per
**beat** (`<g class="b80">`), not per note, so a stylesheet cannot isolate one
note of a chord.

**Not `note.style`.** alphaTab *can* colour a note natively: `NoteStyle` extends
`ElementStyle<NoteSubElement>` with a `colors` map, and
`NoteSubElement.StandardNotationNoteHead` / `.GuitarTabFretNumber` are exactly
the right targets. Verified: the renderer honours it (the colour appears in the
SVG output), and it does **not** leak into an exported `.gp` - `note.style` comes
back `undefined` after a round trip. But a style change only shows after
`api.render()`, so highlighting on click would re-lay out the score on every
click. Rejected on cost, not on capability, and worth remembering if a
non-transient marker is ever wanted.

**An overlay div, which is what alphaTab does for its own cursor.** With
`core.includeNoteBounds` already on for selection, `boundsLookup` carries a
rectangle per note head. The reverse lookup has no dedicated API, but it exists:
`findBeats(beat)` returns one `BeatBounds` per staff, each with a `NoteBounds`
per note carrying a `.note` back-reference and a `.noteHeadBounds`.

The coordinates need **no scroll maths**. alphaTab positions its own playback
cursor as an absolutely positioned child of the host moved with
`transform: translate(bounds.x, bounds.y)`; being inside the scrolled content, it
follows the score for free. The marker copies that exactly, from a
`position: relative` wrapper that shares the host's origin.

Two details that bite:

- The marker needs `z-index: 1001`. alphaTab puts `z-index: 1000` on its cursor
  wrapper inside the host, and the host is not a stacking context, so that value
  escapes into `.alphatab-scroll` alongside the marker - the same escaping-z-index
  behaviour documented in
  [alphaTab escapes your stacking context](alphatab-gotchas.md#alphatab-escapes-your-stacking-context),
  seen from the other side.
- A render **rebuilds** the bounds lookup, so the rectangles have to be re-read
  from it afterwards. One `postRenderFinished` handler covers every path at once:
  an edit, a track change, a resize, a bars-per-row change.

A test pins the whole reverse path against a real headless render: two rectangles
for a note on a score+tab staff, at two different vertical positions, and
clicking the centre of each finds the same `Note` back.

## Sounding a note, and when the midi gets rebuilt

`api.playNote(note)` generates a **one-note** midi file from the current model
and plays it as a one-time file (measured at 0.1ms), so it reflects an edit
immediately and needs no rebuild of the score midi.

It does not disturb `isPlaying`, which is what lets "edit only while paused" use
that flag without a preview locking the panel against itself:
`playOneTimeMidiFile` sets the synth's `state` field directly, and `state` is a
**plain field with no setter and no event**, so no `playerStateChanged` fires
either when the preview starts or when it ends.

That interacts with the midi rebuild, and the interaction is why the rebuild
moved off a timer. `loadMidiForScore()` calls `stop()` internally, and a preview
is one quarter note (960 ticks, ~500ms at 120bpm), so any debounce short enough
to feel responsive would have truncated it. So edits declare one of two flavours:

| Flavour | Used by | Why |
| --- | --- | --- |
| `now` | tempo | It changes **timing**, and the loaded midi is what maps a scrub position to a tick. A stale one would make the transport disagree with the score. |
| `onPlay` | frets, strings, transposition, retuning | Marked stale, rebuilt when playback starts. Costs nothing while editing, and never cuts a preview. |

Nothing is lost by deferring: pitch and fingering changes do not move any tick,
so a stale midi still maps a scrub position correctly. And the rebuild itself is
cheap - measured at 0-1ms on a 4-bar score, 5-15ms at 77 bars, 16-39ms at 118 -
so paying for it at the moment audio starts is imperceptible, while paying per
keystroke was waste.

## How undo and redo work, and why they are not snapshots

A whole-score snapshot through `JsonConverter`, measured on the two real test
scores:

```
scoreToJson :  96 ms /  9.4 MB   (77 bars)
             152 ms / 18.6 MB   (118 bars)
jsonToScore :  41 ms / 65 ms
30 undo levels:  282 MB / 559 MB
```

Not viable, which the plan established before any of this was built. So a record
captures only the fields the operation is about to touch:

```
field-level record: 0.3-0.9 ms, 8-28 KB
30 undo levels:     233-849 KB
```

About a thousand times less memory. Several operations need **no** captured state
at all, because they are a constant shift: the inverse of "every fret +2" is
"every fret -2", so those records hold a closure and nothing else.

Each record is produced by the edit function itself, in `scoreEdits.js`: that is
the only place that knows what a given operation touched, and keeping the capture
next to the write is what stops the two drifting apart. Neither direction ever
re-validates - both restore a state the model was already in, so running them back
through the forward checks could only refuse something legal.

**Redo costs almost nothing, because a record's restore is a SWAP.** Calling it
exchanges the saved state with the live one, so calling it again re-applies the
edit. Redo is therefore not a second closure per operation: it is the same record,
moved to the other stack and called again. `makeSwap()` covers the value-based
edits, `makeShiftSwap()` the constant fret shifts (which need no captured state at
all, only a step it negates each time), and the delete toggles between a named
`detach()` and `reattach()`.

That also sidesteps the trap the obvious redo would hit. "Re-run the original
operation" sounds simplest, but an undo has already cleared the selection, so
every selection-based redo - a fret nudge, a range transposition, a delete - would
refuse. A swap needs no ambient state.

A **new** edit throws away the redo branch, which is not cosmetic: a redone edit
would otherwise be re-applied on top of a model it was never captured against.

**The delete's undo is the hard one**, and a test caught why. The Note objects
are still alive, only detached, so re-attaching them is cheap - but `finish()`
does more than clear links that lost their target. It also **creates** them
(`findTieOrigin` resolves a tie to an earlier note on the same string once the
original origin is gone) and it copies a tie destination's `fret`, `octave` and
`tone` from its origin. So restoring only the links that were cut left a note
carrying a tie it never had. The record therefore captures everything `finish()`
derives, for every note of every **affected staff** - the right unit, and one that
needs no magic constant, because `finish()`'s link resolution walks
`nextBeat` / `previousBeat` and never leaves a staff.

**`isDirty` follows the stack.** An empty stack means every edit has been undone,
so the score is back to how it was loaded - *unless* the bound threw a record
away, in which case older edits are still applied and `history.isClean` says
false. Without that flag, 40 edits and 30 undos would report a clean score that
still differs from the file.

The stack is cleared whenever the score is replaced or closed. Its records hold
`Note` references, and a `Note` reaches the whole score graph through its
back-references, so a stale stack would pin an entire discarded score in memory -
the same reasoning as the selection.

`Revert` is still there and is a different thing: undo walks back step by step,
`Revert` reloads the bytes of the file in one move and works even past the 30-step
bound.

## Unsaved changes: `beforeunload`, not a key handler

Catching `F5` and `Ctrl+F5` on keydown covers exactly two of the ways out of the
page. It never sees `Ctrl+R`, the reload button, a closed tab, a typed URL or a
back navigation, and some of those combinations are reserved by the browser so
`preventDefault()` cannot touch them at all. A warning that fires on `F5` while
the reload button silently discards the work is **worse than none**: it teaches
confidence the app has not earned.

So the guard is a `beforeunload` listener, gated on `isDirty`, which covers every
one of those paths - `F5` and `Ctrl+F5` included. Two things about it are not
fixable from the page: the dialog is the browser's, so its wording cannot be set
and its appearance cannot be styled (returning a string stopped working years
ago); and browsers only honour it once the page has had a real user interaction,
which is never a problem here because there is no way to have unsaved edits
without having clicked or typed first.

This reverses an earlier decision recorded in the code, which had ruled
`beforeunload` out as "out of proportion for a viewer" and as firing on every
reload during development. Gated on `isDirty` it fires only when there really are
unsaved edits, which during development is almost never.

`guardUnload(event, isDirty)` is split out from the listener so the decision is
testable without a window.
