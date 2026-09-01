# AlphaTab Viewer

Technical documentation. The [README](../README.md) covers prerequisites,
install and run, supported files and licences; everything about how the app
works and why it is built the way it is lives here.

| Page | What is in it |
| --- | --- |
| [Features](features.md) | What the app does, and what is not saved with the score |
| [Architecture](architecture.md) | File layout, styling rules, the state singleton |
| [Editing internals](editing.md) | The cursor, propagation, bar filling, undo and redo |
| [Keyboard shortcuts](shortcuts.md) | The binding table and how the help is generated |
| [alphaTab gotchas](alphatab-gotchas.md) | Nine verified traps the editor is built around |
| [Tests](tests.md) | What is covered, and what needs a browser |

## How to read this

Two things run through all of it, and they explain most of the decisions
recorded here.

**Everything was measured, not assumed.** Every claim about alphaTab in these
pages came from running code against it in Node and reading the result: the
timings, the byte counts, the "0 boxes off, 984 boxes on". Where the
documentation and the implementation disagreed, the implementation won, and the
page says so. Where something is still unverified it is marked as such.

**A refusal is a feature.** An operation that cannot be applied says why, with
numbers, and writes nothing. A transposition that clamps some of its notes is
not a transposition, and a batch that half applied would be worse than one that
did not run.
