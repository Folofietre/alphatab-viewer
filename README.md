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
  main.js                    app entry, imports styles/main.scss
  App.vue                    layout: sidebar (tracks) + stage (score, transport)
  composables/
    usePlayer.js             the single alphaTab instance + all app state
    useShortcuts.js          page-wide keys (Space = play/pause)
  components/
    ScoreViewer.vue          owns the alphaTab host + scroll wrapper, calls init()
    ScoreHeader.vue          title / artist / tempo / bars + open + close
    TrackList.vue            display checkboxes, GM program select, mixer
    TransportBar.vue         play, stop, scrub, speed, volume, loop, click
    FileDropzone.vue         window-wide drag & drop + file picker
  styles/
    main.scss                :root custom properties + element resets (global)
    _tokens.scss             SCSS spacing / radius / transition scale
    _mixins.scss             panel-card, button-base, section-label, ...
    components/*.scss        one file per component, one-to-one by name
  utils/
    gmPrograms.js            the 128 GM programs and their 16 families
    trackSound.js            applyTrackProgram() - see the gotcha below
    format.js                formatTime()
```

### Styling rules

**No CSS lives in a `.vue` file.** Each component links its stylesheet and
nothing more:

```vue
<style scoped lang="scss" src="@/styles/components/TrackList.scss"></style>
```

Scoping is preserved, so `:deep()` still works for reaching alphaTab's own
`.at-*` classes.

**`_tokens.scss` and `_mixins.scss` must never emit CSS** - only variables,
mixins and `@forward`. Every SFC style block is its own Sass compilation unit,
so a rule placed in a shared partial is duplicated into all of them. Measured
with a probe rule: it came out 7 times, once globally and once scoped per
component. That is also why `styles/main.scss` is imported from `main.js`
rather than merged into a partial.

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
