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

### Selecting everything is the same notion, at full width

`Ctrl+A` builds a range over the whole of one track rather than over the score.
That is not a limitation being worked around, it is the notion itself: a range is
a tick window on ONE track, which is what keeps every batch operation
single-track like the transposition and the retuning. "All" is the whole of that
window.

Two details are worth the lines they take. The first and last beat are found by
**tick, across every staff and voice**, rather than read off
`bars[0].voices[0].beats[0]`: a track's first bar can be empty on one staff and
written on another, and a voice can be empty anywhere. And the band comes from
alphaTab in the same order the double click uses it - `highlightPlaybackRange`
first, the range after - so selecting everything also loops everything, which is
what a drag across the whole score would have done.

It refuses on percussion, and the message says why rather than leaving an empty
selection: `notesInTickRange` keeps only notes with a string and a fret, so a
drum track yields none however much is written on it.

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

**The playhead follows the cursor**, so pressing play starts from where you were
working rather than from wherever the transport was last left. A click does it
too, and there alphaTab does it on its own.

Only while PAUSED, though. Seeking under a running transport would make
navigating during playback impossible - every arrow would jump the music - so
while playing the cursor still moves and alphaTab's selection is still dropped,
and only the seek is skipped.

For a KEYBOARD move it comes free with the selection clean-up rather than as a
second mechanism. `highlightPlaybackRange(beat, beat)` followed by
`applyPlaybackRangeFromHighlight()` takes alphaTab's same-beat branch, which
seeks, and then clears `_selectionStart` and the playback range outright - so the
post-render echo of gotcha 10 has nothing left to replay. alphaTab passes
`shouldScroll: false` on that path, so it does not fight the view following the
cursor. A second same-beat highlight then restores the pair, because the branch
that clears the start leaves the end behind.

**And none of it happens while the mouse is down on the score**, which is the
rule the whole thing turns on: between a mousedown and its release, alphaTab owns
its selection - the press records where a drag would start, each move extends it,
the release applies it. Our own deselect microtask runs exactly in that gap, on
every single press, and doing the clean-up there left alphaTab holding half a
selection: **click-and-drag then drew nothing and its mouseup threw.** The
clean-up stands down between `beatMouseDown` and `beatMouseUp`, and nothing is
lost - alphaTab's own mouseup already seeks to the beat that was pressed and
clears its selection afterwards. Full story, with the four-step sequence and the
two smaller lessons in it, in
[gotcha 10](alphatab-gotchas.md#and-it-leaves-half-a-selection-which-alphatab-cannot-survive).

That is also why the drag is tested as a whole GESTURE - press, moves, release,
with the coordinates that make the press place a cursor - rather than from
`playbackRangeHighlightChanged` alone. Starting halfway through the story is what
let this through: the test double returned early exactly where alphaTab throws,
so it now throws there too.

**The measure the cursor is in gets a papyrus wash**, drawn by our own overlay
from `barRects`, following the arrow keys. alphaTab has a bar highlight of its
own but it follows the PLAYHEAD, which is a different question - where playback
is, not where you are working - and the two part company the moment an arrow is
pressed while paused. One track's bar, not the whole column across every
displayed staff: same rule the ring follows, since a band spanning every staff
would say "all tracks" about a position that is in exactly one.

**alphaTab's own playback cursor is hidden while nothing is playing.** It is a solid
2px bar parked wherever the playhead was left, which on a freshly opened score is
the very start of the piece: next to the dashed edit cursor that is two vertical
markers speaking the same visual language about different things, and the loud
one is the one that is not about editing. Done from CSS, which is safe because
alphaTab sets `position`, `left`, `top`, `willChange` and a `transform` inline on
those elements but never `display`. It keeps updating them while paused, so the
cursor is already in the right place the moment playback resumes. Both halves go,
the beat line and the bar wash: the wash used to be the only thing marking a
measure and was worth keeping as a trace of where playback would resume from,
but now the papyrus marks the measure the cursor is in, and a second band on a
different bar while nothing plays is only a question about which one is real.

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
- **Running off the START is silent.** It is the natural end of a repeatable key.
  The right arrow is the one that does something else: on the last beat of a bar
  that is not exactly full it inserts a rest, and past the end of the score it
  adds a bar. See
  [the right arrow makes room](#the-right-arrow-makes-room-which-is-what-a-passage-is-written-with).
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

## Writing: the line the first tier held, and what crossing it costs

Everything above this point writes **fields on notes that already exist**. The
writing tier creates and destroys structure, and changes durations, and those two
are the same cost wearing different clothes:

| | before | now |
| --- | --- | --- |
| `finish()` on the typing path | never (one exception, the delete) | every write |
| undo records that rebuild rather than restore | one | four |
| the midi flavour | `onPlay` (one `now`: the tempo) | `now` for anything that moves a tick |
| a bar can be overfull | no, by construction | **yes** |

The last row is the one that matters most, and it is why the red outline and the
counter were built a tier early: they stopped being a diagnostic on other
people's files the moment these keys landed.

### What `finish()` on every keystroke actually costs

The plan that designed this tier budgeted **16ms** for it and called it the main
risk. Measured on the two large real files, one write end to end - the model
change, `finish()`, and the undo record - comes to:

| file | write a note | shorten a beat | insert a rest | add a bar |
| --- | --- | --- | --- | --- |
| 77 bars, 4314 beats | 1.4ms | 0.9ms | 0.9ms | 1.0ms |
| 118 bars, 7424 beats | 3.4ms | 2.4ms | 2.5ms | 2.0ms |

Medians of ten, with an occasional first call up to 9.7ms. 16ms is the **cold**
first `finish()` on a freshly imported score; it is idempotent and settles to
0.9-1.8ms after that, so the risk was real and turned out to be small.

What keeps it small is that **none of the writing keys repeats**. A held arrow
walks the cursor and costs a lookup; a held `+` would re-derive the whole score
at the keyboard's repeat rate, so `allowRepeat` is off for all four and a test
pins that it stays off.

### Typing a fret: replace, never wait

Three ways to read two digits, and only one of them never makes the user wait:

| | cost |
| --- | --- |
| wait ~500ms and see if a second digit arrives | every one-digit fret is half a second of nothing |
| accumulate until Enter confirms | one extra key per note, forever |
| **write the first digit, let a second replace it** | a visible correction, on the frets above 9 only |

So `1` writes fret 1 at once and `2` within 800ms replaces it with 12. `3` then
`5` is fret 3 then fret 5, because 35 is off the end of any neck - the second
digit only combines when the number it makes is a fret that exists. A leading
zero is not a number either, so `0` `5` is fret 5.

It leaves **two undo records** for one two-digit fret. That is honest rather than
tidy: both states really were in the model and on the screen, and coalescing them
would produce a record whose "before" nobody ever saw.

The window is closed by identity, not by position: the second digit only counts
if the note the first one wrote is still the note at the cursor. `setCursor`
clears the state, so any arrow, click or other edit in between starts a new
number.

### The duration is not a fourth piece of cursor state

The plan asked for "a quarter note by default", read as a duration the cursor
carries between entries. It needs no state at all: the cursor's duration **is**
the duration of the beat it is standing on, and `new Beat()` is born a quarter -
so are the placeholders alphaTab pads an unwritten bar with. The default falls
out of the model instead of being a constant somewhere that could disagree with
it.

Which also settles what a new beat's length should be: the one before it. A run
of `Enter` presses comes out even, and `+` or `-` before them changes what the run
will be.

One wart, recorded rather than hidden: on a bar nobody has written into yet, `+`
and `-` change the placeholder beat's duration, which is **invisible** - an empty
voice renders as a whole-bar rest whatever its placeholder says - and still counts
as an edit on the undo stack and the dirty flag. The panel shows the value, so it
is not unfeedbacked, and the alternative was a second source of truth for the
duration purely to make that one case free.

### `+` shortens and `-` lengthens

The direction is not obvious either way, so it follows the number that is
written down: a quarter note is a **4** and an eighth is an **8**, so "more" is a
shorter note. The panel says "Shorter" and "Longer" in words, because the keys
cannot.

`Duration` is a denominator, and the two longest values are negative
(`DoubleWhole` is -2, `QuadrupleWhole` is -4), so lengthening is a step along an
ordered list and never arithmetic on the value. `DURATION_LADDER` is that list,
and it exists to make the arithmetic version impossible to write by accident.

**The duration belongs to the BEAT**, so changing "this note's length" changes
the whole chord it is in. That is the musical model rather than a limitation:
`duration` is a field of `Beat` and there is nowhere else to put it.

The **dot** is on the same key row and in the same function of the model:
`beat.dots` is part of how long the beat lasts, not a mark of its own, so `.`
acts on exactly what `+` and `-` act on and the three share one `durationTarget`
so they cannot drift apart about what "this note's length" means. It is stale
until `finish()` like every other tick (pitfall 7): measured, a quarter reads
960, still 960 after `dots = 1`, and 1440 after finishing.

A TOGGLE rather than a count, and the number decided it: across the two large
real files **76 of 11738 beats carry a dot and none carries two**. A key that
stepped 0-1-2 would spend a press on something the music here does not use, so
`.` goes 0 or 1 and an imported double dot clears in one press. A mixed passage
resolves towards dotted, because the first press should do what was asked rather
than undo work already on screen.

On a dragged passage every beat moves, all or nothing - the octave's best-effort
exception does not apply here, because a beat left behind would not hold a wrong
value, it would hold a wrong **rhythm**, which is the whole content of the
operation. Worth knowing what a passage does *not* cover: a range is a set of
**notes**, so a rest inside the passage belongs to no note and keeps its own
length.

### A rest needs no rest object, and Enter has one rule

`Beat.isRest` is a getter over `isEmpty || !deadSlapped && notes.length === 0`,
so a beat with no notes already IS a rest of its own duration - the same fact the
delete relies on from the other side. Placing one is either clearing a flag or
inserting a bare `Beat`.

Enter's rule is read off the position rather than off the key: **go to the next
beat, and write it when it does not exist yet.** Four cases fall out of that, in
order:

| the cursor is on | Enter |
| --- | --- |
| alphaTab's placeholder, in a bar nobody has touched | makes it a real rest **in place**, and stays on it |
| a beat with another beat after it in this bar | moves there, writing nothing |
| the last beat of a bar that is not exactly full | inserts a rest after it, and lands on it |
| the last beat of an exactly full bar | moves to the next bar, and stops at the end of the score |

The last row is why Enter cannot add a bar - that is the right arrow's job - and
the first is why the placeholder has to be told apart from a rest somebody wrote:
inserting beside it would leave it behind to be counted twice.

The third row is the step the right arrow makes as well, through the same
`placeRest` and under the same undo label, so the two keys agree wherever they
overlap and a passage written with a mixture of them reads as one thing in the
undo control.

### The placeholder beat, and why `isEmpty` has to be cleared by hand

`ModelUtils.consolidate` pads every unwritten voice with a beat carrying
`isEmpty = true`, which is what a whole-bar rest is made of. Writing into that
beat has to clear the flag, because `Voice.finish` only ever **sets** `isEmpty`
and never unsets it - and an empty voice is skipped by the renderer and by the
bar-fill arithmetic alike. Without the clear the note is in the model and nothing
draws it.

This is also why an added bar reads as `exact` rather than as incomplete the
moment it appears: every voice of it is empty, which `barFill` treats as an
implicit whole-bar rest.

### A bar is not one object

It is a `MasterBar` - the metre, the key, the repeats, shared by the whole score -
plus a `Bar` on every staff of **every** track. Adding one to a single track
desynchronises the score, so `appendBar` adds them everywhere or not at all, with
the metre of the bar before it (a `new MasterBar()` would silently assume 4/4) and
each staff's own clef and key signature copied from its own previous bar, which is
what alphaTab's `consolidate` does for the same job.

**Append only.** `addBar` and `addMasterBar` set `index` from the current length
and no `finish()` ever renumbers either - only `Voice.finish` renumbers, and only
beats. At the end of the score the indexes stay right for free; an insertion in
the middle would need a renumbering pass over every staff. See
[gotcha 11](alphatab-gotchas.md#11-nothing-can-be-removed-from-the-model-and-only-beats-get-renumbered).

### The right arrow makes room, which is what a passage is written with

The right arrow walks, until it reaches **the last beat of its bar**. There it
looks at one thing:

| the bar the cursor is in | the right arrow |
| --- | --- |
| exactly full | goes to the next bar, adding one past the end of the score |
| anything else | inserts a rest after the cursor |

"Anything else" is both incomplete **and overfull**, deliberately: the test is
"is this bar exactly right", not "does it have room". So the writing loop is one
key - a note, right, a note, right - and it stops making room by itself at the
moment the bar comes out exactly full.

A bar **nobody has written into** reads as exactly full, because every voice of
it is empty and that is an implicit whole-bar rest. So the arrow leaves it alone
and moves on, which is what makes "add a bar, then another" possible without
writing anything into either of them.

The bar is judged by the reading the counter and the red outline already show, so
the three cannot disagree. On a multi-voice bar that reading is its **fullest**
voice, so walking a short voice of an otherwise full bar moves on rather than
inserting.

**The consequence to know about, and it follows from that table rather than being
an oversight: single presses cannot walk right out of an OVERFULL bar.** The bar
is never exactly right, so the arrow keeps making room. The ways out are the left
arrow, a click, holding the key (a repeat only walks), or fixing the durations
with `+` - which is the thing the red outline is asking for anyway.

Three guards make a writing key acceptable on an arrow:

- **A bar is only ever added past the last beat of the last bar**, checked on the
  beat itself - `beat.index` last in its voice, `bar.index` last in its staff,
  `masterBar.index` last in the score - rather than inferred from the walk having
  failed. A failed walk only proves there is no later beat on *this* staff, and a
  staff with fewer bars than the score would then grow the score from the wrong
  end. No bar can be inserted into the middle of a piece by any key. Inserting a
  *beat* mid-score is a different matter and is the whole point.
- **It stands down for an auto-repeat.** `run` reads `event.repeat` and passes
  `canWrite: false`, so a held arrow only walks - crossing an incomplete bar
  instead of filling it at the keyboard's repeat rate.
- **While playing it only walks, too.** Refusing with "pause playback to edit" on
  every incomplete bar would make the arrow useless during playback, which is the
  one thing the bare arrows have always been good for. So this arrow, unlike
  every other edit, is silent rather than refusing: it simply navigates.

The division of labour that keeps this honest is in the code rather than in a
comment. `navigateBeat` is pure navigation - it writes nothing, is not gated on
playback, and never goes near `propagate` - and the composable's `moveCursorBeat`
layers the two writes on top of it. The write is not folded into the walk.

## Creating a score, which is a blank one plus a track

`createScore` is the only thing in `scoreEdits.js` that does not edit a loaded
score, and so the only one that returns a `score` instead of an `undo`. There is
nothing to put back: the document it replaces is discarded by the caller after
its own confirmation, and `scoreLoaded` clears the history and the selection on
the way in - a record pointing into the discarded graph would pin it in memory,
which is the reason that stack is cleared at all.

It builds the master bars itself and delegates the rest to `addTrack`. That is
deliberate: the channel pair, the staff, the bar per master bar and the -12
display transposition are decisions with reasons behind them, and a second
implementation of them would be a second set of defaults to disagree.

**The tempo has to be an automation.** `score.tempo` is a getter over
`masterBars[0].tempoAutomations[0]` with **no setter**, so a new score without
that object reports 120 whatever was asked for - the same pitfall
`applyScoreTempo` exists for, met from the other side. So the tempo is written as
`Automation.buildTempoAutomation(false, 0, bpm, 2)`, which is the same object
`applyScoreTempo` later changes; a test asserts the tempo of a created score is
editable like any other.

`addMasterBar` rather than pushing onto the list, for the reason `appendBar`
uses it: it computes each bar's `start` from the one before and files it into the
repeat groups.

**The denominator is not a free number.** A beat is a power-of-two division of a
whole note and alphaTab's `Duration` enum has no other members, so
`TIME_SIGNATURE_DENOMINATORS` is the list and anything else is refused. The
numerator is a free count, bounded at 32 for sanity rather than by the model.

On the way to the screen it goes through `usePlayer.loadScore`, which is
`api.load(score)`: alphaTab's ui facade checks `data instanceof Score` before it
checks for bytes and hands it straight to `renderScore`, so a built score takes
exactly the same path as an opened file, `scoreLoaded` included. That matters
because every track descriptor, the mixer reset and `isDirty` are seeded there
and nowhere else. What `loadScore` does NOT do is keep `originalBytes`, so
`revertToOriginal` stays unavailable - there is no file to go back to.

An unwritten bar reads as `exact` rather than `under`, which is `barFill`'s own
rule (every voice auto-filled is a whole-bar rest, complete by definition), so a
blank score shows no red bars.

## Adding a track, and duplicating one

### The cloners exist and are out of reach

`NoteCloner` and `BeatCloner` are in the bundle, absent from the `.d.ts` and from
every public namespace - `model.NoteCloner` is `undefined`, and a sweep of the
namespaces finds none. So a duplicate clones by hand, and the field lists are
transcribed from their source, which is the authority: the `@clone_ignore`
annotations in the `.d.ts` are exactly what those cloners encode.

For the levels with no cloner at all - Voice, Bar, Staff, Track - the list comes
from alphaTab's **serialisers**, the ones `JsonConverter` drives. That is
alphaTab's own answer to "what on this class is data", maintained with the class.

| Level | Fields | Where the list comes from |
| --- | --- | --- |
| Note | 34 plus `bendPoints` | `NoteCloner` |
| Beat | 44 plus notes, automations, lyrics, whammy points, tremolo | `BeatCloner` |
| Bar | 10 plus voices | `BarSerializer` |
| Staff | 9 plus bars, chords, tuning | `StaffSerializer` |
| Track | 5 plus staves, playback info, colour, articulations | `TrackSerializer` |

Three of those entries are traps rather than transcription:

- **`bendPoints` is an array.** Measured: after a plain assignment,
  `clone.bendPoints === original.bendPoints`, so editing one note's bend would
  edit the other's. It is copied point by point.
- **The list must not be guessed.** A plausible one threw
  `TypeError: Cannot set property isTieOrigin of #<Note> which has only a
  getter` - `isTieOrigin` is a getter, and `NoteCloner` deliberately skips it.
  None of the 34 it does copy is read-only.
- **Chord definitions travel with the staff.** Beats refer to them by `chordId`,
  so a copy without them has chord diagrams pointing at nothing.

### The links are rebuilt, not re-derived

A clone carries none of the eleven cross-note links, which is what
`@clone_ignore` means. It would be tempting to let `finish()` sort them out -
`Note.finish` re-resolves a tie whose origin is null by looking for a note on the
same string in the preceding bars. That is a **guess**, and it is the same
mechanism that invents a tie on a paste and copies the wrong fret with it.

Every link's other end is inside the copy, so the exact answer is available:
walk the two trees in step, build an original-to-clone map for every note and
beat, and remap the eleven fields plus the two beat-level effect-slur ends. A
link whose other end somehow fell outside the track is dropped rather than left
pointing into the original.

Verified against the fixture and both large real files: the copy's whole link
graph is identical to the original's, expressed as indexes; nothing points
outside; the `.gp` round trip keeps it; and the generated midi of the copy is
note for note the original's on another channel. That last one is the assertion
that matters, because it is the one that would catch a missing field that affects
sound.

### Both need their own midi channels

Sharing a pair means a program change on either track re-voices the other, which
is the collision `trackSound.js` documents from the other side. `freeChannelPair`
hands out the lowest unused pair and never gives out channel 9, which is
percussion.

### A new track has to be as long as the score

A track is not one object either: it needs a `Staff`, and that staff needs one
`Bar` per master bar. A staff shorter than the score is exactly the ragged shape
`ModelUtils.consolidate` exists to repair, so the bars are built up front rather
than left to it.

`displayTranspositionPitch` defaults to **-12**, and that is measured rather than
chosen: on the real files every guitar and bass staff carries -12 while only the
flute, choir and violin staves carry 0. Guitar Pro writes fretted instruments an
octave above where they sound, and every tuning the dialog offers is a fretted
instrument. Prefilling from an existing track copies that track's value instead,
so a non-fretted source stays right.

The tuning list is its own question, and not the one `tuningChoices` answers:
that takes an existing staff and offers the presets for ITS string count. A track
that does not exist yet has no string count, so **the choice of tuning is the
choice of how many strings it has**. Counted: 11 presets for four strings, 6 for
five, 31 for six, 1 for seven, and none at all for eight - which is why eight is
not offered.

### The strip is spliced, never rebuilt

All three track operations share `attachTrackView` / `detachTrackViewAt`, and the
reason is the same as the delete's: the reactive descriptor carries the volume,
the mute, the solo and whether the track is displayed, none of which is in the
file. Rebuilding the list would silently reset it.

A track added or duplicated on request arrives **displayed**, because one that
appeared invisibly would look like nothing had happened.

### A whole track is the cheapest structural delete here

Deleting a track needs **no link sweep and no derived capture**, where deleting
bars needs both, and the reason is a measurement: **no note link crosses a
track.** Counted on the fixture and on both large real files - 0 of them, against
the 106 and 191 that cross a bar line - which follows from how `finish()`
resolves links at all, by walking `nextBeat` and `previousBeat`, neither of which
ever leaves a staff. So a splice and a renumber is exact, and the `.gp` round trip
after an undo says so.

`track.index` is renumbered for the same reason a bar's is: `addTrack` sets it
from the current length and no `finish()` touches it again, while every reactive
descriptor, every `trackAt` lookup and every render hint is keyed on it.

**Half of this operation is app state, which is why it lives in `usePlayer`.**
The reactive descriptor carries the volume, the mute, the solo and whether the
track is displayed - none of it in the file - so the descriptor is *spliced* and
renumbered alongside the model rather than rebuilt, and the undo puts the same
object back with its mixer state intact. Rebuilding the list would have silently
reset it. `scoreTracks` needs no splice of its own: it **is** `score.tracks`, the
same array object, assigned on load.

Two orderings are load-bearing. The model goes first in both directions, because
the view step ends in `applyRenderedTracks`, which hands alphaTab `Track` objects
out of the score as it now is. And if the deleted track was the only one
displayed, the first one left is promoted - alphaTab needs a non-empty selection,
and `renderTracks([])` is refused rather than rendering nothing.

The render comes from `renderTracks` itself, so the propagation asks for none: a
second `api.render()` would lay the whole score out twice for one action.

One consequence recorded rather than guarded: `MasterBar.keySignature` is a
getter over `score.tracks[0].staves[0].bars[index]`, so deleting the **first**
track makes the score report the key signature of whatever track is first
afterwards. That is alphaTab's own definition of a score's key rather than
something to work around.

**No confirmation**, and the line is worth drawing precisely because this is the
biggest thing that can go. The one control in the app that asks is `Revert`, and
it asks because it throws away edits the 30-step stack has already dropped. A
track delete is one step on that stack, so `Ctrl+Z` covers it - the same call the
note delete and the bar delete already made.

### A range is notes, and the bar keys needed something else

`Ctrl+Delete` on a visibly selected passage deleted **one** bar. The cause is a
distinction that had not been drawn before:

> A range is a set of **notes**. A drag is a span of **bars**.

`notesInTickRange` keeps only notes with a string and a fret, so a drag builds no
range at all over bars that hold none - empty bars, or a percussion staff, which
it skips entirely. alphaTab's band still painted what was dragged, so it looked
like a selection while the editor had none, and the bar keys fell through to the
cursor and took the one bar it was on.

Selecting empty bars and deleting them is not an edge case, it is the obvious way
to use the key: **the bars you want gone are usually the ones with nothing in
them.**

So the bar span is now recorded from the beats the drag resolved to, before any
note is looked at, and the note range is layered on top:

| | built from | used by |
| --- | --- | --- |
| `rangeNotes` / `selectedRange` | the notes in the tick window | strings, frets, octave, silence, lengths |
| `rangeBars` / `selectedBars` | the beats' master bars | `Ctrl+Insert`, `Ctrl+Delete` |

Three consequences worth keeping:

- **The predicates part company.** `canEditBars` accepts a bars-only drag;
  `canNavigate` and `canChangeDuration` must not, because with no cursor and no
  note range the arrows and the length keys would swallow their key for nothing.
  That is the divergence the shared `hasTarget` was named separately for.
- **The panel says so.** Bars with no notes now read as
  "bars 4-5, no notes in them" rather than as nothing at all, which is what made
  the state look like a bug in the key rather than a state of the selection.
- **The delete reports its scope.** It is the one operation whose extent is
  invisible afterwards - the bars are gone, so nothing on screen says whether one
  went or five - so it posts "2 bars deleted (4 to 5)" after `propagate`, on the
  same channel the octave uses for its blocked count.

This is the same family as the finding in the copy-and-paste plan: building a
clipboard from `rangeNotes` would silently drop the rests inside a copied
passage. Same root, different key.

### Bars in the middle: what the append does not have to do

`appendBar` is cheap because alphaTab's own `addMasterBar` and `addBar` do
everything at the end of a score: they set `index` from the current length,
compute `start` from the previous bar, and file the new bar into the open repeat
group. `Ctrl+Insert` and `Ctrl+Delete` land in the middle, where none of that
holds, so they share a `renumberBars` pass that does four things by hand:

| | why |
| --- | --- |
| renumber `MasterBar.index` and `Bar.index` | no `finish()` renumbers either - only `Voice.finish` does, and only beats |
| re-chain `previousMasterBar` / `nextMasterBar` and `previousBar` / `nextBar` | `finish()`'s link resolution walks them |
| `masterBars[0].start = 0` | `MasterBar.finish` recomputes `start` only for `index > 0` |
| `rebuildRepeatGroups()` | groups are built by appending, so leaving one has no inverse |

All four are in [gotcha 11](alphatab-gotchas.md#11-nothing-can-be-removed-from-the-model-and-only-beats-get-renumbered),
with the measurements. The third was a real bug before it was a line of code:
deleting bar 0 left the bars starting at 3840 and the first beat's
`absolutePlaybackStart` at 3840, which is the field the drag selection and the
loop range are built from - so selecting a passage was broken after deleting the
first bar of a score, with nothing on screen to say why.

A fourth thing bit during the build and is worth the sentence: **a bar spliced
into `staff.bars` has no `staff`,** because that is what `Staff.addBar` is for.
The first thing to read it is `Beat.finish`, which throws inside alphaTab with a
message naming neither the field nor the bar.

### Inserting: the tempo is the trap at index 0

`Score.tempo` is a getter over `masterBars[0].tempoAutomations[0].value` with a
fallback of 120, so **a new first bar with no automation silently drops the whole
score to 120**. Measured: 168 before, 120 after. So the automations *move* onto
the new first bar rather than being copied - which also keeps the tempo marking
drawn at the start of the piece, where a copy would have left a duplicate
mid-score. The undo moves them back.

The new bar is shaped like the bar **before** the insertion point rather than
like the one it displaces, which is the conservative choice at a metre or key
change: copying the displaced bar's signature would move where that change is
drawn one bar earlier. Inserting before bar 0 has no previous bar, so there it is
the displaced one.

### Deleting: `deleteNotes` and the renumbering at once

Every note in the removed bars goes, so this carries the whole of the note
delete's machinery on top of the renumbering:

- **The link sweep.** A link to a deleted note survives `finish()`
  ([gotcha 6](alphatab-gotchas.md#6-deleting-a-note-leaves-stale-links-that-survive-finish)),
  and links really do cross bar lines: measured, **106 and 191** of them on the
  two large real test files, mostly ties and bend origins. The fixture has
  **none at all**, which is why this invariant is checked against real files.
- **The derived capture.** `finish()` creates links as well as clearing them, so
  restoring only the cuts leaves a note carrying a tie it never had. Every staff
  loses a bar here, so the capture is every surviving note of the score:
  335-855KB on the two real files, against 9.4-18.6MB for a `JsonConverter`
  snapshot of the same score.
- **At least one bar has to remain.** alphaTab renders `masterBars.length` bars
  and `ModelUtils.consolidate` exists to put one back, so an empty score is a
  state to refuse rather than to produce. Refused with the count, like every
  other refusal here.

What it costs, measured end to end including the capture and `finish()`:

| file | insert a bar | delete one bar | delete eight |
| --- | --- | --- | --- |
| 77 bars, 2856 notes | 1.6ms | 5.9ms | 4.5ms |
| 118 bars, 7295 notes | 3.7ms | 12.0ms | 9.5ms |

Deleting eight bars is *cheaper* than deleting one, which is not a mistake: the
capture is over the notes that SURVIVE, so removing more of them leaves less to
capture.

Neither key repeats, and both are `Ctrl` combinations rather than bare keys -
these are the two most destructive operations in the editor, and a held key
eating a bar per repeat would be undoable only one step at a time.

**No confirmation on the delete**, which is the call the note delete already
made, for the same reasons: a prompt every time would make it useless, a
threshold on the count would be arbitrary, `Ctrl+Z` takes it back in one step,
and `isDirty` warns before the score is replaced or closed. The score visibly
shrinks, which is the feedback.

### Where Enter and the right arrow differ, and why

Both place the same rest, through the same `placeRest` and under the same undo
label, and they agree on the case a passage is actually written in: the last beat
of a bar that is not exactly full. What differs is the rest of the table:

| the cursor is on | Enter | right arrow |
| --- | --- | --- |
| a bar nobody has written into | makes the rest real **in place** | moves on to the next bar |
| a beat with another after it in this bar | moves there | moves there |
| the last beat of a bar that is not exactly full | inserts | inserts |
| the last beat of an exactly full bar | moves on | moves on, adding a bar past the end |

The two rows they disagree on are the two keys meaning different things. Enter
means "there should be a rest here", and on an untouched bar that is the bar's
own placeholder rather than a beat beside it. The arrow means "go right", and it
leaves an untouched bar untouched.

### Clicking the score takes the keyboard back

alphaTab calls `preventDefault()` on its own mousedown when
`enableUserInteraction` is on, and that **suppresses the focus change**. So a
control used a moment ago still owned the keyboard while the user was looking at
the score: pick a value in the bars-per-row select, click a note, and the arrow
keys still moved that select. Nothing on screen said why.

A plain DOM `mousedown` on alphaTab's host now blurs whatever had the focus.
alphaTab's own event is not enough here - it only fires when the press lands
inside a bar, while a press anywhere on the rendered surface should hand the
keyboard back.

Blurring also **commits**: the panels write their fields on `change`, which fires
on blur, so a half-typed tempo is applied rather than lost. That is the same
reason `Ctrl+S` blurs before it exports.

This changes a premise recorded above. The writing keys stand down for every
element that owns typing keys - a digit typed into a tempo field is a digit - and
that used to mean "type a tempo, click a note, type a fret" put the fret in the
tempo field, with no fix available. Now the click takes the focus, so the
sequence works and the stand-down costs nothing.

The rule is split out as `focusToRelease(active, host)` so it can be tested
without a document, the same way `guardUnload` is. Two cases matter: an element
with no `blur` of its own, and anything alphaTab put inside its own host, which
is never ours to interfere with. Blurring the body needs no case - it is a no-op.

## Palm mute: a note property whose MARKING is derived

`note.isPalmMute` is a plain field, so setting it looks like the cheapest edit in
the file. Two derived things say otherwise, and both are only ever **set** by
`finish()`, never cleared:

```js
Beat.finish : if (note.isPalmMute) this.isPalmMute = true
Note.finish : palmMuteDestination, assigned only when the flag is true
```

The beat's flag is what draws the P.M. bracket. So clearing the last muted note
of a beat left the bracket on the score - caught by a test, not by reading, and
it is the same shape as `Voice.isEmpty`, which the writing tier had already been
bitten by.

The fix is to reset both across the **affected staves** and let `finish()` rebuild
them from the note flags. The staff is the right unit for the reason it is in
`deleteNotes`: alphaTab's propagation walks `previousBeat` / `nextBeat`, which
never leave a staff. And nothing has to be captured, unlike the delete - the
derived values follow the flags, and the flags are what the swap restores.

alphaTab also **propagates the marking onto adjacent rests**, forward onto a rest
that follows a muted beat and backwards off the rests before an unmuted one. That
is deliberate on its part, and it is why the real-score invariant checks the
"a beat claims the marking only when one of its notes does" rule for beats that
hold notes and skips the rests.

**`onPlay`, not `now`,** and this one was measured rather than assumed. Over the
whole midi event stream: 417 events before and after, with exactly one pair
different - the note-OFF moves from tick 960 to 160. The note is cut short while
starting at the same instant, so the tick grid does not move and a scrub position
still maps correctly. Same flavour as the frets.

It is refused on percussion, and that refusal is ours: measured, a drum note
takes the flag without complaint. Same call the frets and the strings already
make.

**Two keys, one action.** `P` and `M` both do it, the way `Delete` and
`Backspace` both silence - here because the notation itself writes "P.M." above
the staff, so either letter is the obvious reach. They are bare characters, so
they carry the digits' strictness: down for anything that owns typing keys, and
down unless a NOTE is designated. A cursor on an empty string is not enough,
which is what separates `canEditNotes` from `canWriteNote`.

## Harmonics: the node is a second field beside the fret

`note.harmonicType` says which kind, and `note.harmonicValue` says **where the
node is**. The second one is the trap, and it is a wrong-value trap rather than
a missing-value one:

```js
Note.harmonicPitch : maps harmonicValue -> semitones
Natural : realValue = harmonicPitch + stringTuning     // the fret is absent
others  : realValue = fret + harmonicPitch + stringTuning
```

A natural harmonic written with `harmonicValue` left at 0 gets 0 semitones, and
because the fret is absent from its formula the note then sounds the **open
string** - a plausible pitch, silently wrong, with nothing to catch it. So
`toggleNaturalHarmonic` sets `harmonicValue = note.fret`, which is also what
every imported harmonic in the fixture carries.

**Not every fret has a node.** alphaTab's table answers 0 outside these:

```
3 4 5 6 7 8 9 10 12 14 15 16 17 19 22 23 24
```

Nothing at 0, 1, 2, 11, 13, 18, 20 or 21. On those the natural harmonic is
**refused** rather than written as a note that would sound the open string, and
the refusal names the frets that work. All or nothing across a passage, for the
frets' reason: a half-applied selection is worse than none. `HARMONIC_FRETS` is
the list, and a test re-derives it from `harmonicPitch` itself so a library change
shows up as a failure rather than as a wrong pitch.

**The artificial one is always a pinch.** `HarmonicType` has seven values and
Guitar Pro offers most of them in a dropdown; the choice here is that the dialog
does not, because a pinch is what gets written in practice and a select with one
useful entry is not a choice.

What the dialog does ask is the **node**, and the first version of it got that
wrong in a way worth recording. It offered one entry per interval - the lowest
node of each - on the reasoning that the interval is what a player hears and the
rest of alphaTab's table is duplication. It is not duplication: a node is a
POSITION as well as a pitch. The same interval is available at several places
along the string, the right hand goes to one of them, and which one is what the
file records. Reported from the score: a note fretted at 4 has its octave + fifth
under the right hand at fret 23, and the list stopped at fret 11.

So all seventeen are offered, grouped by what they sound:

| Interval | Semitones | Nodes |
| --- | --- | --- |
| Octave | +12 | 12 |
| Octave + fifth | +19 | 7, 19 |
| Two octaves | +24 | 5, 24 |
| Two octaves + major third | +28 | 4, 9, 16 |
| Two octaves + fifth | +31 | 3.2 |
| Two octaves + minor seventh | +34 | 2.7, 6, 10, 15 |
| Three octaves | +36 | 2.4, 8, 17, 22 |

The values are the ones real files carry where a real file carries one: 2.4, 3.2,
4, 5, 7 and 12 all appear in the two measured scores, which is why the table says
3.2 and not the 3 that also works. alphaTab accepts a RANGE per interval, so a
file may hold a node the dialog does not offer - `offeredHarmonicNode` maps it to
the nearest offered node of the same interval, because opening the dialog on such
a note and silently landing on the octave would retune it the moment Apply is
pressed.

Two details of that table are alphaTab's rather than ours. The fractional nodes
are between frets, so `note.fret + harmonicValue` is fractional too and the
dialog reports it as such rather than rounding to a fret the finger does not go
to. And the node at 22 is labelled three octaves because that is what alphaTab
sounds there, while physically 22 semitones is the seventh partial's node at 7/2
and should be +34 - the label follows the library, since the library is what
plays it and draws it.

Guitar Pro's "right hand fret" is still not a field: it is
`note.fret + harmonicValue`, so choosing the node chooses it. It names each entry
of the list, and the dialog also shows it read-only beside the left hand fret,
which is the pair a player reads.

**No `finish()`.** `realValue` is a getter over the node table, so the pitch is
right the instant the two fields are, exactly as with `setNoteFret`. And `onPlay`
rather than `now`: the pitch moves, no tick does.

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
| `now` | tempo, durations, an inserted rest, an added bar | They change **timing**, and the loaded midi is what maps a scrub position to a tick. A stale one would make the transport disagree with the score. |
| `onPlay` | frets, strings, transposition, retuning, a written note, palm mute, harmonics | Marked stale, rebuilt when playback starts. Costs nothing while editing, and never cuts a preview. |

**A rebuild also drops the loop range**, which is alphaTab's doing rather than
ours: the range is a field of the sequencer state, and loading a midi replaces
that state. So `reloadMidi` saves it alongside the tick and the playing state and
`restoreAfterMidiReload` puts all three back, range first because its setter
moves the playhead. Full account in
[gotcha 12](alphatab-gotchas.md#12-a-midi-rebuild-silently-drops-the-playback-range).

One honest gap, which the writing tier makes more visible rather than
introducing: **an undo always marks the midi stale rather than rebuilding it**,
because the history record does not carry the flavour of the edit it reverses.
So right after undoing a duration change - or a tempo change, which has had the
same gap since it was built - the scrub bar maps a position to a slightly wrong
tick until playback starts and the rebuild happens. Fixing it properly means the
flavour travelling with the record; rebuilding on every undo would pay 16-39ms
for the many undos that move no tick at all.

The split is exactly "does this move a tick". Writing a note is on the cheap side
even though it is a structural change, because a note added to a beat that
already exists moves nothing - which also matters for the preview: a rebuild
calls `stop()` internally, so a `now` flavour would cut off the note the write
just sounded.

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

**Four records rebuild structure rather than restoring values**, and they all
have the same shape: a named `attach()` and `detach()`, a boolean saying which
way round it is, and a swap that toggles. The objects are created once and kept
in the record, so a redo re-attaches the same `Note`, `Beat`, `MasterBar` and
`Bar` rather than building new ones - which is what makes an undo of an added bar
cheap and, more importantly, exact.

Three of them are much simpler than the delete, and the reason is worth writing
down because it looks like an omission. `finish()` **creates** cross-note links as
well as clearing them, but only where `tieOrigin` is already null. Deleting a note
can produce that state; adding one cannot. So the delete captures everything
`finish()` derives for the whole affected staff, and the add captures nothing -
pinned by a test that compares the full link graph and the generated midi of the
fixture's Ties track across an add and its undo, rather than by trusting the
argument.

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
