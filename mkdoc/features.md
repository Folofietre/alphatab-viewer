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

**Three docks, one per scope, each collapsible on its own.** What is written
into the score is on the left (`Track` and `Score`, as two tabs); what is
currently selected is on the right (`Edit`); what is only heard is along the
bottom (`Mixer`). None of them hides another, and each holds one scope and
nothing else - `Track` carries no note controls and no listening controls,
`Score` carries no track controls.

`Edit` is the one named for the act rather than the scope, because what it works
on has no short noun that covers all of it: a note, a dragged passage, or a
position on an empty string, depending on what was last clicked.

The mixer is along the **bottom** for two reasons. It wants width - one narrow
strip per track, side by side, the way a desk is laid out - and it is the
cheapest edge to take: alphaTab re-lays out the whole score when its container
*width* changes and only then, so a dock that changes the stage's height costs
no re-layout, where each side panel costs one per toggle.

**The strips size themselves to how many there are.** They split the dock
evenly - three tracks each get a third of the window, twelve each get a twelfth -
between a floor and a ceiling, so a two-track score does not get half-screen
sliders and a twenty-track one does not get unusable slivers. Past the floor the
dock scrolls sideways rather than wrapping; a wrapped mixer is two half-desks
that stop lining up.

Volume and pan are both horizontal and identically shaped. A vertical fader
would have saved width, and was tried, but two controls a centimetre apart
pointing different ways cost more in reading than they save in pixels.

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

`TrackEditPanel`, `ScoreEditPanel` and `SelectionEditPanel` are three components
with one visual language, so their shared pieces are `edit-*` **mixins** in
`_mixins.scss` rather than copied rules. Mixins, not a shared rule block: that partial must never emit
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

Eleven operations. The track-wide ones act on the track selected in the Track
tab (clicking a note in the score selects its track too); the note-level ones act
on what is selected, from the Edit tab:

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

**Everything you can do to the document as a whole is in one File menu**, top
left: `Open`, `Save` and `Close`. They used to be scattered - an Open button in
the action bar, a Close button in the document strip.

There is deliberately no `Save as`. It was built, on `showSaveFilePicker`, and
taken back out: that API is Chromium-only, so on Firefox and Safari it fell back
to exactly what `Save` already does, and a second item that is only sometimes
different from the first is worse than not having it. The file always lands
wherever downloads land, under the `(edited)` name.

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
sidebar collapsed. Every
operation can be taken back, the delete and the whole-bar operations included.

**`Ctrl+Y` / `Cmd+Y` redoes**, and so does `Ctrl+Shift+Z` for people who reach
for that instead. A new edit throws away the redo branch, as everywhere else.

**`P` or `M` palm mutes** the selected note, or every note of a dragged passage.
Either letter, because the notation writes it "P.M." above the staff. It is a
property of the note, so muting one note of a chord mutes that note - and it
cuts the note short without moving where it starts, so the timing of everything
else is untouched. Pressing it again takes the mute off, bracket included.
Percussion is refused: there is no string to mute.

**`Y` writes the natural harmonic** of the fret the note is already on, and
`Shift+Y` opens the artificial-harmonic dialog. Both act on one note or on a whole
dragged passage.

The natural one is a toggle with nothing to ask: the fret decides the node. It
only works where that fret HAS one - 3, 4, 5, 6, 7, 8, 9, 10, 12, 14 to 17, 19,
and 22 to 24 - and on any other fret it refuses and names the ones that work,
rather than writing a harmonic that would sound the open string. Across a
passage it is all or nothing, like the frets and the strings.

The artificial one has a choice in it, which is why it asks: **where the right
hand goes**, from the octave up to three octaves. Most of those intervals are
available at several places along the string - the octave + fifth of a note
fretted at 4 sits under the right hand at fret 11 and again at fret 23 - so the
list groups the seventeen positions by what they sound and names each one by its
absolute fret. It is written as a pinch harmonic, the one Guitar Pro's type
dropdown is usually left on. The left and right hand frets are also shown as
read-outs, which is the pair a player reads, and an existing harmonic can be
taken back off. Percussion is refused, again for want of a string.

## Moving around the score

**Clicking an empty string puts a cursor there.** A click on a note selects it,
as before; a click that lands on a bar but on no note head now marks the place it
landed rather than just clearing the selection. The cursor and the selected note
are the same thing - a position - and it is drawn as a dashed outline where a
fret number would go.

Clicking anywhere in the bar lands on a string, not only the tablature itself: a
click on the standard staff, or in the gap between the two, is carried down to
the nearest tab line. Only a staff with **no** tablature at all - percussion, or
a guitar part shown as notation only - gives a position with no string, marked
with a full-height caret instead.

**alphaTab's own playback bar is hidden while nothing is playing**, so there is
only ever one vertical marker to read. It comes back the moment you press play,
already in the right place.

**The bare arrow keys move it**: left and right along the beats, crossing bars,
up and down across the strings of the same beat. The view follows when the cursor
walks off the edge.

With **nothing selected the arrows still scroll the page**, which is the only
reason they could be taken at all. They are claimed once you have clicked
something, and released again when you click away. A dragged passage collapses
onto its far edge - right carries on from the last note, left from the first.

Running off the start of the score does nothing. Running off the **end** adds a
bar - see below.

## Starting from nothing

**"Create a new tab"** sits beside the drop target on the empty page, and
**File > New...** does the same thing once something is open. Both open one
dialog, in two halves: the score (title, artist, album, tempo, time signature,
how many bars) and its first track (name, instrument, tuning). Every field has a
default, so a blank 4/4 guitar score at 120 is four clicks away.

The dialog offers exactly the fields the score header displays, so nothing shown
on screen is left unfillable. The time signature is two controls rather than a
list of the usual metres: 7/8 is as real as 4/4, and the numerator is a free
count in the model. Eight bars is the default because one is not enough to see
whether the layout, the tempo and the tuning are what you meant - and adding
bars is a keypress (the right arrow past the last one) while removing them is a
modal decision.

The created score is **a blank score plus one added track**, and that is
literally how it is built: the channels, the staff, the bar per master bar and
the octave-up display all come from the same `addTrack` the Mixer's `+ Track`
uses, so a created track and an added one cannot drift apart.

Two things behave differently from an opened file, both for the same reason -
there is no file:

- **Revert** is unavailable. Undo walks back what has been written INTO the new
  score, but there is nothing earlier to go back to.
- The score is not counted as unsaved until something is written into it. The
  choices made in the dialog are not themselves an edit.

Starting a new score replaces what is open, so it asks the same
unsaved-changes question opening a file does - and asks it **before** the dialog,
so someone who meant to keep their edits is not made to fill a form first.

## Adding and duplicating a track

**`+ Track`** in the Mixer opens a dialog for a new one: its name, its instrument
from the 128 General MIDI programs, and its tuning. The tuning is also the choice
of how many strings the track has, so the list is grouped by string count -
eleven tunings for four strings, thirty-one for six, and so on, every preset
alphaTab knows.

**"Copy the settings of"** at the top fills the three fields from a track already
in the score, which is the shortcut past all of them: most new tracks in a piece
are another of something already there. It fills the fields rather than being
remembered, so anything can then be changed - and it copies the source's exact
tuning even when that tuning matches no preset, which on real files is the usual
case.

The new track arrives empty, with a rest in every bar of the score, and
displayed.

**The duplicate icon** on a strip makes a copy of that track straight after it,
with all its notes, its effects, its ties and slides, its tuning and its
instrument. The copy is an independent track: nothing in it points back at the
original, and it gets its own midi channels, so changing the instrument on one
leaves the other alone.

Both are one `Ctrl+Z` away, and both are paused-only like every other edit.

## Deleting a track

Each strip in the Mixer carries a **bin**, which removes that track from the
score itself - notes, staves and all - rather than from what is heard. It is the
only control in the strip that changes the file, so it is the only one that is
disabled while playing and the only one that turns red, on hover.

**`Ctrl+Z` puts it back**, in one step, with its mixer settings: the volume, the
mute, the solo and whether it was displayed all come back as they were, because
the strip is put back rather than rebuilt.

The last track cannot be deleted, and the button says so rather than going dead
without explanation. If the track was the only one being displayed, the first one
left takes its place on screen.

There is no confirmation, which is the same call as the note and bar deletes: the
undo covers it in one step, and the unsaved-changes warning covers the file. The
one control that does ask is `Revert`, because that one throws away edits the
undo stack has already dropped.

## Selecting everything

**`Ctrl+A` selects every note of the track you are working on**, and takes the
key from the browser so it no longer selects the page as text. One track, not all
of them, because that is what a selection is here: a span of time on the track
the last click landed on, which is what keeps a transposition or a retuning from
quietly reaching into a track you were not looking at. It is also the `Select
all` button in the Edit panel.

It sets the loop range as well, exactly as dragging across the whole score would,
so select-all then play loops the track.

Two places it stands down: inside a text field, where select-all means the text,
and with no score open, where the browser's own is the only sensible answer. And
it works while playing, because selecting writes nothing.

## Bars that hold too much

The document strip shows **how full the cursor's bar is**, centred, in beats of
its own time signature: `3 / 4` for a 4/4 bar with a quarter note missing. It
sits there rather than in the action bar because it is a fact about the
document, like the tempo and the bar count beside it. Incomplete is not marked
as a problem - it is what every bar looks like while it is being written; only
the overflow turns into a red chip.

A bar holding **more** than its time signature allows is outlined in red on the
score. That is worth having because alphaTab will not tell you: its model, its
midi generator and its `.gp` exporter all accept an overfull bar in silence and
write it straight to the file. Nothing else in the chain reports it.

Being honest about how much this finds today: across seventeen real files and
11682 bars, exactly one bar was overfull and one incomplete. On music someone
else wrote it will almost never fire. It earns its place with the writing keys
below, which can produce an overfull bar in two presses - which is why it was
built first.

## Writing music

**Type a digit to write that fret** on the string the cursor is on, whether or
not anything is there: a free string gets a new note, a string that already has
one has its fret changed. A second digit within a moment **replaces** the first
rather than being appended, so `1` then `2` is fret 12 - and `3` then `5` is
fret 3 then fret 5, because 35 is off the end of any neck. Nothing ever waits for
a second digit, which is the point: a one-digit fret appears the instant it is
typed.

**`+` shortens the beat and `-` lengthens it**, one step at a time: whole, half,
quarter, eighth and so on down to a 256th. The direction follows the number that
is written down - a quarter note is a 4 and an eighth is an 8, so "more" is a
shorter note - and the panel says "Shorter" and "Longer" in words. The length
belongs to the **beat**, so changing it changes every note of a chord at once,
and on a dragged passage every beat moves together or none does.

**`.` adds or removes the dot**, which makes the beat half again as long. It is
part of the length rather than a mark of its own, so it acts on exactly what `+`
and `-` act on. One press on, one press off: across the real test files 76 of
11738 beats carry a dot and none carries two, so the key spends itself on the
one that exists - and an imported double dot clears in a single press.

**`Enter` walks the bar and fills in what is missing.** On a beat with something
after it, it just moves on. On the last beat of a bar that is not exactly full,
it inserts a rest of the same length and lands on it. On a bar nobody has written
into, it turns the whole-bar rest into a real one you can type into. On an
exactly full bar it moves to the next one.

**The right arrow makes room**, and it is the key a passage is actually written
with. It walks the beats as before, but on the **last** beat of a bar it looks at
whether the bar is exactly full:

- **not exactly full** - incomplete, or holding too much - it inserts a rest
  after the cursor, ready for a note to be typed over it. So a note, right, a
  note, right fills a bar and stops making room by itself when the bar comes out
  right.
- **exactly full** it moves on to the next bar, and **adds one** when there is no
  bar after it. A bar is added to every track at once, in the metre of the bar
  before it, because a bar added to one track alone would desynchronise the
  score. No key can insert a bar into the *middle* of a piece.

A bar nobody has written into counts as exactly full - it is a whole-bar rest -
so the arrow leaves it alone and moves on, which is how you add two empty bars in
two presses.

One thing worth knowing rather than discovering: **single presses cannot walk
right out of an overfull bar**, because it is never exactly right, so the arrow
keeps making room. Use the left arrow, a click, or `+` to fix the lengths - which
is what the red outline is asking for anyway.

Holding the arrow down only walks: a held key never writes, so it crosses an
incomplete bar instead of filling it. And during playback the arrow is purely a
navigation key - it moves the cursor and writes nothing, silently.

Everything here is one `Ctrl+Z` away, the added bar included, and everything is
**paused only** like every other edit.

A note appears with the length of the beat it lands in, and a new beat with the
length of the one before it. There is no separate "current duration" to keep an
eye on: it is the length of the beat the cursor is standing on, shown in the Edit
panel, and a fresh bar starts on a quarter.

## Adding and removing bars

**`Ctrl+Insert` puts an empty bar before the one the cursor is in**, and
everything after it moves along. With a passage dragged, it goes before the
first bar of the passage. The new bar is in the metre of the bar *before* it,
which is what keeps a metre change where it was drawn, and it appears on every
track at once - a bar added to one track alone would desynchronise the score.

**`Ctrl+Delete` removes the bar the cursor is in**, notes and all, on every
track. With a passage dragged it removes every bar the passage covers, which is
the only way to name more than one. It says how many went, since the bars are
gone and nothing else can tell you. A score cannot be left with no bars at all,
so the last one is refused with a message rather than taken.

Dragging over **empty** bars works, which is the point: the bars you want gone
are usually the ones with nothing in them. The Edit panel says "no notes in them"
for such a selection, because there is nothing there to change the pitch or the
length of - only whole bars to remove.

Both are also buttons in the Edit panel, and both are one `Ctrl+Z` away - the
delete puts the bars back note for note, with the ties and slides that pointed
out of them.

The bare `Delete` still means the small thing: **`Delete` silences the
selection, `Ctrl+Delete` takes the bar it is in.** There is no confirmation on
either, which is the same call as everywhere else here: undo covers it, and the
unsaved-changes warning covers the file.

**Deliberately out of scope for this tier:** tuplets, changing a time signature,
changing the number of strings, and copy and paste.

## Clicking the score takes the keyboard back

alphaTab suppresses the focus change on its own clicks, so a control used a
moment ago kept the keyboard while you were looking at the score - pick a value
in **bars per row**, click a note, and the arrow keys still moved that select.
Any press on the score now takes the focus off whatever had it, and commits it on
the way, so a half-typed tempo is applied rather than lost.

## What is NOT saved with the score

This is what the tab split encodes. The transport's **playback speed** and the
**master volume** are listening preferences and are never written to the model,
and neither are the Mixer tab's **volume**, **mute** and **solo**. Everything in
the **Track**, **Score** and **Edit** tabs is written into the score and goes out
with the file.

Two controls sit on the wrong side of that line. **Panning** is in the Mixer tab
but IS model-side and does get saved, because alphaTab has no
live setter for it - see
[the mixer gotcha](alphatab-gotchas.md#the-model-side-mixer-gotcha). And the
**bin** is in the Mixer too while being the most model-side control in the app,
because a mixer strip is where you look for the track it belongs to.
