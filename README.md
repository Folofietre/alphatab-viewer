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

**Track display** - clicking a track name shows that track alone; its checkbox
adds it to the current view alongside the others. `All` renders everything. At
least one track must stay displayed, since alphaTab needs a non-empty selection,
so the last remaining checkbox is disabled. alphaTab renders only the first track
on load, and the checkboxes are seeded from what it actually rendered.

Clicking a name that is already the sole displayed track returns early rather
than re-rendering: it is the primary click target now, and re-laying out a score
is expensive.

**Sound per track** - a `<select>` of the 128 General MIDI programs, grouped by
family. Percussion tracks show a static label instead: percussion plays on MIDI
channel 10 and is not addressed by a program number.

**Mixer per track** - solo, mute, volume (0-200%) and panning (L8 to R8), on two
aligned rows. Independent of what is displayed: every track is audible whether it
is on screen or not.

Solo, mute and volume use alphaTab's live setters (`changeTrackSolo`,
`changeTrackMute`, `changeTrackVolume`) and apply instantly. Panning has **no**
live setter, so it goes through the data model and a midi rebuild; the slider
previews while dragging and commits once on release. See the gotcha below.

**Collapsible track panel** - the panel slides out of the way and collapses to a
30px rail carrying the reopen control, so it never disappears without a way
back. The slide animates the panel's `transform` only; see the note below on why
the layout itself must not be animated.

**Transport** - play/pause, stop, scrub bar, playback speed (0.25x-2x), master
volume, loop, metronome, all in the top action bar. Space is play/pause from
anywhere on the page. Clicking a beat in the score seeks to it
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
    ScoreHeader.vue          document strip: title / artist / tempo / bars + close
    TrackList.vue            display checkboxes, GM program select, mixer
    TransportBar.vue         play, stop, scrub, speed, volume, loop, click (in the action bar)
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

**The alphaTab `Score` / `Track` objects are never put into a reactive ref.**
They are large cyclic graphs (score -> tracks -> staves -> bars -> voices ->
beats -> notes, with parent back-references); deep-proxying them would be slow
and would risk breaking alphaTab internals. They live in plain variables, and
the UI reads a flat `tracks` array of descriptors instead.

---

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
