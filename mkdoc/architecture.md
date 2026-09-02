# Architecture

```
src/
  main.js                    app entry, imports styles/main.scss
  App.vue                    layout: sidebar (Mixer | Track | Score tabs) + stage
  composables/
    usePlayer.js             the single alphaTab instance + all app state
    useScoreEdit.js          selection, isDirty, the render/midi propagation
    useShortcuts.js          the binding table, and the help derived from it
    useHelp.js               whether the shortcut modal is showing
    useUnsavedGuard.js       warn before leaving the page with unsaved edits
  components/
    ScoreViewer.vue          owns the alphaTab host + scroll wrapper, calls init()
    ScoreHeader.vue          document strip: title / tempo / bars, the bar fill, close
    BarFill.vue              how full the cursor's bar is, in beats (in the strip)
    TrackList.vue            "Mixer": the bottom dock, one channel strip per track
    TrackEditPanel.vue       "Track": name, instrument, transpose, tuning
    ScoreEditPanel.vue       "Score": tempo, save, revert
    SelectionEditPanel.vue   "Edit": the selected note or passage, and the cursor
    HelpTip.vue              the "?" marker beside a label that has a tooltip
    HelpDialog.vue           the "?" modal: shortcuts, generated from BINDINGS
    TransportBar.vue         play, stop, scrub, speed, volume, loop, click (in the action bar)
    BarsPerRow.vue           force a fixed number of bars per system
    FileDropzone.vue         window-wide drag & drop + file picker
  assets/
    loop.png metronome.png   monochrome toggle icons, used as CSS masks
  styles/
    main.scss                :root custom properties + element resets (global)
    _tokens.scss             SCSS spacing / radius / transition scale
    _mixins.scss             panel-card, button-base, section-label, ...
    components/*.scss        one file per component, one-to-one by name
  utils/
    gmPrograms.js            the 128 GM programs and their 16 families
    trackSound.js            applyTrackProgram() - see the alphaTab gotchas
    scoreEdits.js            every model write for the editing features
    scoreGeometry.js         the reverse: bounds -> a position, a position -> a rect
    scoreHistory.js          the bounded undo stack
    exportScore.js           Gp7Exporter -> Blob -> download
    format.js                formatTime()
test/
  fixtures/make-sample.mjs   regenerates sample.gp; the readable source of truth
  fixtures/sample.gp         6 tracks chosen to make every refusal fire
  helpers.js                 load / round-trip / snapshot a score in Node
  scoreEdits.test.js         the model writes and their undos, on the fixture
  scoreHistory.test.js       the stack: bound, ordering, the clean flag
  noteSelection.test.js      why selection needs core.includeNoteBounds
  scoreGeometry.test.js      the hit-test and the markers, on a real headless render
  useShortcuts.test.js       which key combination resolves to which action
  useUnsavedGuard.test.js    when the page refuses to leave
  exportScore.test.js        filenames and the .gp round trip
  useScoreEdit.test.js       the propagation matrix and the selection
  realScores.test.js         invariants against your own files (opt-in)
```

## The base path is a single knob

`vite.config.js` pins `base: '/alphatab-viewer/'`. Everything that resolves an
asset goes through `import.meta.env.BASE_URL`, so this is the only place the
deploy path is written down - and a mismatch 404s every one of them, rendering a
blank page rather than a broken one:

```
/alphatab-viewer/assets/index-*.js
/alphatab-viewer/assets/alphaTab.worker-*.js     <- emitted by @coderline/alphatab-vite
/alphatab-viewer/assets/alphaTab.worklet-*.js    <- emitted by @coderline/alphatab-vite
/alphatab-viewer/font/                           <- core.fontDirectory
/alphatab-viewer/soundfont/sonivox.sf2           <- player.soundFont
```

Serving from a domain root means `base: '/'` and nothing else. This is why CSS
never hardcodes the path either: see the note on the icon masks below.

## Styling rules

**No CSS lives in a `.vue` file.** Each component links its stylesheet and
nothing more:

```vue
<style scoped lang="scss" src="@/styles/components/TrackList.scss"></style>
```

Scoping is preserved, so `:deep()` still works for reaching alphaTab's own
`.at-*` classes.

## Monochrome icons are masks, not images

`src/assets/loop.png` and `metronome.png` are black on transparent, so an `<img>`
would be invisible on the dark chrome of the action bar. They are used through
`mask-icon()`: the alpha channel becomes a `mask` and the fill is
`background-color: currentColor`.

That is not a workaround, it is the reason the toggles need no second asset. The
icon inherits the button's `color`, so it follows `button-chrome` normally and
`control-active` when the toggle is on, in both cases without a recoloured copy
or a `filter` trick. The `-webkit-` prefix is still paired with it, since Safari
only unprefixed `mask` recently.

The `url()` uses the `@/assets/...` alias and Vite rewrites it with the hash and
the base path at build time, so this respects the single-knob rule for `base`
rather than hardcoding the deploy path in CSS. Verified in both directions: the
dev server serves `/alphatab-viewer/src/assets/loop.png` and the build emits
`/alphatab-viewer/assets/loop-<hash>.png`.

The buttons are icon-ONLY, which is why they carry an explicit `aria-label` and
`aria-pressed`. With the words gone, the `on` class is the only cue left for a
sighted user and none at all for a screen reader.

## Visual language

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

## Never animate the score's width

alphaTab re-lays out the entire score whenever its container width changes. The
re-render is debounced by `resizeThrottle`, which is **10ms**, and alphaTab's
`throttle` helper is really a debounce (it clears and resets the timer on every
event). Animation frames are ~16.7ms apart, so the timer expires *between* every
frame: transitioning the score container's width triggers a full re-layout on
each frame of the animation.

This is why the track panel is absolutely positioned and slides via `transform`
while `.stage`'s `margin-left` changes in a single un-transitioned step. alphaTab
re-lays out once per toggle instead of ~15 times.

## `usePlayer()` is a module-level singleton

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

`useScoreEdit` needs four things `usePlayer` keeps module-private: the api, the
raw `Track` objects, the `pendingRestore` dance that puts the playhead back after
a midi rebuild, and the **host element** - alphaTab dispatches a DOM
`alphaTab.beatMouseDown` CustomEvent on it alongside the typed one, and only the
DOM one carries the original `MouseEvent`. Nothing else in its API hands over the
coordinates of a click, and without them a click on an empty string has nothing
to resolve: there is no `Beat` of its own to be given. They are reached through one explicit named export,
`scoreEditHost`, rather than by duplicating the restore logic in a second
composable or widening the public `usePlayer()` surface with model internals no
component may touch.

The note-selection handlers are keyed on the **api instance**, not on a boolean
latch: `ScoreViewer` calls `destroy()` on unmount and `init()` on mount, so a new
`AlphaTabApi` is a real possibility (a hot reload is enough), and a latch would
leave the selection silently dead against an api nobody is listening to.
