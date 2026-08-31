# AlphaTab Viewer

A minimal, fully client-side score viewer, player and light editor built on
[alphaTab](https://alphatab.net/). Drop a Guitar Pro or MusicXML file, choose
which tracks are displayed, change the MIDI instrument each track is played
with, and make a handful of targeted edits - rename, retune, transpose, tempo,
one note's fret - then save the result as a `.gp` file.

No backend, no account, no game layer. Nothing is uploaded and nothing is
written to your files: the edited score is handed back as a download. The only
thing persisted is the master volume (`localStorage`).

Extracted from the `alphatabrpg` project: the design system (`src/styles/`), the
Bravura font and the SONiVOX SoundFont come from there; the player logic is new.

---

## Prerequisites

- **Node.js >= 20.19** (or >= 22.12) - required by Vite 7
- **npm >= 9**

## Install and run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build     # -> dist/
npm run preview
npm test          # vitest, Node only, no browser
npm run test:watch
```

> Stay on Vite 7. Vite 8 (rolldown) breaks `@coderline/alphatab-vite@1.8` with a
> `Missing field moduleType` error.

## Supported files

`.gp` `.gp3` `.gp4` `.gp5` `.gpx` `.xml` `.musicxml`

Drop anywhere in the window, or click the dropzone to browse. Parse failures are
reported through alphaTab's `error` event and shown as a banner.

---

## Features

**Track display** - clicking a track name shows that track alone; its checkbox
adds it to the current view alongside the others. `All` renders everything. At
least one track must stay displayed, since alphaTab needs a non-empty selection,
so the last remaining checkbox is disabled. alphaTab renders only the first track
on load, and the checkboxes are seeded from what it actually rendered.

Clicking a name that is already the sole displayed track returns early rather
than re-rendering: it is the primary click target now, and re-laying out a score
is expensive.

**Sound per track** - a `<select>` of the 128 General MIDI programs, grouped by
family, in the **Track** tab. Percussion tracks show a static label instead:
percussion plays on MIDI channel 10 and is not addressed by a program number.
The Mixer tab shows the current instrument as a read-out.

**Mixer per track** - solo, mute, volume (0-200%) and panning (L8 to R8), on two
aligned rows. Independent of what is displayed: every track is audible whether it
is on screen or not.

Solo, mute and volume use alphaTab's live setters (`changeTrackSolo`,
`changeTrackMute`, `changeTrackVolume`) and apply instantly. Panning has **no**
live setter, so it goes through the data model and a midi rebuild; the slider
previews while dragging and commits once on release. See the gotcha below.

**Collapsible sidebar, three tabs** - `Mixer`, `Track`, `Score`, named for the
scope each one acts on. `Mixer` rather than `Tracks`, because "Tracks" next to
"Track" reads as the same thing.

Tabs rather than a stack: the sidebar is 290px wide and the track list is
arbitrarily long, so a panel below it would be unreachable on a nine-track score.
The tab strip also owns the collapse control, since it acts on the container all
three panels sit in. The tabs are toggle buttons with `aria-pressed`, not
`role="tab"`: a real tablist promises arrow-key navigation and an `aria-controls`
/ `role="tabpanel"` pairing, and a half-implemented one is worse for a screen
reader than an honest set of toggles. The panel slides out of the way and
collapses to a 30px rail carrying the reopen control, labelled with the panel it
will reveal, so it never disappears without a way back. The slide animates the
panel's `transform` only; see the note below on why the layout itself must not be
animated.

The panels are toggled with `v-show`, not `v-if`: switching tabs must not throw
away a half-typed name or a chosen tuning, and none of them is expensive enough
to unmount.

`ScoreEditPanel` and `TrackEditPanel` are two components with one visual
language, so their shared pieces are `edit-*` **mixins** in `_mixins.scss` rather
than copied rules. Mixins, not a shared rule block: that partial must never emit
CSS, since every SFC style block is its own Sass compilation unit and a rule
placed there would be duplicated into all of them.

**Transport** - play/pause, stop, scrub bar, playback speed (0.25x-2x), master
volume, loop, metronome, all in the top action bar. Space is play/pause from
anywhere on the page. Clicking a beat in the score seeks to it
(`enableUserInteraction`).

**Editing** - split across two sidebar tabs, by the SCOPE each one acts on:

- **Track** edits one track: its name, instrument, tuning, transposition, and the
  selected note.
- **Score** edits the document: the tempo, plus saving and reverting.

That split is the point. A tempo field sitting between a track's name and its
tuning invited the reader to think tempo was a track property.

The third tab, **Mixer**, is deliberately NOT editing: it chooses what is
displayed and mixes what is heard, and **none** of it is written into the score.
The one exception used to live there and moved out - the instrument picker, since
a program number IS saved. The mixer still shows each track's instrument as a
read-out, so the overview survives.

Seven operations, all on the track selected in the Track tab (clicking a note in
the score selects its track too):

| Operation | What it writes |
| --- | --- |
| Rename a track | `track.name` and `track.shortName` |
| Instrument | `playbackInfo.program` + the `Instrument` automations |
| Tempo | every `masterBar.tempoAutomations[].value`, proportionally |
| Transpose, keep the fingering (`Detune`) | `staff.stringTuning` |
| Transpose, keep the tuning (`Move frets`) | `note.fret` on every note |
| Retune, `Keep pitches` / `Keep frets` | `staff.stringTuning`, and the frets in the first mode |
| Notes across the strings | `note.string` + `note.fret`, via the buttons or `Alt` + up/down |
| Notes by a semitone | `note.fret`, via the buttons or `Alt` + `Shift` + up/down |
| Notes replaced by silence | removes them from their beats, via `Silence` or `Suppr` / `Delete` |

Then `Save .gp` downloads the result - or **`Ctrl+S`** / **`Cmd+S`**, which
deliberately takes the key from the browser's "Save page as" - and `Revert`
reloads the file exactly as it was opened.

Those two note-level moves work on **one note or a whole passage**. Click and
drag across the score - the same gesture that sets alphaTab's loop range - and
Alt+arrow acts on every note in it. The two selections exclude each other: a drag
drops the single note, a click drops the range.

A batch is **all or nothing**. If one note of twelve would run off the neck, the
whole selection is refused with the numbers, because a passage where nine notes
moved and three stayed is not a re-fingering of anything. And unlike the
single-note case the refusal is loud: with twelve notes selected there is no
guessing which one blocked it, and a repeated key will not walk out of it.

The two note-level moves are deliberately different things, and the keyboard says
which is which:

- **`Alt` + up/down** moves the note to the **adjacent string**, keeping the
  pitch: the fret changes to compensate, so the score sounds identical and only
  the fingering moves. Up goes to the higher-pitched string, which is also the
  higher line on the tablature, so the note moves the way the key points.
- **`Alt` + `Shift` + up/down** is the one that **changes the pitch**, by a
  semitone, on the same string.

Both repeat when held, and both refuse silently at the edge of the fretboard,
because a message per press on a repeatable key is noise. Every other refusal (an
occupied string, a fret that would land off the neck, a natural harmonic) is
explained in the panel.

Whatever is selected is **ringed on the score**, once per staff it is drawn on
(the note head on the standard staff and the fret number on the tablature), so
there is never a doubt about what an edit will touch. One rule: **a ring means
this note will be edited**. Clicking a bar rather than a note clears it. See the
note on how, below.

Changing the pitch also **sounds the note**, so a semitone nudge can be checked
by ear - for a range, the beat it starts on, since playing forty notes at once
would be noise. The string move stays silent, and that asymmetry is the point: it
keeps the pitch, so there would be nothing new to hear.

**Editing is only allowed while paused.** Rather than making every operation
survive being applied mid-playback (a moving playhead, a midi rebuild that stops
the sound, a preview note fighting the score), the whole panel stands down and
says why. Selecting a note still works while playing, since it writes nothing.

Two design rules run through all of it:

**An operation that cannot be applied is refused, with numbers, never clamped.**
Moving frets down by one when the lowest note already sits on fret 0 does not
quietly leave those notes at 0 - it refuses and says so. A transposition that
clamps some of its notes is not a transposition, and there is no undo to get back
from one.

**No component writes to the alphaTab model.** Every write lives in
[src/utils/scoreEdits.js](src/utils/scoreEdits.js) as a pure named function that
takes the model and returns what happened; `useScoreEdit` decides what the write
invalidates; the panel renders flat reactive data. That is also what keeps an
undo stack possible later without touching the UI - each function is already a
command and would only need its inverse.

**`Suppr` / `Delete` replaces the selection with silence.** A note becomes
silence by being removed from its beat, and the duration takes care of itself:
`Beat.isRest` is a getter over `notes.length === 0` and `beat.duration` is
independent of its notes, so emptying a beat turns it into a rest of exactly the
same length. A beat that still holds other notes keeps sounding them, so deleting
one note of a chord silences that note, not the chord.

It is the **only edit with no way back except `Revert`**: a transposition can be
transposed back, but a deleted note's fret, effects and links are gone. There is
deliberately no confirmation - asking every time would make it useless for one
note, and a threshold on the count would be arbitrary - and `isDirty` already
warns before the score is replaced or closed.

**Deliberately out of scope for this tier:** entering notes, adding or removing
bars, undo, changing the number of strings, and any validation of note
durations.

### What is NOT saved with the score

This is what the tab split encodes. The transport's **playback speed** and the
**master volume** are listening preferences and are never written to the model,
and neither are the Mixer tab's **volume**, **mute** and **solo**. Everything in
the **Track** and **Score** tabs is written into the score and goes out with the
file.

One control sits on the wrong side of that line and stays there: **panning** is
in the Mixer tab but IS model-side and does get saved, because alphaTab has no
live setter for it - see the mixer gotcha below.

---

## Architecture

```
src/
  main.js                    app entry, imports styles/main.scss
  App.vue                    layout: sidebar (Mixer | Track | Score tabs) + stage
  composables/
    usePlayer.js             the single alphaTab instance + all app state
    useScoreEdit.js          selection, isDirty, the render/midi propagation
    useShortcuts.js          page-wide keys (Space, Alt + up/down)
  components/
    ScoreViewer.vue          owns the alphaTab host + scroll wrapper, calls init()
    ScoreHeader.vue          document strip: title / artist / tempo / bars + close
    TrackList.vue            "Mixer": display checkboxes, solo/mute/volume/pan
    TrackEditPanel.vue       "Track": name, instrument, transpose, tuning, note
    ScoreEditPanel.vue       "Score": tempo, save, revert
    TransportBar.vue         play, stop, scrub, speed, volume, loop, click (in the action bar)
    BarsPerRow.vue           force a fixed number of bars per system
    FileDropzone.vue         window-wide drag & drop + file picker
  styles/
    main.scss                :root custom properties + element resets (global)
    _tokens.scss             SCSS spacing / radius / transition scale
    _mixins.scss             panel-card, button-base, section-label, ...
    components/*.scss        one file per component, one-to-one by name
  utils/
    gmPrograms.js            the 128 GM programs and their 16 families
    trackSound.js            applyTrackProgram() - see the gotcha below
    scoreEdits.js            every model write for the editing features
    exportScore.js           Gp7Exporter -> Blob -> download
    format.js                formatTime()
test/
  fixtures/make-sample.mjs   regenerates sample.gp; the readable source of truth
  fixtures/sample.gp         6 tracks chosen to make every refusal fire
  helpers.js                 load / round-trip / snapshot a score in Node
  scoreEdits.test.js         the model writes, against the fixture
  noteSelection.test.js      why selection needs core.includeNoteBounds
  useShortcuts.test.js       which key combination resolves to which action
  exportScore.test.js        filenames and the .gp round trip
  useScoreEdit.test.js       the propagation matrix and the selection
  realScores.test.js         invariants against your own files (opt-in)
```

### Tests

`npm test` runs entirely in Node - no browser, no `AlphaTabApi`, just the
importer, the model and the exporter. Every edit is asserted through an export to
`.gp` and a re-import, because an edit that does not survive a save is not an
edit.

The committed fixture is generated, not hand-picked, so what is in it is readable
rather than binary: see the header of
[test/fixtures/make-sample.mjs](test/fixtures/make-sample.mjs). Its six tracks
exist to make every refusal and every cleanup path fire - a 7-string track whose
frets are already against both bounds, a 4-string bass with a different string
count, a track carrying natural harmonics, a percussion track, and a track of
ties, hammer-ons, a slide and a chord for the delete sweep to clean up.

To check the same invariants against real scores, without committing anyone's
music to the repo:

```bash
ALPHATAB_SCORES="/path/to/a.gp:/path/to/b.gpx" npm test
ALPHATAB_SCORES="/path/to/a/folder" npm test
```

That suite makes no assumption about track order, string counts or fret windows.
It is skipped, not failed, when the variable is unset.

Not covered by any test, and needing a browser: whether the incremental render is
visibly faster on a large score, and how a held `Alt`+arrow feels.

### Styling rules

**No CSS lives in a `.vue` file.** Each component links its stylesheet and
nothing more:

```vue
<style scoped lang="scss" src="@/styles/components/TrackList.scss"></style>
```

Scoping is preserved, so `:deep()` still works for reaching alphaTab's own
`.at-*` classes.

### Visual language

Two rules, both encoded as tokens so they cannot drift:

**Structure is square, interaction is round.** `$radius-block` is `0` and
`$radius-control` is `0.3rem`; there is deliberately no general-purpose "medium
radius". Panels, bars, the score surface and list rows have hard corners so
their 1px borders read as delimiters. Anything clickable or draggable is
rounded. One documented exception: the collapsed `.rail` is a button but reads
as a structural edge of the workspace, so it stays square.

**Two colour zones.** `--chrome-*` is the dark navy action bar; everything else
is the light working area. Every token is named for what it is *for*, never for
what it looks like, so re-theming means editing the `:root` block in
`styles/main.scss` and nothing else.

**`_tokens.scss` and `_mixins.scss` must never emit CSS** - only variables,
mixins and `@forward`. Every SFC style block is its own Sass compilation unit,
so a rule placed in a shared partial is duplicated into all of them. Measured
with a probe rule: it came out 7 times, once globally and once scoped per
component. That is also why `styles/main.scss` is imported from `main.js`
rather than merged into a partial.

### Never animate the score's width

alphaTab re-lays out the entire score whenever its container width changes. The
re-render is debounced by `resizeThrottle`, which is **10ms**, and alphaTab's
`throttle` helper is really a debounce (it clears and resets the timer on every
event). Animation frames are ~16.7ms apart, so the timer expires *between* every
frame: transitioning the score container's width triggers a full re-layout on
each frame of the animation.

This is why the track panel is absolutely positioned and slides via `transform`
while `.stage`'s `margin-left` changes in a single un-transitioned step. alphaTab
re-lays out once per toggle instead of ~15 times.

### `usePlayer()` is a module-level singleton

State lives at module scope rather than in a store: `ScoreViewer.vue` owns the
host element and calls `init()`, every other component calls `usePlayer()` and
reads the same refs. `ScoreViewer` stays mounted even before a file is dropped,
because `loadFile` needs a live api and alphaTab needs a laid-out host element
to measure against. The empty-state dropzone is an overlay on top of it.

**The alphaTab `Score` / `Track` / `Note` objects are never put into a reactive
ref.** They are large cyclic graphs (score -> tracks -> staves -> bars -> voices
-> beats -> notes, with parent back-references); deep-proxying them would be slow
and would risk breaking alphaTab internals. They live in plain variables, and the
UI reads flat descriptors instead - `tracks` for the panels, `selectedNote` for
the note inspector.

`useScoreEdit` needs three things `usePlayer` keeps module-private: the api, the
raw `Track` objects, and the `pendingRestore` dance that puts the playhead back
after a midi rebuild. They are reached through one explicit named export,
`scoreEditHost`, rather than by duplicating the restore logic in a second
composable or widening the public `usePlayer()` surface with model internals no
component may touch.

The note-selection handlers are keyed on the **api instance**, not on a boolean
latch: `ScoreViewer` calls `destroy()` on unmount and `init()` on mount, so a new
`AlphaTabApi` is a real possibility (a hot reload is enough), and a latch would
leave the selection silently dead against an api nobody is listening to.

### Note selection needs `core.includeNoteBounds`, which defaults to false

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

### Sounding a note, and when the midi gets rebuilt

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

### Selecting a passage costs no new interaction code

alphaTab already builds and draws a click-and-drag selection for its loop range.
`playbackRangeHighlightChanged` hands it over as it happens, with `startBeat` and
`endBeat` as real `Beat` objects, so the range needs no mouse handling at all.

Three details make it usable:

- A plain click fires the event with **empty args**. `_cursorSelectRange`
  triggers `{}` when the start and end beats are the same, which is exactly what
  distinguishes a click from a drag.
- alphaTab **normalises the order** itself, so `startBeat` is always the earlier
  one and a right-to-left drag needs no special case.
- The range is turned into a **tick window** on the track the drag STARTED on,
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

### Two selection visuals, two jobs

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

### Marking the selected note

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
  behaviour documented above, seen from the other side.
- A render **rebuilds** the bounds lookup, so the rectangles have to be re-read
  from it afterwards. One `postRenderFinished` handler covers every path at once:
  an edit, a track change, a resize, a bars-per-row change.

A test pins the whole reverse path against a real headless render: two rectangles
for a note on a score+tab staff, at two different vertical positions, and
clicking the centre of each finds the same `Note` back.

### Keyboard shortcuts declare their own modifiers

`useShortcuts` used to drop **every** modifier combination globally
(`if (event.ctrlKey || event.metaKey || event.altKey) return`), which was right
while Space was the only binding but makes `Alt` + arrow impossible. The
exclusion is now per binding: each entry declares which of Alt, Ctrl and Meta it
wants, matched exactly. Space still refuses to fire under Ctrl or Alt, because it
declares none - lifting the restriction for one binding does not open the others
to combinations that belong to the browser or the OS.

Shift is **opt-in** rather than always matched: it is a shifting modifier rather
than a command one, and requiring its absence everywhere would silently break
Shift+Space for no benefit. But the two arrow pairs genuinely mean different
things with and without it, so they declare `shift` explicitly and get an exact
match - which is also what keeps `Alt` + up from resolving to two bindings at
once. A test asserts exactly one binding matches each of the four combinations.

Auto-repeat is also per binding. The arrow bindings repeat, because holding the
key to walk a note across the neck is the point. Everything else swallows
repeats, `Ctrl+S` included.

`appliesTo(element, player)` takes the player as a second argument for one
binding only: `Ctrl+S` stands down when no score is open, so the browser's own
Save-page still works on the empty page rather than being swallowed for nothing.
`Ctrl+Shift+S` is left alone too - that is Firefox's responsive design mode, and
swallowing a devtools key to do the same thing as `Ctrl+S` is a bad trade.

One subtlety in the save shortcut: it **blurs the focused element first**. The
edit panels commit their text and number fields on `change`, which fires on blur,
so typing a new track name and hitting `Ctrl+S` without leaving the field would
otherwise export the old name. `change` is dispatched synchronously by `blur()`,
so the commit and the render it triggers are done before the export reads the
model. Clicking the `Save .gp` button needs none of this, because the click moves
focus out of the field on its way.

---

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
[styles/components/ScoreViewer.scss](src/styles/components/ScoreViewer.scss):
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
[src/utils/trackSound.js](src/utils/trackSound.js).

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

`applyTrackProgram()` in [src/utils/trackSound.js](src/utils/trackSound.js)
therefore rewrites `playbackInfo.program` **and** every `Instrument` automation
on the track. With that patch the duplicate events are gone.

Two consequences worth knowing:

- A genuine mid-song instrument change written into the score is overwritten
  too. That is intentional: the user picked one sound for the whole track.
- The midi is generated from the data model on demand, so the change only takes
  effect after `api.loadMidiForScore()`. That call **stops playback** by design,
  so `usePlayer` records the tick position and the playing state first and
  restores both in the `midiLoaded` handler.

---

## Six alphaTab gotchas the editor had to be built around

All six were found by running code against alphaTab **1.8.4** in Node, not by
reading the docs, and each one silently corrupts an edit if you do the obvious
thing. They are the reason
[src/utils/scoreEdits.js](src/utils/scoreEdits.js) exists as its own module.

### 1. `score.tempo` is read-only

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

### 2. String numbering is inverted relative to storage

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

### 3. Tempo is exempt from the automation-overwrite gotcha

The mixer gotcha above (setting `playbackInfo.program` is not enough, because the
file's `Instrument` automation wins) does **not** apply to tempo. `Beat.finish()`
strips Tempo automations out of `beat.automations` altogether:

```js
if (automation.type !== AutomationType.Tempo) validBeatAutomations.push(automation)
```

and the midi generator reads the tempo only from `masterBar.tempoAutomations`. So
unlike the program, tempo has exactly one write site.

### 4. A natural harmonic's pitch does not come from its fret

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

### 5. `note.string` has a cached index beside it

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

### 6. Deleting a note leaves stale links that survive `finish()`

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

### And one non-gotcha: `finish()` is not needed after the OTHER edits

`score.finish()` is idempotent - measured on a 118-bar score at 16ms, then 9.5ms,
then 6.2ms, with beat and note counts unchanged - but all it recomputes is
structure, durations and cross-note links, and every operation except the delete
changes none of those. So `deleteNotes()` is the single caller in
`scoreEdits.js`, for the reasons above. Adding or removing beats or bars would
need it too.

### Why there is no undo

`JsonConverter` on an 85-bar score:

```
scoreToJson : 108 ms, 4431 KB
jsonToScore :  52 ms
a 100-deep undo stack:  ~433 MB
```

A stack of snapshots is not viable. If undo arrives it will need invertible
commands, which is why every model write is already a named function with a
result. In the meantime the safety net is: range operations refuse rather than
clamp, the download is available before anything risky, and `Revert` reloads the
bytes of the file as it was opened (kept in memory, since they were read anyway).

---

## Deploying to GitHub Pages

Deployment is automatic: [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
builds and publishes on every push to `main`, and can also be run by hand from
the Actions tab (`workflow_dispatch`). `dist/` is never committed.

**One-time setup in the repository settings:** Settings > Pages > Source =
**GitHub Actions**. The workflow cannot do this itself - `configure-pages`
supports an `enablement` input, but it "requires a token other than
`GITHUB_TOKEN`", so it is not usable with the default workflow token.

Live URL: `https://<user>.github.io/alphatab-viewer/`

### The base path

`vite.config.js` pins `base: '/alphatab-viewer/'`, which **must match the
repository name**. Every asset resolves through `import.meta.env.BASE_URL`, so a
mismatch 404s all of them and the page renders blank. That covers four things
worth knowing about:

```
/alphatab-viewer/assets/index-*.js
/alphatab-viewer/assets/alphaTab.worker-*.js     <- emitted by @coderline/alphatab-vite
/alphatab-viewer/assets/alphaTab.worklet-*.js    <- emitted by @coderline/alphatab-vite
/alphatab-viewer/font/                           <- core.fontDirectory
/alphatab-viewer/soundfont/sonivox.sf2           <- player.soundFont
```

The workflow greps the built `dist/index.html` for the repo name and fails the
build on a mismatch, so a renamed repo produces a red run instead of a silently
broken site.

If you ever serve from a domain root (custom domain, user site), set `base: '/'`.

### Bundled assets and licences

Both third-party assets are redistributable and ship with their licence texts:

- `public/font/Bravura.*` - SIL Open Font License (`Bravura-OFL.txt`)
- `public/soundfont/sonivox.*` - Apache License 2.0, Copyright (c) 2004-2006
  Sonic Network Inc. (`soundfont/LICENSE`)
