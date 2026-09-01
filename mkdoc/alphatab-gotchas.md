# alphaTab gotchas


All nine were found by running code against alphaTab **1.8.4**, not by reading
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

Nothing in this app changes a duration yet, so this is not on any live path -
but a test pins it, because it is the trap waiting for the first one that does.

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

## And one non-gotcha: `finish()` is not needed after the OTHER edits

`score.finish()` is idempotent - measured on a 118-bar score at 16ms, then 9.5ms,
then 6.2ms, with beat and note counts unchanged - but all it recomputes is
structure, durations and cross-note links, and every operation except the delete
changes none of those. So `deleteNotes()` is the single caller in
`scoreEdits.js`, for the reasons in gotcha 6. Adding or removing beats or bars would
need it too.

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
