# Features

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
previews while dragging and commits once on release. See
[the mixer gotcha](alphatab-gotchas.md#the-model-side-mixer-gotcha).

**Collapsible sidebar, three tabs** - `Mixer`, `Track`, `Score`, named for the
scope each one acts on. `Mixer` rather than `Tracks`, because "Tracks" next to
"Track" reads as the same thing.

Tabs rather than a stack: the sidebar is 290px wide and the track list is
arbitrarily long, so a panel below it would be unreachable on a nine-track score.
The tab strip also owns the collapse control, since it acts on the container all
three panels sit in. Undo is deliberately not there: it reaches edits from both
panels, so it lives in the action bar. The tabs are toggle buttons with
`aria-pressed`, not
`role="tab"`: a real tablist promises arrow-key navigation and an `aria-controls`
/ `role="tabpanel"` pairing, and a half-implemented one is worse for a screen
reader than an honest set of toggles. The panel slides out of the way and
collapses to a 30px rail carrying the reopen control, labelled with the panel it
will reveal, so it never disappears without a way back. The slide animates the
panel's `transform` only; see
[why the layout itself must not be animated](architecture.md#never-animate-the-scores-width).

The panels are toggled with `v-show`, not `v-if`: switching tabs must not throw
away a half-typed name or a chosen tuning, and none of them is expensive enough
to unmount.

`ScoreEditPanel` and `TrackEditPanel` are two components with one visual
language, so their shared pieces are `edit-*` **mixins** in `_mixins.scss` rather
than copied rules. Mixins, not a shared rule block: that partial must never emit
CSS, since every SFC style block is its own Sass compilation unit and a rule
placed there would be duplicated into all of them.

**Transport** - play/pause, stop, scrub bar, playback speed (0.25x-2x), master
volume, and icon toggles for loop and metronome, all in the top action bar. Space is play/pause from
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
| Notes by an octave | `note.string` + `note.fret`, via the buttons or `Alt` + PageUp/PageDown |
| Notes replaced by silence | removes them from their beats, via `Silence` or `Delete` |

Then `Save .gp` downloads the result - or **`Ctrl+S`** / **`Cmd+S`**, which
deliberately takes the key from the browser's "Save page as" - and `Revert`
reloads the file exactly as it was opened.

Those two note-level moves work on **one note or a whole passage**. Click and
drag across the score - the same gesture that sets alphaTab's loop range - or
**double click a bar** to take the whole measure, and Alt+arrow acts on every
note in it. The two selections exclude each other: a drag drops the single note,
and a single click on a bar drops whichever was there.

A batch is **all or nothing**. If one note of twelve would run off the neck, the
whole selection is refused with the numbers, because a passage where nine notes
moved and three stayed is not a re-fingering of anything. And unlike the
single-note case the refusal is loud: with twelve notes selected there is no
guessing which one blocked it, and a repeated key will not walk out of it.

The note-level moves are deliberately different things, and the keyboard says
which is which:

- **`Alt` + up/down** moves the note to the **adjacent string**, keeping the
  pitch: the fret changes to compensate, so the score sounds identical and only
  the fingering moves. Up goes to the higher-pitched string, which is also the
  higher line on the tablature, so the note moves the way the key points.
- **`Alt` + `Shift` + up/down** is the one that **changes the pitch**, by a
  semitone, on the same string.
- **`Alt` + `PageUp`/`PageDown`** moves it a whole **octave**, and that is a
  re-fingering rather than twelve frets: it changes string when the fret alone
  cannot reach.

All three repeat when held, and the first two refuse silently at the edge of the
fretboard, because a message per press on a repeatable key is noise. Every other
refusal (an occupied string, a fret that would land off the neck, a natural
harmonic) is explained in the panel.

**The octave is the one batch operation that is not all or nothing.** Going down
an octave is physically impossible for a lot of real music - measured across
seventeen real files, 37 % of notes cannot go down and 1.8 % cannot go up,
because the instrument does not reach that far. All or nothing would make the
downward direction refuse almost every time. So on a passage it does what it can:
the notes that can move do, the rest **stay at the pitch they had**, and the
panel says how many. On a single note it still refuses, naming both pitches.

That exception is allowed here and nowhere else, for one reason: clipping a fret
produces a *wrong* value, while not moving keeps a *right* one. A clipped
transposition leaves a note sounding wrong and out of interval with its
neighbours; a note that did not drop an octave is simply where it always was.

Whatever is selected is **ringed on the score**, once per row it is drawn on
(the note head on the standard staff and the fret number on the tablature), so
there is never a doubt about what an edit will touch. One rule: **a ring means
this note will be edited**. Clicking a bar rather than a note clears it. See the
note on [how the marker works](editing.md#marking-the-selected-note).

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
clamps some of its notes is not a transposition, and an undo that only partly
applied would be no better.

**No component writes to the alphaTab model.** Every write lives in
[src/utils/scoreEdits.js](../src/utils/scoreEdits.js) as a pure named function that
takes the model and returns what happened; `useScoreEdit` decides what the write
invalidates; the panel renders flat reactive data. That is also what keeps an
undo stack possible later without touching the UI - each function is already a
command and would only need its inverse.

**`Delete` (or `Backspace`) replaces the selection with silence.** A note becomes
silence by being removed from its beat, and the duration takes care of itself:
`Beat.isRest` is a getter over `notes.length === 0` and `beat.duration` is
independent of its notes, so emptying a beat turns it into a rest of exactly the
same length. A beat that still holds other notes keeps sounding them, so deleting
one note of a chord silences that note, not the chord.

There is deliberately no confirmation: asking every time would make it useless
for one note, and a threshold on the count would be arbitrary. `Ctrl+Z` takes it
back, and `isDirty` warns before the score is replaced or closed.

**`Ctrl+Z` / `Cmd+Z` undoes the last edit**, up to 30 steps back, and the
action bar carries an icon-only undo button whose tooltip names what would go
and how many steps are left. It sits there rather than in a sidebar panel because
it reaches edits made from either of them, and the bar stays visible with the
sidebar collapsed. Every one
of the eleven operations can be taken back, the delete included.

**`Ctrl+Y` / `Cmd+Y` redoes**, and so does `Ctrl+Shift+Z` for people who reach
for that instead. A new edit throws away the redo branch, as everywhere else.

## Moving around the score

**Clicking an empty string puts a cursor there.** A click on a note selects it,
as before; a click that lands on a bar but on no note head now marks the place it
landed rather than just clearing the selection. The cursor and the selected note
are the same thing - a position - and it is drawn as a dashed outline where a
fret number would go. On a standard-notation staff, where a vertical position
carries no string information, it marks the beat and leaves the string open.

**The bare arrow keys move it**: left and right along the beats, crossing bars,
up and down across the strings of the same beat. The view follows when the cursor
walks off the edge.

With **nothing selected the arrows still scroll the page**, which is the only
reason they could be taken at all. They are claimed once you have clicked
something, and released again when you click away. A dragged passage collapses
onto its far edge - right carries on from the last note, left from the first.

Running off either end of the score does nothing. Adding a bar there is a write,
and is not part of this tier.

## Bars that hold too much

The action bar shows **how full the cursor's bar is**, in beats of its own time
signature: `3 / 4` for a 4/4 bar with a quarter note missing. Incomplete is not
marked as a problem - it is what every bar looks like while it is being written.

A bar holding **more** than its time signature allows is outlined in red on the
score. That is worth having because alphaTab will not tell you: its model, its
midi generator and its `.gp` exporter all accept an overfull bar in silence and
write it straight to the file. Nothing else in the chain reports it.

Being honest about how much this finds today: across seventeen real files and
11682 bars, exactly one bar was overfull and one incomplete. On music someone
else wrote it will almost never fire. It earns its place when note entry arrives,
which is why it was built first.

**Deliberately out of scope for this tier:** entering notes, adding or removing
bars, changing durations, changing the number of strings.

## What is NOT saved with the score

This is what the tab split encodes. The transport's **playback speed** and the
**master volume** are listening preferences and are never written to the model,
and neither are the Mixer tab's **volume**, **mute** and **solo**. Everything in
the **Track** and **Score** tabs is written into the score and goes out with the
file.

One control sits on the wrong side of that line and stays there: **panning** is
in the Mixer tab but IS model-side and does get saved, because alphaTab has no
live setter for it - see
[the mixer gotcha](alphatab-gotchas.md#the-model-side-mixer-gotcha).
