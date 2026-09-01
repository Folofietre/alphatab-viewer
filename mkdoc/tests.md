# Tests

`npm test` runs entirely in Node - no browser, no `AlphaTabApi`, just the
importer, the model and the exporter. Every edit is asserted through an export to
`.gp` and a re-import, because an edit that does not survive a save is not an
edit.

The committed fixture is generated, not hand-picked, so what is in it is readable
rather than binary: see the header of
[test/fixtures/make-sample.mjs](../test/fixtures/make-sample.mjs). Its six tracks
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

Two suites render for real rather than stubbing. `noteSelection.test.js` and
`scoreGeometry.test.js` drive `ScoreRenderer` directly - no `AlphaTabApi`, no DOM
- which is what lets a Node test reach `boundsLookup` and assert against where
alphaTab actually drew things. Stubbing a lookup there would only assert that two
stubs agree; the claims being made are about alphaTab's own layout.

**But rendering directly is not what the app does**, and that gap once let three
features ship dead with a green suite: alphaTab renders in a worker and posts the
bounds back as JSON, and `BoundsLookup.fromJson` does not restore
`BarBounds.bar`. See
[gotcha 9](alphatab-gotchas.md#9-barboundsbar-is-empty-in-the-browser-and-full-in-your-tests).
`scoreGeometry.test.js` therefore runs every assertion **twice**, once against
the direct lookup and once against `BoundsLookup.fromJson(direct.toJson(),
score)`, which is the shape the worker delivers.

Not covered by any test, and needing a browser: whether the incremental render is
visibly faster on a large score, how a held `Alt`+arrow feels, and whether the
view follows the cursor comfortably when an arrow walks it off the screen.
