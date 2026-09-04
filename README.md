# AlphaTab Viewer

A minimal, fully client-side score viewer, player and light editor built on
[alphaTab](https://alphatab.net/). 

Drop a Guitar Pro or MusicXML file, choose which tracks are displayed, 
change the MIDI instrument each track is played with, 
and edit - rename, retune, transpose, tempo, a note's fret or string or octave -
then write notes, rests, note lengths and bars from the keyboard, and save the
result as a `.gp` file.

Deployed at [github page](https://folofietre.github.io/alphatab-viewer/)

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

## Documentation

Everything about how the app works and why it is built the way it is lives in
[mkdoc/](mkdoc/), as an MkDocs site:

| Page | What is in it |
| --- | --- |
| [Features](mkdoc/features.md) | What the app does, and what is not saved with the score |
| [Architecture](mkdoc/architecture.md) | File layout, styling rules, the state singleton |
| [Editing internals](mkdoc/editing.md) | Selection, propagation, undo and redo |
| [Keyboard shortcuts](mkdoc/shortcuts.md) | The binding table and how the help is generated |
| [alphaTab gotchas](mkdoc/alphatab-gotchas.md) | Twelve verified traps the editor is built around |
| [Tests](mkdoc/tests.md) | What is covered, and what needs a browser |

To read it as a site:

```bash
pip install mkdocs
mkdocs serve      # http://127.0.0.1:8000
```

---

## Bundled assets and licences

Both third-party assets are redistributable and ship with their licence texts:

- `public/font/Bravura.*` - SIL Open Font License (`Bravura-OFL.txt`)
- `public/soundfont/sonivox.*` - Apache License 2.0, Copyright (c) 2004-2006
  Sonic Network Inc. (`soundfont/LICENSE`)
