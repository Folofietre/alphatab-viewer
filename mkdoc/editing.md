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

## The cursor is the selection, extended to somewhere empty

A selection can only ever designate something that **exists**. Writing music
means pointing at somewhere that does not, so the position had to be able to land
on an empty string.

The trap here was three concepts - a cursor, a selected note, a dragged range -
and keeping them in step. There are **two**: a position, which may or may not
hold a note, and a range. Clicking a note puts the cursor on it and selects it;
that is one act, not two states to synchronise. `setCursor()` is the single place
`selected` is written from a position, so the two cannot disagree.

One case needs the note passed in explicitly rather than found back from the
string: percussion reports `string: -1`, so resolving through
`getNoteOnString()` would answer null and clicking a drum would silently select
nothing.

### Clicking an empty string needs the mouse coordinates, which the typed event lacks

`api.beatMouseDown` carries the `Beat` and no coordinates. That is enough to
select a note, because the note hit-test has already run by then; it is not
enough to place a cursor on an empty string, which has no object of its own to be
handed over.

alphaTab also dispatches a DOM `alphaTab.beatMouseDown` CustomEvent on its host
element for every typed event, and `UiFacade.triggerEvent` puts the original
`MouseEvent` on it as `originalEvent` whenever the event came from the mouse.
That is the only route to the X and Y.

The order is guaranteed and load-bearing: `_onBeatMouseDown` fires the typed
event, then the DOM one, and only then `_onNoteMouseDown`. So the coordinates are
already recorded by the time the deselect microtask runs, and that microtask now
places a cursor instead of clearing everything - falling back to a plain
deselection when there are no coordinates, so a synthetic event cannot leave a
stale cursor pointing at wherever the last real click was.

### The hit-test is our own, because alphaTab's ignores Y for the bar

`BoundsLookup.getBeatAtPos` picks the bar with `findBarAtPos(x)` - **X only** -
so with several tracks displayed the beat it returns can belong to a different
track from the one that was clicked. Selecting a note hides that, because the
note hit-test that follows is a rectangle and does use Y. An empty string has no
such second chance.

So `scoreGeometry.js` walks the lookup itself: the staff system by Y, the master
bar by X, then the `BarBounds` by Y. Each step falls back to the NEAREST
candidate, which is not politeness: bars are only as tall as the notation they
hold, so between the standard staff and the tablature of one track there is a
real gap - 56px on the fixture - belonging to no `BarBounds` at all.

It also picks the beat itself rather than calling `BarBounds.findBeatAtPos`,
which compares with a strict `<`: a note whose head is drawn exactly on its
beat's left edge - a tie destination, which the fixture's Ties track really has -
then resolves to the previous beat. One pixel wide, but it is the pixel the note
is at.

### Which row is the tablature, and why the answer is "the last one"

`showStandardNotation` and `showTablature` can both be true on one staff, and
alphaTab then renders two rows and produces two `BarBounds` carrying the **same**
`Bar`. Only on the tablature does a Y coordinate mean a string: measured, the
same interpolation on the standard staff answers string 3 for a note on string 4.

The tablature is the last row, and that is read from alphaTab rather than
guessed: `StaveProfile._createDefaultStaveProfiles` lists the renderers as
`Slash, Score, Numbered, Tab`, so the tablature is drawn below every other
notation of the same staff, `showSlash` and `showNumbered` included.

### Never `barBounds.bar` - it is empty in the browser

Everything above depends on getting from a rectangle back to a `Bar`, and the
obvious field does not work in the running app: alphaTab renders in a worker and
`BoundsLookup.fromJson` never restores `BarBounds.bar`. Rendering synchronously
through `ScoreRenderer`, which is what a Node test must do, keeps it - so this is
green in every test and `undefined` on screen. `BeatBounds.beat` is restored, so
the beat is the route:

```js
const bar = barBounds?.bar ?? barBounds?.beats?.[0]?.beat?.voice?.bar ?? null
```

Full details, and what it broke, in
[gotcha 9](alphatab-gotchas.md#9-barboundsbar-is-empty-in-the-browser-and-full-in-your-tests).

### A click anywhere in the bar is projected onto that row

This started as "a click on the standard staff has no string", which is honest
and was unusable. Swept pixel by pixel down one system of a real six-track score,
**128 of its 254 vertical pixels** belong to the standard row or to the gap above
the tablature - so half of every bar placed a cursor with no string on it and a
full-height caret to show for it.

So the string is always read against the **tablature row of the bar that was
clicked**, wherever the click landed, clamped to the nearest line: above the tab
gives the top string, below gives the bottom. `isTablature` still reports whether
the click was on the tab itself, which is the difference between an exact reading
and a nearest one.

A null string survives in exactly one place: a bar with no tablature at all -
percussion, or a stringed staff whose tab is hidden. There is nothing there to
project onto, and inventing a string would be a lie rather than an
approximation.

### The interpolation, and how exactly it was checked

```
spacing = visualBounds.h / (strings - 1)
string  = strings - round((y - visualBounds.y) / spacing)
```

`h / (strings - 1)` and not `h / strings`, because the first line sits on the top
edge. The subtraction at the end is pitfall 2: the lines are drawn highest string
first while `note.string` counts up from the lowest.

Not "close enough" - exact. Run against a headless render of the fixture with all
six tracks displayed, it returns the right string for **all 81 notes** of the five
stringed tracks, whose staves have 4, 6 and 7 strings. A test keeps it that way,
because being off by one line would place the cursor on the wrong string with
nothing on screen to say why.

### Two markers, never both at once

The cursor draws a **dashed** outline; the selection draws a solid ring. They are
never on screen together: the ring already marks the position whenever it holds a
note, and a second marker on the same place would read as two positions.

On an empty string there is no note head to measure, so the rectangle is invented
from the string spacing rather than read from the lookup. With no string at all -
a staff with no tablature - it becomes a full-height caret on every row of the
beat.

**alphaTab's own beat cursor is hidden while nothing is playing.** It is a solid
2px bar parked wherever the playhead was left, which on a freshly opened score is
the very start of the piece: next to the dashed edit cursor that is two vertical
markers speaking the same visual language about different things, and the loud
one is the one that is not about editing. Done from CSS, which is safe because
alphaTab sets `position`, `left`, `top`, `willChange` and a `transform` inline on
that element but never `display`. It keeps updating the transform of a hidden
element while paused, so the cursor is already in the right place the moment
playback resumes. The soft bar wash stays - it is quiet enough not to compete.

## Navigating with the arrows, and giving them back

The bare arrows move the cursor: left and right along the beats, crossing bars;
up and down across the strings of the same beat, in the direction the key points.

With **nothing selected** they are not claimed at all and the page still scrolls,
which is the only reason taking them is acceptable. That decision has to be
reachable from `appliesTo`, not from `run`: the handler calls `preventDefault()`
before `run`, so deciding later would have killed the scroll either way. This is
why `appliesTo` grew a third argument.

Three smaller rules, each of which would otherwise look like a broken key:

- **Empty bars are walked through, not stopped at.** A bar with no beats in this
  voice is a hole in the line, not the end of it.
- **Running off either end is silent.** It is the natural end of a repeatable
  key. Creating a bar past the end is a write, and belongs to the writing palier.
- **A dragged range collapses onto its far edge.** Right moves on from the range's
  last note, left from its first - the edge the arrow is travelling away from.
  The range then goes, because a cursor and a range are the two notions and only
  one at a time.

From a position with no string yet - only possible on a staff with no tablature -
the first press enters the fretboard from the far edge in the direction of
travel: up starts at the lowest string, down at the highest, so the next press
continues the same way instead of doubling back.

**The view follows, driven by a move counter and nothing else.** The rectangles
are also rebuilt after every render, with the same values, so watching them would
make the view jump on a resize or a track toggle - and during playback it would
fight alphaTab's own scrolling. A counter only changes when the user pressed an
arrow, which is the one moment following them is what they meant.

## How full a bar is, and the one thing nothing else reports

An overfull bar - one holding more ticks than its time signature allows - passes
through alphaTab's model, its midi generator and its `.gp` exporter without a
word. See pitfall 8. So the red rectangle and the counter in the action bar are
the only thing in the stack that will ever say a bar is invalid.

Three states, not two, and that is the important part: a bar being written into
is *incomplete* for most of its life, so marking that red would paint the whole
score red. Only the overflow is coloured.

| Reading | Meaning | Shown as |
| --- | --- | --- |
| filled < capacity | incomplete, normal while writing | nothing |
| filled = capacity | correct | nothing on the score |
| filled > capacity | **invalid** | red outline round the bar |

Three details in the arithmetic, all verified rather than assumed:

- `masterBar.calculateDuration()` already handles the **anacrusis**: for a normal
  bar it returns `numerator * valueToTicks(denominator)`, and for a pickup bar
  the longest bar actually written at that index, which is the only sane capacity
  for a bar that is deliberately short.
- `voice.calculateDuration()` returns **0** for a voice alphaTab marked empty.
  `finish()` fills unwritten voices with generated rests and leaves `isEmpty`
  true, so counting them would report every multi-voice bar as empty. They are
  skipped, and a bar whose every voice is empty is an implicit whole-bar rest.
- Tick arithmetic **drifts downwards on tuplets**: seven sixteenth-septuplets are
  137 ticks each, so 959 where a quarter note is 960. The comparison carries a
  tolerance of one tick per beat, which is the exact bound on that truncation.

The bar is judged by its **fullest** voice, since one voice overflowing is enough
to make the bar invalid.

Measured across 17 real files and 11682 bars: exactly one bar came out overfull
and one incomplete, both genuine. So this is not a false-positive machine - which
was the real risk - but it is also worth being honest that on files someone else
wrote it will almost never fire. Its value arrives with the writing palier, and
that is the reason it was built first: the net is hung before anyone walks on the
wire.

The counter beside it reads in **beats of the time signature** rather than ticks,
because `3 / 4` says something to a musician where `2880 / 3840` does not. It is
centred in the document strip, among the other facts about the document.

Its palette is not the chrome one it started with, and the reason is measured.
The strip is `#67778c`, which gives pure white only 4.57:1, so anything tinted or
below full opacity falls under AA: the muted chrome text scores **1.90:1** there
and the chrome warning text **2.34:1**. So every glyph is full-opacity white,
hierarchy comes from weight and size - the rule `ScoreHeader.scss` already
documents for the metadata beside it - and the overfull state moves its contrast
into a filled chip, where white on `--warn-solid` measures 6.89:1.

## The octave is a re-fingering, not a fret shift

Measured on two real files, and this is the number that decides the design:

| file | +12 same string | -12 same string | -12 impossible |
| --- | --- | --- | --- |
| Le Chant des Forges | 99 % | 2 % | 22 % |
| Morbid Angel (.gpx) | 95 % | 7 % | 85 % |

Going up an octave almost always stays on the same string. Going down one is
physically impossible for most notes - the instrument does not reach that low.
Over the 17 real files as a whole: **1.8 %** of notes cannot go up, **36.8 %**
cannot go down.

So the octave aims at a pitch and looks for a string and fret that can hold it:
the current string first, then the others in the direction of travel, nearest to
farthest. Going up when the fret runs off the neck means moving to a *higher*
string, which needs a lower fret for the same pitch.

The pitch target is computed from `fret + tuningForString(...)` rather than from
`note.realValue`, so both sides of the subtraction use the same convention and
any capo or track transposition cancels instead of having to be reasoned about.

**Landing is allowed only onto a string that is empty in that beat**, even when
the note currently there is also part of the batch. That refuses a few placements
a cleverer solver would find, and in exchange no note can be dropped by two notes
claiming one entry of `noteStringLookup` (pitfall 5). "Empty" has to mean empty
*after the moves already planned*, not just in the model as it stands: without
that, two notes of one chord both find the same free string and the second
silently erases the first. The real-score invariant caught exactly that.

### Best effort, and why the exception does not spread

This is the one operation that is not all or nothing, and the reason it is
tenable has to be written down or the exception will contaminate the rest:

> **Clipping produces a wrong value. Not moving keeps a right one.**

A fret transposition that clips leaves a note at fret 0 where it needed -2: that
note now sounds wrong, and it has lost its interval with its neighbours, which is
the whole content of a transposition. A note that could not drop an octave keeps
the pitch it always had. The passage is no longer the passage an octave down, but
no note carries an incorrect value.

So the frets and the strings stay all or nothing, and only this is best effort.

**And it needs no new result state.** `movedCount` and `blockedCount` are facts
about what happened, of the same kind as the `noteCount` the other operations
already return. A fourth result state was drafted and dropped: the score is on
screen, a note that did not move is visible with its fret number unchanged, and
that is a better channel than any flag. The message that does appear is posted by
the caller *after* `propagate` - which clears the message on a success - so an
existing channel is used by a caller rather than the contract changing.

The only real difference from all-or-nothing is in the undo, and it settles
itself: the swap holds only the notes that **moved**, so undoing puts back only
those. Same mechanism, shorter list.

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
