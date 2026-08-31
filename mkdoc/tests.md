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

Not covered by any test, and needing a browser: whether the incremental render is
visibly faster on a large score, and how a held `Alt`+arrow feels.
