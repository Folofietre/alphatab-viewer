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

The real-score suite is **sampled** rather than swept for the writing tier, and
the number is the reason: every write there runs `score.finish()`, so touching all
7424 beats of the largest file would be tens of seconds of finishing. Twenty
positions spread across the whole file is what it takes instead. That same cost is
why none of the writing keys repeats - see
[what finish() actually costs](editing.md#what-finish-on-every-keystroke-actually-costs).

One invariant can only be checked against a real file: **the fixture has no note
link that crosses a bar line at all**, while the two large real scores carry 106
and 191 of them. So the sweep that stops a deleted bar leaving a tie pointing
into it is exercised there and nowhere else.

Two shapes of real file are worth knowing about, because both broke an invariant
that looked safe. One carries a **stringed track whose every bar is still an
untouched placeholder**, so "pick the first stringed staff and edit its first
beat" finds nothing to edit - the suite now looks for voices somebody has actually
written into and says so. And the fixture has no empty bar at all, so the
placeholder path is reached in tests by adding a bar first, which is the same
route a user takes.

One test double had to be made **less** forgiving to be useful. The fake
`AlphaTabApi` returned early where alphaTab 1.8.4 throws - reading
`_selectionStart.beat` inside `if (_selectionEnd)` - and that kindness let a
broken click-and-drag reach the browser. It now throws in both of the places
alphaTab does, and the drag is driven as a whole gesture (press, moves, release,
with the coordinates that make the press place a cursor) rather than from the
`playbackRangeHighlightChanged` event alone, which is halfway through the story.
The lesson generalises: a double that is safer than the real thing hides exactly
the bugs worth finding.

A real-score invariant can also be **too strong**, and the octave sweep was: it
asserted that no beat holds two notes on one string after the shift, which one
bass beat of a real file already broke before any edit ran - it arrives carrying
1/2 and 1/7 together. A failure there said "the octave created a collision" when
the truth was "the file has one". It now records the count per beat beforehand and
asserts the edit does not RAISE it. The general form: a postcondition on real
input has to be a delta, or the input's own defects come back as yours.

`usePlayer.test.js` tests exactly one function, and the reason is the shape of
the bug it was written for. Restoring what a midi rebuild dropped is three
assignments whose ORDER is the whole content - the range has to go back before
the tick, because alphaTab's range setter moves the playhead - so the fake synth
there reproduces that one side effect and nothing else. The same
extract-the-decision move as `guardUnload` and `focusToRelease`.

Not covered by any test, and needing a browser: whether the incremental render is
visibly faster on a large score, how a held `Alt`+arrow feels, whether the view
follows the cursor comfortably when an arrow walks it off the screen, and whether
the 800ms multi-digit window is the right length for real typing.
