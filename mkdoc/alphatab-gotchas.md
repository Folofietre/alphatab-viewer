# alphaTab gotchas


All twelve were found by running code against alphaTab **1.8.4**, not by reading
the docs, and each one silently corrupts an edit - or lets a corrupt one
through, or quietly disables a feature - if you do the obvious thing. They are the reason
[src/utils/scoreEdits.js](../src/utils/scoreEdits.js) exists as its own module.

## 1. `score.tempo` is read-only

```js
score.tempo = 200
// TypeError: Cannot set property tempo of #<Score> which has only a getter
```

The getter is derived:

```js
get tempo() {
  return this.masterBars.length && this.masterBars[0].tempoAutomations.length > 0
    ? this.masterBars[0].tempoAutomations[0].value : 120
}
```

The tempo really lives in `masterBar.tempoAutomations`, and **a score can carry
many of them**. A real `.gpx` test file held five, two of them in the same bar.
So "change the tempo" is ambiguous, and the answer this app picked is to scale
them all by the ratio the user asked for on the initial tempo, preserving the
author's tempo map. The first automation is then forced to the exact typed value,
because that is the one the getter reads.

Values are rounded to **two decimals, not to integers**: files really do carry
fractional tempi (119.97 in one file) and multiplying produces float noise like
`179.94899999999998`. Rounding to integers would quietly rewrite the author's map
on every edit.

`score.finish()` guarantees `masterBars[0]` has a `Tempo` automation at ratio
position 0, so there is always something to write.

One consequence worth its own line, because it is silent and it bites the moment
bars can be inserted: **a new first bar with no tempo automation drops the whole
score to 120.** Measured - a score reading 168 read back 120 after a bare
`MasterBar` was put at index 0. So `insertBarBefore` moves the automations onto
the new first bar, and `deleteBars` moves them onto the survivor when the first
bar is what went (unless that survivor has a tempo change of its own, in which
case it really is the tempo there).

## 2. String numbering is inverted relative to storage

```js
static getStringTuning(staff, noteString) {
  if (staff.tuning.length > 0)
    return staff.tuning[staff.tuning.length - (noteString - 1) - 1]
  return 0
}
```

`staff.tuning` is stored **highest string first** (`[62,57,53,48,43,38]`) while
`note.string` counts **up from the lowest string**. Verified on a real 7-string
file: string 1 -> 38, string 7 -> 62.

This is exactly the kind of inversion that produces a semitone-scrambled score
rather than an error, so every read in `scoreEdits.js` goes through one
`tuningForString()` helper, and a test asserts it agrees with alphaTab's own
`Note.getStringTuning()` on every string of every stringed staff.

Related: `Tuning.getPresetsFor()` returns **shared static instances**, so a new
`Tuning` object is always constructed rather than writing into
`staff.stringTuning.tunings`, which could corrupt the global preset table for the
rest of the session. And the preset lists thin out fast - 31 presets for 6
strings, 11 for 4, 6 for 5, exactly **one** for 7 and **none** for 8 - while
`Tuning.findTuning()` returned `null` for both test files' guitar tunings. The
tuning dropdown therefore always injects the staff's current tuning when no
preset matches, or a 7-string track would show a list the user cannot get back
to.

## 3. Tempo is exempt from the automation-overwrite gotcha

The mixer gotcha (setting `playbackInfo.program` is not enough, because the
file's `Instrument` automation wins) does **not** apply to tempo. `Beat.finish()`
strips Tempo automations out of `beat.automations` altogether:

```js
if (automation.type !== AutomationType.Tempo) validBeatAutomations.push(automation)
```

and the midi generator reads the tempo only from `masterBar.tempoAutomations`. So
unlike the program, tempo has exactly one write site.

## 4. A natural harmonic's pitch does not come from its fret

`realValue` is normally `fret + stringTuning - transpositionPitch`. But for
`HarmonicType.Natural`:

```js
if (this.harmonicType === HarmonicType.Natural)
  realValue = this.harmonicPitch + this.stringTuning - transpositionPitch
```

The fret is **absent from the formula**. Measured on a real file: `note.fret += 2`
left the note sounding at midi 55, while shifting the tuning by 2 moved it to 57.

Two consequences, and both would have shipped as silent corruption:

- **Moving frets is not a transposition** on a score with natural harmonics: every
  other note moves and they stay put.
- **Retuning while keeping the pitches cannot keep theirs**, because their pitch
  follows the tuning and no fret compensation reaches it.

Both fret-based operations therefore count them and refuse, pointing at the
tuning-based transposition, which handles them correctly. Artificial, pinch, tap
and semi harmonics are fine - `harmonicPitch` is simply added, so a fret shift
moves them by the same amount (all 37 harmonics in one `.gpx` were artificial and
behaved correctly). `staff.transpositionPitch` is likewise harmless: it is
subtracted from every note on the staff, so it cancels out of every delta.

### The other half: writing one, where 0 is a wrong answer

The same formula bites from the other side when a harmonic is **written** rather
than transposed. `harmonicValue` is a second field beside the fret, holding the
node, and `harmonicPitch` maps it to semitones. A fresh note has it at 0, 0 maps
to 0 semitones, and for a natural harmonic the fret is absent - so a natural
harmonic written without setting it sounds the **open string**. A plausible pitch,
silently wrong, and nothing in the model objects.

`harmonicPitch` also answers 0 for frets that have no node at all:

```
nodes:    3 4 5 6 7 8 9 10 12 14 15 16 17 19 22 23 24
no node:  0 1 2 11 13 18 20 21
```

So there is no value of `harmonicValue` that makes fret 11 a natural harmonic,
which is why writing one there is refused rather than approximated. The list is
`HARMONIC_FRETS`, and a test re-derives it from `harmonicPitch` so a library
change fails rather than corrupts.

Several nodes share one interval - 8, 17 and 22 all give three octaves - so the
mapping is many-to-one, and it is many-to-one because a node is a position as
well as a pitch: the same interval is reachable at up to four places along the
string. All seventeen are offered, and the reason for that is in
[the editing notes](editing.md#harmonics-the-node-is-a-second-field-beside-the-fret).

The table is also a set of RANGES rather than of values - anything in 4.1 to 5
gives two octaves - so a file can carry a node that is not one of the seventeen,
and `offeredHarmonicNode` resolves it by what it sounds.

One entry in it looks wrong, and is followed anyway: 22 answers +36, while
22 semitones is 2^(22/12) = 3.56, which is the seventh partial's node at 7/2 and
should sound +34. alphaTab both plays and draws from this table, so matching it is
what keeps the sound, the notation and the export agreeing.

## 5. `note.string` has a cached index beside it

`Beat` keeps a `noteStringLookup` Map of string -> note, filled by `addNote()`
and rebuilt only by `finish()`. Assigning `note.string` in place leaves it
pointing at the old string, and it is not decorative:

- `MidiFileGenerator` reads `beat.hasNoteOnString()` to decide where a let-ring
  stops;
- tie, hammer-on and slide resolution all go through `getNoteOnString()`.

Measured on the test fixture: moving 30 notes to another string with the naive
write left **all 30** unfindable on their own string. So `writeNoteString()`
updates the Map alongside every string write, and a test asserts the generated
midi note-ons come out **byte-identical** after moving every movable note across
the strings, on the fixture and on every real score handed to the opt-in suite.

Remove-and-re-add is **not** the fix: `addNote()` sets
`note.index = notes.length` and pushes, while `removeNote()` does not renumber
what is left, so a round trip through them corrupts `note.index` and reorders the
chord.

The sibling `noteValueLookup` (keyed on `realValue`) does go stale on a fret
change, but it is only consulted by `findTieOrigin` for notes that are **not**
stringed, and every operation here is on stringed notes.

## 6. Deleting a note leaves stale links that survive `finish()`

`Note` carries **eleven** fields pointing at another `Note`: `tieOrigin` /
`tieDestination`, `hammerPullOrigin` / `hammerPullDestination`, `slurOrigin` /
`slurDestination`, `slideOrigin` / `slideTarget`, `effectSlurOrigin` /
`effectSlurDestination`, and `bendOrigin`.

`Note.finish()` looks like it heals a broken tie:

```js
const tieOrigin = this.tieOrigin ?? Note.findTieOrigin(this)
if (!tieOrigin) this.isTieDestination = false
```

but the `??` short-circuits on a **stale** reference, so a tie whose origin was
deleted keeps that deleted note as its origin. Measured on a real `.gpx`: deleting
20 linked notes without a sweep left **34** dangling references alive after
`finish()`, and the generated midi differed (7184 note-ons against 7186) because a
tie to a deleted note kept extending a duration. Nothing crashed, in either the
renderer, the midi generator or the exporter - which is exactly why this needed a
test rather than trust.

So `deleteNotes()` does three things beyond the removal, and all three are silent
corruption if skipped:

1. **Renumbers `note.index`.** `addNote` sets it to `notes.length` and
   `removeNote` does not renumber, so deleting note 0 of three leaves the
   survivors at index 1 and 2. `MidiFileGenerator` reads `note.index === 0` to
   decide where to generate a beat's whammy bar, so a beat could lose its whammy
   entirely.
2. **Nulls every link to a removed note**, as a full sweep of the score rather
   than by following the victims' back-references: several of those fields have
   no inverse (`bendOrigin` for one), so only walking everything is provably
   complete. Measured at 12ms over 7295 notes.
3. **Calls `score.finish()`**, to rebuild the per-beat `noteValueLookup` and
   re-resolve or clear the links that just lost their target. Measured at 12ms on
   the same file, so ~24ms for a delete on the largest test score.

## 7. `playbackDuration` is stale until `finish()`

`beat.duration` is the **input**; `playbackDuration` and `displayDuration` are
**derived** from it, and nothing recomputes them on assignment:

```
set beat0 to Duration.Whole
  BEFORE finish() : playbackDuration = 960    (the value from before)
  AFTER  finish() : playbackDuration = 3840
```

So any reading of how long a beat really is - which is every calculation of how
full a bar is - has to come after `finish()`, or recompute the value itself from
`duration`, `dots` and the tuplet. `barFill()` reads
`voice.calculateDuration()`, which sums `playbackDuration`, so a fill read
between a duration change and `finish()` reports the bar as it was.

This is now on the **live path**: `+` and `-` change a beat's duration on every
press, and the bar-fill counter beside them is reading `playbackDuration`. So
every write in the writing tier ends in `score.finish()`, and the swap that
undoes it finishes too - a swap that only put the field back would leave the
counter reporting the bar as it was.

What that costs, measured on the real files rather than guessed: **0.9-3.4ms**
per keystroke for the whole operation, finish included (77 bars / 4314 beats and
118 bars / 7424 beats), with an occasional first call up to 9.7ms. The plan that
designed this tier budgeted 16ms and treated it as the main risk; 16ms is the
**cold** first call on a freshly imported score, and `finish()` is idempotent
and much cheaper after it - the same 16ms / 9.5ms / 6.2ms decay measured further
down this page. The risk was real and turned out to be small.

## 8. An overfull bar passes through the whole chain in silence

```
capacity 3840 ticks, filled 6720  ->  OVERFULL
export to .gp and re-import       ->  fine
```

Not the model, not `finish()`, not `MidiFileGenerator`, not `Gp7Exporter`: none
of them objects to a bar holding more than its time signature allows. It renders,
it plays, and it is written to the file exactly as it is.

So the red rectangle on the score and the counter in the action bar are not a
convenience. They are the **only** thing in the stack that will ever say a bar is
invalid, which is why they were built before anything that can create one.

Two details worth keeping:

- **Three states, not two.** A bar being written into is *incomplete* for most of
  its life, so marking that red would paint the whole score red. Only the
  overflow is coloured.
- **The tick arithmetic drifts downwards on tuplets.** Seven sixteenth-septuplets
  measure 137 ticks each, so 959 where a quarter note is 960. The comparison
  therefore carries a tolerance of one tick per beat, which is the exact bound on
  that truncation rather than a fudge factor. Measured across 17 real files and
  11682 bars with that tolerance in place: exactly **one** bar came out overfull
  (a 2/4 bar holding 2880 ticks against 1920) and one incomplete, both genuine.

## 9. `BarBounds.bar` is empty in the browser, and full in your tests

The one that cost the most, because everything was green while three features
were dead on screen.

alphaTab renders in a **worker** by default (`core.useWorkers` is true) and posts
the bounds lookup back as JSON. `BoundsLookup.fromJson` rebuilds each `BarBounds`
with its two rectangles and its beats, and never assigns `bar`:

```js
const b = new BarBounds();
b.visualBounds = BoundsLookup._boundsFromJson(bar.get("visualBounds"));
b.realBounds   = BoundsLookup._boundsFromJson(bar.get("realBounds"));
mb.addBar(b);            // <- no b.bar anywhere, and toJson() never wrote one
```

Rendering synchronously through `ScoreRenderer` - which is what a Node test does,
because it is the only way to reach a lookup without an `AlphaTabApi` and a DOM -
keeps the field. So `barBounds.bar` is a `Bar` in every test and `undefined` in
the app.

What that silently broke: the string a click resolves to (always null, so half
the score placed a cursor with no string), the cursor rectangle on a tablature
(never drawn), and the red outline on an overfull bar (never found). No error
anywhere - each one just read `undefined?.staff` and took the empty branch.

`BeatBounds.beat` **is** restored, resolved back out of the score by track /
staff / bar / voice / beat index, and so is `NoteBounds.note`. So the beat is the
reliable route to the model:

```js
const bar = barBounds?.bar ?? barBounds?.beats?.[0]?.beat?.voice?.bar ?? null
```

The lesson beyond this field: **a test that renders through `ScoreRenderer` is
not testing the lookup the app gets.** `scoreGeometry.test.js` now runs every
assertion twice, once against the direct lookup and once against
`BoundsLookup.fromJson(direct.toJson(), score)`, which is exactly the shape the
worker delivers.

## 10. alphaTab re-applies its own selection after every render

`_onPostRenderFinished` ends with this, in 1.8.4:

```js
if (this._selectionStart) this.highlightPlaybackRange(this._selectionStart.beat, this._selectionEnd.beat);
```

So alphaTab keeps a selection of its own, and re-asserts it - band and
`playbackRangeHighlightChanged` event - on **every** render, not just when the
user drags. Clearing your own copy does nothing to it.

That surfaced as a selection coming back from the dead. Pressing an arrow moved
the cursor and dropped the range; the next edit called `api.render()`; the echo
fired with the old beats; the handler rebuilt the range from it and wiped the
cursor. From the outside, a note moved and then the passage re-selected itself a
moment later.

Neither obvious escape works on its own:

- `clearPlaybackRangeHighlight()` only calls `_cursorSelectRange(undefined,
  undefined)`. It erases what is drawn and leaves `_selectionStart` set, so the
  next render puts it straight back.
- `playbackRange = null` goes through `_updateSelectionCursor`, which does the
  same thing, and likewise never touches `_selectionStart`.
- `applyPlaybackRangeFromHighlight()` *does* clear it, in the branch where the
  start and end beats are the same - but it also sets `tickPosition`, so it
  seeks. An arrow key has no business moving the playhead.

What works is collapsing the selection onto ONE beat with
`highlightPlaybackRange(beat, beat)`, then calling
`applyPlaybackRangeFromHighlight()`. `_cursorSelectRange` draws nothing when the
two beats are equal, so the band goes immediately, and the same-beat branch of
`apply` then clears `_selectionStart` and the playback range outright, so there
is nothing left for the echo to replay. Public API throughout.

The seek that branch performs turned out to be wanted rather than a cost - the
playhead following the edit cursor is the behaviour, not a side effect - but it
is gated on being paused, since seeking under a running transport would make
navigating during playback impossible.

One trap in doing it: that call fires the very event that handles it, so the
clear-down needs a re-entrancy guard or it recurses until the stack goes.

### And it leaves HALF a selection, which alphaTab cannot survive

The same-beat branch of `apply` clears `_selectionStart` and **leaves
`_selectionEnd` set**. That pair is a state alphaTab never produces itself, and
two of its own methods read the pair without checking it:

```js
applyPlaybackRangeFromHighlight() {
  if (this._selectionEnd) {
    const startTick = ... this._selectionStart.beat ...        // no start check

_cursorSelectRange(startBeat, endBeat) {
  if (!startBeat || !endBeat || ...) { trigger({}); return }   // draws nothing

_onPostRenderFinished() {
  if (this._selectionStart) this.highlightPlaybackRange(..., this._selectionEnd.beat)
                                                              // no end check
```

**This is what broke click-and-drag**, and it took a browser to find because the
whole gesture matters and the test double was kinder than the real thing. The
sequence:

1. mousedown records the start and clears the end.
2. Our deselect microtask runs - *between the mousedown task and the first
   mousemove task*, on every single press - and does the clear-down above, which
   ends with no start and an end.
3. every mousemove then calls `_cursorSelectRange` with no start, so **nothing
   is ever drawn** and the range event arrives empty.
4. mouseup calls `apply`, the end is set, the start is not:
   `TypeError: can't access property "beat", this._selectionStart is undefined`.

The fix is a rule rather than a patch: **while the mouse is down on the score,
alphaTab owns its selection.** `beatMouseDown` and `beatMouseUp` are public
events, so the clear-down simply stands down between them - and nothing is lost,
because alphaTab's own mouseup already seeks to the beat that was pressed and
clears its selection cleanly afterwards. The clear-down is only ever needed for
cursor moves that come from the keyboard, which is where the resurrection
happened in the first place.

Two smaller lessons in the same bug. Replacing `_selectionStart` with a beat from
**our** hit-test is wrong even when it does not crash: ours reads Y and
alphaTab's `findBarAtPos` reads X only (gotcha 9), so on a multi-track score they
need not agree, and a drag would silently start from a different beat than the
one pressed. And a keyboard clear-down should end with a second
`highlightPlaybackRange(beat, beat)`, which restores the pair - invisible,
because equal beats draw nothing - so the state the render echo reads is never
half either.

## 11. Nothing can be removed from the model, and only beats get renumbered

Three asymmetries in one, all verified in Node, and together they are the shape
of every structural undo in the writing tier.

**`Voice.insertBeat` does not set `index`.** It links `nextBeat` / `previousBeat`
and splices the array, and leaves the list numbered like this:

```
before insert : 0,1,2,3
after  insert : 0,1,0,2,3      <- the new beat carries index 0
after  finish : 0,1,2,3,4
```

`Voice.finish()` is what renumbers, which is why a beat insertion has to finish
even though nothing about it changed a duration. `MidiFileGenerator` and the
renderer both read `beat.index`.

**There is no `removeBeat`, no `removeBar` and no `removeMasterBar`.** `Voice`
has `addBeat` and `insertBeat`, `Bar` has `addVoice`, `Staff` has `addBar`,
`Score` has `addMasterBar` - and no inverse for any of them. So an undo splices
the array itself and cuts the links the `add` wrote:

```js
voice.beats.splice(at, 1)
if (previous) previous.nextBeat = next
if (next) next.previousBeat = previous
score.finish(settings)
```

**But `Bar.index` and `MasterBar.index` are never renumbered.** `addBar` and
`addMasterBar` set them from the current length, and no `finish()` touches them
again - only `Voice.finish` renumbers, and only beats. That is why adding a bar
is **append-only** here: at the end of the score the indexes stay right for free,
where an insertion in the middle would need a renumbering pass over every staff
plus `rebuildRepeatGroups()`, and would silently leave `firstChangedMasterBar`
hints pointing at the wrong bar until it did.

`score.rebuildRepeatGroups()` is the one part with no mirror image:
`addMasterBar` files a bar into the open repeat group, and removing a bar from
the middle of a group has no inverse. Rebuilding the groups from what is left
does.

**And `masterBars[0].start` is not recomputed either.** `MasterBar.finish` does
it only `if (this.index > 0)`:

```js
if (this.index > 0) this.start = this.previousMasterBar.start + this.previousMasterBar.calculateDuration();
```

So a new FIRST bar keeps whatever start it had. Measured on the fixture: deleting
bar 0 left the bars starting at 3840, 7680, 11520 and the first beat's
`absolutePlaybackStart` at 3840. Nothing throws, and the midi generator still
emits its first note at tick 0 - but `absolutePlaybackStart` is what the drag
selection and the loop range are built from, so selecting a passage was quietly
broken after the first bar of a score was deleted. `renumberBars` sets it to 0
by hand, before the finish.

**One more, for bars that are SPLICED rather than appended: `bar.staff` is set by
`Staff.addBar`, so splicing straight into `staff.bars` leaves it undefined.** The
first thing that reads it is `Beat.finish`, which throws
`Cannot read properties of undefined (reading 'index')` on
`this.voice.bar.staff.index` - a stack trace inside alphaTab with nothing in it
about the field that was missing. The same goes for `masterBar.score`, which
`Score.addMasterBar` sets.

## 12. A midi rebuild silently drops the playback range

`api.playbackRange` is not a value alphaTab keeps of its own. The getter reads
straight through to the synth:

```js
get playbackRange() { return this._instance.playbackRange }      // AlphaSynth
get playbackRange() { return this.sequencer.mainPlaybackRange }  // the synth
get mainPlaybackRange() { return this._mainState.playbackRange } // the sequencer
```

And loading a midi file replaces that state object outright:

```js
loadMidi(midiFile) {
  this._mainState = this.createStateFromFile(midiFile);   // 1.8.4
  this._currentState = this._mainState;
}
```

So **the loop range is gone after any rebuild** - and because the state is
replaced rather than assigned through the setter, no `playbackRangeChanged` fires
to say so. Nothing throws, nothing logs.

What it looked like, and why it took a user to find: select a passage, palm mute
it, press play. The sound runs past the end of the selection as though nothing
were selected, while the playhead still stops at its edge. Not specific to the
palm mute either - every `onPlay` edit rebuilds at the moment playback starts and
every `now` edit rebuilds immediately, so all of them lost the range. Only an
edit followed by a play shows it, which is why the earlier work never did.

The fix is to save the range with the tick and the playing state, and put all
three back in the `midiLoaded` handler. **The order matters**, and it is the
reason that restore is a function of its own with a test: alphaTab's setter has a
side effect -

```js
set playbackRange(value) {
  this.sequencer.mainPlaybackRange = value;
  if (value) this.tickPosition = value.startTick;
```

so a tick restored before the range is thrown away, and the playhead lands at the
start of the selection instead of where it was.

## And one non-gotcha: `finish()` is not needed after the OTHER edits

`score.finish()` is idempotent - measured on a 118-bar score at 16ms, then 9.5ms,
then 6.2ms, with beat and note counts unchanged - but all it recomputes is
structure, durations and cross-note links, and none of the value-based edits
changes any of those. So the callers in `scoreEdits.js` are exactly the ones that
touch structure or a duration: `deleteNotes` (gotcha 6) and every function of the
writing tier. A fret, a string, a tuning, a transposition and a tempo still need
none.

One asymmetry inside that, which is why writing a note captures much less state
than deleting one: `finish()` **creates** links as well as clearing them, but
only for a note whose `tieOrigin` is already null (`this.tieOrigin ??
Note.findTieOrigin(this)`). Deleting can produce that state, so the delete has to
capture everything `finish()` derives for the whole affected staff. Adding cannot,
so the add's undo is just the removal. That argument is pinned by a test rather
than trusted: the fixture's Ties track carries ties, hammer-ons and a slide, and
the whole link graph plus the generated midi is compared across an add and its
undo.

## alphaTab escapes your stacking context

alphaTab sets `z-index: 1` on every rendered page placeholder and `z-index: 1000`
on its cursor wrapper. It also sets `position: relative` on its canvas element
but **no** `z-index`, so that canvas is not a stacking context and both values
escape into whatever context encloses the player.

The visible consequence: the score painted straight through the empty-state
dropzone, so closing a score showed the drop target as a transparent panel over
the score that was supposedly gone. The track panel (`z-index: 2`) was latently
vulnerable to the cursor layer for the same reason.

The fix is one line in
[styles/components/ScoreViewer.scss](../src/styles/components/ScoreViewer.scss):
`isolation: isolate` on the scroll container, which turns it into a stacking
context and confines alphaTab's z-indexes to it. Anything overlaying the score
then wins by ordinary DOM order.

Related: closing a score does **not** unload it from alphaTab. There is no API
for that - `renderTracks([])` is a no-op, alphaTab ignores an empty array - so
the surface is hidden with `visibility: hidden` (not `display: none`, because
alphaTab measures that element's width) and the score is simply replaced on the
next load.

## The model-side mixer gotcha

alphaTab has live setters for volume, mute, solo and transposition, but **not**
for the midi program or the balance. Those two are only read while the midi is
generated from the score, so changing them means editing the model and calling
`api.loadMidiForScore()`. Both live in
[src/utils/trackSound.js](../src/utils/trackSound.js).

Two consequences for panning specifically: `balance` is `0-16` with `8` = centre
(alphaTab emits it as MIDI `PanCoarse` = `balance * 8`, clamped to 127, verified
at both extremes), and because each change rebuilds the midi, the slider must not
commit on every `input` event of a drag.

Setting `track.playbackInfo.program` is **not** enough to change a track's sound.

Guitar Pro files carry a mixer snapshot as an `AutomationType.Instrument`
automation on the first beat of each track. alphaTab's midi generator emits that
automation as a second `ProgramChange` at tick 0, right after the one derived
from `playbackInfo` - so the original sound wins.

Reproduced with `MidiFileGenerator` on a real `.gp` file, setting track 0 to
program 73 (Flute) with the automation untouched:

```
tick=0 ch=2 prog=73     <- from playbackInfo
tick=0 ch=3 prog=73
...
tick=0 ch=2 prog=27     <- from the Instrument automation, wins
tick=0 ch=3 prog=27
```

`applyTrackProgram()` in [src/utils/trackSound.js](../src/utils/trackSound.js)
therefore rewrites `playbackInfo.program` **and** every `Instrument` automation
on the track. With that patch the duplicate events are gone.

Two consequences worth knowing:

- A genuine mid-song instrument change written into the score is overwritten
  too. That is intentional: the user picked one sound for the whole track.
- The midi is generated from the data model on demand, so the change only takes
  effect after `api.loadMidiForScore()`. That call **stops playback** by design,
  so `usePlayer` records the tick position and the playing state first and
  restores both in the `midiLoaded` handler.
