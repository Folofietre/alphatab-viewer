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

Auto-repeat is also per binding. The arrow bindings repeat, because holding the
key to walk a note across the neck is the point. Everything else swallows
repeats, `Ctrl+S` included.

`appliesTo(element, player)` takes the player as a second argument for one
binding only: `Ctrl+S` stands down when no score is open, so the browser's own
Save-page still works on the empty page rather than being swallowed for nothing.
`Ctrl+Shift+S` is left alone too - that is Firefox's responsive design mode, and
swallowing a devtools key to do the same thing as `Ctrl+S` is a bad trade.

One subtlety in the save shortcut: it **blurs the focused element first**. The
edit panels commit their text and number fields on `change`, which fires on blur,
so typing a new track name and hitting `Ctrl+S` without leaving the field would
otherwise export the old name. `change` is dispatched synchronously by `blur()`,
so the commit and the render it triggers are done before the export reads the
model. Clicking the `Save .gp` button needs none of this, because the click moves
focus out of the field on its way.

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
