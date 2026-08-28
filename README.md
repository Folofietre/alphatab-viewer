# AlphaTab Viewer

A minimal, fully client-side score viewer and player built on [alphaTab](https://alphatab.net/).
Drop a Guitar Pro or MusicXML file, choose which tracks are displayed, and change
the MIDI instrument each track is played with.

No backend, no account, no game layer. The only thing persisted is the master
volume (`localStorage`).

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
```

> Stay on Vite 7. Vite 8 (rolldown) breaks `@coderline/alphatab-vite@1.8` with a
> `Missing field moduleType` error.

## Supported files

`.gp` `.gp3` `.gp4` `.gp5` `.gpx` `.xml` `.musicxml`

Drop anywhere in the window, or click the dropzone to browse. Parse failures are
reported through alphaTab's `error` event and shown as a banner.

---

## Features

**Track display** - one checkbox per track drives `api.renderTracks()`. `only`
isolates a single track, `All` renders everything. At least one track must stay
displayed (alphaTab needs a non-empty selection). alphaTab renders only the first
track on load, and the checkboxes are seeded from what it actually rendered.

**Sound per track** - a `<select>` of the 128 General MIDI programs, grouped by
family. Percussion tracks show a static label instead: percussion plays on MIDI
channel 10 and is not addressed by a program number.

**Mixer per track** - solo, mute and volume (0-200%), via `changeTrackSolo`,
`changeTrackMute` and `changeTrackVolume`. Independent of what is displayed:
every track is audible whether it is on screen or not.

**Transport** - play/pause, stop, scrub bar, playback speed (0.25x-2x), master
volume, loop, metronome. Clicking a beat in the score seeks to it
(`enableUserInteraction`).

---

## Architecture

```
src/
  main.js                    app entry
  App.vue                    layout: sidebar (tracks) + stage (score, transport)
  style.scss                 CSS custom properties, resets
  styles/_tokens.scss        SCSS spacing / radius / transition scale
  styles/_mixins.scss        panel-card, button-base, section-label, ...
  composables/usePlayer.js   the single alphaTab instance + all app state
  components/
    ScoreViewer.vue          owns the alphaTab host element, calls init()
    ScoreHeader.vue          title / artist / tempo / bars + open + close
    TrackList.vue            display checkboxes, GM program select, mixer
    TransportBar.vue         play, stop, scrub, speed, volume, loop, click
    FileDropzone.vue         window-wide drag & drop + file picker
  utils/
    gmPrograms.js            the 128 GM programs and their 16 families
    trackSound.js            applyTrackProgram() - see the gotcha below
    format.js               formatTime()
public/
  font/Bravura.*             music font, required by alphaTab's renderer
  soundfont/sonivox.sf2      SoundFont, required for playback
```

### `usePlayer()` is a module-level singleton

State lives at module scope rather than in a store: `ScoreViewer.vue` owns the
host element and calls `init()`, every other component calls `usePlayer()` and
reads the same refs. `ScoreViewer` stays mounted even before a file is dropped,
because `loadFile` needs a live api and alphaTab needs a laid-out host element
to measure against. The empty-state dropzone is an overlay on top of it.

**The alphaTab `Score` / `Track` objects are never put into a reactive ref.**
They are large cyclic graphs (score -> tracks -> staves -> bars -> voices ->
beats -> notes, with parent back-references); deep-proxying them would be slow
and would risk breaking alphaTab internals. They live in plain variables, and
the UI reads a flat `tracks` array of descriptors instead.

---

## The instrument-change gotcha

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

## Deploying

`vite.config.js` has `base: '/'`. Every asset path goes through
`import.meta.env.BASE_URL`, so for a GitHub Pages project site the only change
needed is `base: '/<repo-name>/'`.
