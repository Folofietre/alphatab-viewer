# Keyboard shortcuts

## `code` for positions, `key` for letters

A binding matches on **either** `KeyboardEvent.code` or `KeyboardEvent.key`, and
the choice is not cosmetic. The obvious advice - "use `code`, it is
layout-independent" - is right for Space, Enter, the arrows, Delete and
Backspace, whose position is the point. It is **wrong for a letter**:

`code: 'KeyZ'` is the position QWERTY gives to Z, and on AZERTY that is the key
labelled **W**. Declared by code, `Ctrl+Z` fires for `Ctrl+W` on a French
keyboard and never for `Ctrl+Z`. So the two letter shortcuts, Save and Undo,
match `event.key` case-insensitively, which means "the key labelled Z" on every
layout - AZERTY, Dvorak, Bépo included. Tests assert both directions with the
physical key and the produced character deliberately disagreeing.

## Keyboard shortcuts declare their own modifiers

`useShortcuts` used to drop **every** modifier combination globally
(`if (event.ctrlKey || event.metaKey || event.altKey) return`), which was right
while Space was the only binding but makes `Alt` + arrow impossible. The
exclusion is now per binding: each entry declares which of Alt, Ctrl and Meta it
wants, matched exactly. Space still refuses to fire under Ctrl or Alt, because it
declares none - lifting the restriction for one binding does not open the others
to combinations that belong to the browser or the OS.

Shift is **opt-in** rather than always matched: it is a shifting modifier rather
than a command one, and requiring its absence everywhere would silently break
Shift+Space for no benefit. But the two arrow pairs genuinely mean different
things with and without it, so they declare `shift` explicitly and get an exact
match - which is also what keeps `Alt` + up from resolving to two bindings at
once. A test asserts exactly one binding matches each of the four combinations.

Auto-repeat is also per binding. The keys that **walk somewhere** repeat - the
arrows, whether they move a note across the neck or the cursor along a line, and
the octave keys - because holding one is the gesture. Everything else swallows
repeats, `Ctrl+S` and all four writing keys included, and a test pins exactly
which set is which. For the writing keys that is not a preference: each one runs
`score.finish()`, so a held key would re-derive the whole score at the keyboard's
repeat rate.

## One key, several meanings: the resolver asks `appliesTo` too

`onKeyDown` looks for the first binding that matches the key **and applies to
what is focused**, rather than finding a match and then checking it:

```js
BINDINGS.find((b) => matchesKey(b, event) && matchesModifiers(b, event) &&
                     b.appliesTo(event.target, player, edit))
```

That is what lets `Enter` toggle a focused checkbox and, everywhere else, place a
rest. With the check outside the search, whichever entry came first in the table
would have swallowed the key for the other one - silently, and only in the
situation the other one exists for.

"Everywhere else" includes a focused **button**, which therefore loses its native
`Enter`. That is the same trade `Space` already makes, and it is the useful way
round: alphaTab calls `preventDefault()` on its mousedown, so focus stays on
whatever was last clicked, and standing down for buttons would leave `Enter` dead
for writing in the commonest state of the app. There are no focusable links in
this UI, so nothing else loses a native `Enter`, and the handler stands down
entirely while a `<dialog>` is open - so the help modal's own buttons keep it.

## `key` may be a list of characters

One binding needs it: the **ten digits are one action**, not ten. Declared as ten
entries they would still work, and the generated help would print ten key tokens
where it means to say `0-9`. So `key` accepts an array, and `keyName` is what the
help prints instead:

```js
{ key: ['0', '1', ..., '9'], keyName: '0-9', label: 'Write a fret at the cursor' }
```

A test asserts that any binding matching several characters names itself, so the
help cannot come out as a list of digits.

## `appliesTo(element, player, edit)`

Three arguments, each earned by a specific binding, and a test asserts that no
binding reaches for one it has no reason to.

`player` is for `Ctrl+S`, which stands down when no score is open so the
browser's own Save-page still works on the empty page rather than being swallowed
for nothing. `Ctrl+Shift+S` is left alone too - that is Firefox's responsive
design mode, and swallowing a devtools key to do the same thing as `Ctrl+S` is a
bad trade.

`edit` is for the four **bare arrows** and for the four writing keys, and the
reason it has to be reachable from `appliesTo` is mechanical rather than tidy. A
bare arrow either moves the cursor or scrolls the page; the handler calls
`preventDefault()` **before** `run`, so a binding that decided inside `run` would
have killed the scroll either way. With nothing selected, `edit.canNavigate` is
false, the binding never applies, and the key is left entirely alone.

That is the whole reason taking the bare arrows is acceptable at all: they are
only claimed once the user has clicked something. The same goes for a digit,
which is a character someone may simply be typing.

Two predicates, not one, because the conditions really differ. A digit and a rest
need a **position** to write at, which only a cursor is (`canWriteNote`); a
duration belongs to a beat, and a dragged passage is a set of beats even with no
cursor on any of them (`canChangeDuration`).

## One key, two sizes of delete

`Delete` alone replaces the selection with silence; `Ctrl+Delete` removes the
whole bar it is in. The modifier match is exact, so the two never collide, and
`Ctrl+Shift+Delete` is left to the browser - swallowing clear-browsing-data to do
something else is the same bad trade `Ctrl+Shift+S` was.

`Ctrl+Insert` is its counterpart, and the pair are the only bar-sized operations
on the keyboard: the right arrow can add a bar but only at the very end of the
score, and nothing else removes one. Both stand down for anything that owns
typing keys, unlike `Alt`+arrow - `Ctrl+Delete` in a text field is
delete-word-forward, which is a real shortcut somebody may be using in the tempo
field - and neither repeats, because each one is a structural edit that finishes
the score.

## The writing keys are the strictest in the table

`0-9`, `+`, `-` and `Enter` are the first bindings here that are plain
**characters** rather than a combination, which is what makes them strict: a digit
typed into a tempo field is a digit, so unlike `Alt`+arrow they stand down for
every element that owns typing keys - text and number inputs, textareas,
`<select>`, contentEditable.

The consequence is worth knowing, because it looks like a bug. alphaTab calls
`preventDefault()` on its mousedown, which **suppresses the focus change**, so
clicking a note does not move focus out of the field you last typed in - and
"type a tempo, click a note, type a fret" puts the fret in the tempo field.
Clicking anywhere outside a field first is the way out. There is no fix available
from here: taking a character key back from a focused text field would be a worse
bug than this one.

`+` and `-` match by **character**, which is what makes both the main row and the
numeric keypad work - the keypad's plus reports `key: '+'` too. `+` needs Shift on
most layouts, so Shift is deliberately not declared, the same reason as the `?`
binding.

One subtlety in the save shortcut: it **blurs the focused element first**. The
edit panels commit their text and number fields on `change`, which fires on blur,
so typing a new track name and hitting `Ctrl+S` without leaving the field would
otherwise export the old name. `change` is dispatched synchronously by `blur()`,
so the commit and the render it triggers are done before the export reads the
model. Clicking the `Save .gp` button needs none of this, because the click moves
focus out of the field on its way.

## The arrow keys, and why there are three layers of them

The up and down arrows now mean three different things, separated by modifiers
and each with an exact match so none of them is ambiguous:

| Keys | Acts on | Moves |
| --- | --- | --- |
| arrow | the **cursor** | one beat sideways, one string up or down |
| `Alt` + arrow | the **note** | to the next string, keeping its pitch |
| `Alt` + `Shift` + arrow | the **note** | one semitone, on the same string |
| `Alt` + `PageUp` / `PageDown` | the **note** | a whole octave, re-fingered |

One exception to "the bare arrow only navigates": the **right** arrow makes room.
On the last beat of a bar that is not exactly full it inserts a rest, and past
the last beat of the last bar it adds a bar. It is the only key in the table that
both navigates and writes, so `run` reads `event.repeat` and passes
`canWrite: false` for a held key - a finger left on the arrow only walks. It is
also silent rather than refusing during playback, where it is a navigation key
and nothing else.

The reading is "the arrow moves the cursor, `Alt` makes it move the note". Up
means the higher-pitched string in every row of that table, which is also the
higher line on the tablature, so everything moves the way the key points.

The octave is a paging key rather than a third arrow combination because it is a
different **kind** of move: the fret and the string are both recomputed to land
on a pitch, so unlike the others it can be impossible - going down an octave is
off the bottom of the instrument for 37 % of the notes of the real scores
measured.

## The shortcut help is generated, not written

The `?` button in the action bar opens a native `<dialog>` listing every
shortcut, and the keyboard half of that list is **derived from `BINDINGS`**. A
help table that is typed out by hand starts lying the first time someone adds a
binding and forgets it; this one cannot.

`describeBinding()` turns a binding into what to press - modifiers in a fixed
order, then the key, with `code` mapped through a display table (`ArrowUp` to an
arrow glyph) and a `key` upper-cased. It deliberately does **not** show a
`shift: false`, which is an exclusion rather than a key to press.
`shortcutHelp()` then groups by label, which is what folds `Delete` and
`Backspace` into one row. Ctrl and Cmd are shown as a single `Ctrl/Cmd` token
rather than doubling every row - truthful only because every Ctrl binding has a
Cmd twin, which a test asserts, so adding a Ctrl-only shortcut would fail rather
than make the help lie. A test asserts every
binding is accounted for, so a new one shows up in the help whether or not
anyone remembers.

The mouse half IS hand-written, because alphaTab owns the mouse and there is no
table to generate it from.

`<dialog>` with `showModal()` rather than a hand-rolled overlay: it brings the
backdrop, the focus trap and Escape-to-close, and hand-rolling those is how
half-accessible modals happen. Two things it does not bring, both handled: a
backdrop click (the click reports the DIALOG as its target, since the backdrop is
its pseudo element, which is exactly what separates outside from inside), and
suppressing the page shortcuts. The keydown handler stands down while
`document.querySelector('dialog[open]')` finds anything - asked of the DOM rather
than of a flag, because `showModal()` is what makes a dialog modal, so that
selector is the same truth the browser is using.
