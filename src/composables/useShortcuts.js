import { onMounted, onBeforeUnmount } from 'vue'
import { usePlayer } from '@/composables/usePlayer'
import { useScoreEdit } from '@/composables/useScoreEdit'
import { useHelp } from '@/composables/useHelp'

// Page-wide keyboard shortcuts.
//
// The problem this solves: a <button> is activated by Space, so after clicking
// any button in the UI it keeps focus and swallows the key - "Space" ends up
// re-triggering the last button pressed instead of doing what the user meant.
//
// The fix is to handle the key on `keydown` at the window level and call
// preventDefault(). A button's activation click for Space is dispatched on
// keyup, and only if the keydown default was not prevented, so preventing it
// suppresses the button entirely. It also suppresses the page scroll that Space
// would otherwise cause.

// Input types that are text entry, where every key belongs to the field.
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'email', 'url', 'tel', 'password', 'number',
  'date', 'time', 'datetime-local', 'month', 'week',
])

// Elements that legitimately own the keys these bindings want while focused, so
// a binding stands down for them. Space is how a <select> opens its list, and
// arrows are how it moves through it, and the track sound picker has 128
// entries - taking either away would make it unusable from the keyboard. A text
// field owns Space as a character and the arrows as caret movement.
//
// Buttons, checkboxes and range sliders are deliberately NOT in the list: Space
// belongs to play/pause everywhere else.
function ownsTypingKeys(el) {
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((el.type || '').toLowerCase())
  return false
}

// Which elements own ALT + up/down specifically, which is a much shorter list.
//
// No text field owns it: word-wise caret movement is Alt+LEFT/RIGHT, and
// Alt+Up/Down has no native meaning in an input or a textarea on any platform.
// A <select> does own Alt+Down (it opens the list on Windows and Linux), and
// contentEditable is left alone as a rich-text surface we do not model.
//
// This matters more than it looks. alphaTab calls `preventDefault()` on its
// mousedown when `enableUserInteraction` is on, which suppresses the focus
// change - so clicking a note does NOT move focus out of whatever field the user
// last typed in. Excluding text fields here would mean "type a tempo, click a
// note, press Alt + arrow" silently doing nothing, which is indistinguishable
// from a broken shortcut.
function ownsAltArrows(el) {
  if (!el) return false
  if (el.isContentEditable) return true
  return el.tagName === 'SELECT'
}

function isCheckbox(el) {
  return el?.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'checkbox'
}

// Save the score, taking the browser's Save-page shortcut for it.
//
// The blur is load-bearing, not tidiness. The edit panels commit their text and
// number fields on `change`, which fires on blur - so typing a new track name
// and hitting Ctrl+S without leaving the field would export the OLD name.
// Clicking the Save button does not need this, because the click moves focus out
// of the field and commits on the way.
//
// `change` is dispatched synchronously by blur(), so the commit (and the render
// it triggers) is done before the export reads the model.
function saveScore(_player, _event, edit) {
  document.activeElement?.blur?.()
  edit.download()
}

// One entry per shortcut, matched on EITHER `code` or `key`, and the choice is
// not cosmetic.
//
//   `code` is the PHYSICAL key, named after the US QWERTY layout. Right for keys
//   whose position is the point and whose label never moves: Space, Enter, the
//   arrows, Delete, Backspace.
//
//   `key` is the CHARACTER the key produces. Right for a letter shortcut, and
//   `code` is actively wrong there: `code: 'KeyZ'` is the position QWERTY gives
//   to Z, which on AZERTY is the key labelled W. So Ctrl+Z declared by code
//   fires for Ctrl+W on a French keyboard and not for Ctrl+Z. Matching the
//   character means "the key labelled Z" on every layout, which is what a user
//   pressing Ctrl+Z means.
//
// Comparison is case-insensitive, so a stray Shift cannot break it.
//
// `appliesTo(element, player, edit)` decides whether the binding acts; when it
// returns false the key is left entirely alone. Most bindings only care about
// the focused element; the save shortcut also needs to know whether a score is
// open, and the four bare arrows need to know whether there is anything to
// navigate FROM.
//
// The third argument is not a convenience. A bare arrow either moves the cursor
// or scrolls the page, and the handler calls `preventDefault()` BEFORE `run` -
// so a binding that decided inside `run` would have killed the scroll either
// way. The decision has to be reachable from `appliesTo` or it is not a
// decision at all.
//
// `modifiers` declares which of Alt, Ctrl and Meta the binding WANTS, and is
// matched exactly. Declaring it per binding rather than excluding modifiers
// globally is what lets Alt+arrow exist without opening every other shortcut to
// combinations that belong to the browser or the OS: Space still refuses to fire
// under Ctrl or Alt, because it declares no modifiers.
//
// `allowRepeat` lets a held key fire repeatedly. Off by default, because
// repeating play/pause dozens of times a second is never what anyone wants.
//
// `run` receives (player, event, edit). Adding a shortcut is one entry.
export const BINDINGS = [
  {
    code: 'Space',
    label: 'Play / pause',
    group: 'Global',
    appliesTo: (el) => !ownsTypingKeys(el),
    run: (player) => player.playPause(),
  },
  {
    code: 'Enter',
    label: 'Toggle the focused checkbox',
    group: 'Global',
    // Taking Space for play/pause removes a checkbox's ONLY native toggle key:
    // Enter does nothing on a checkbox. Hand it back here, once, instead of in
    // every component that renders one.
    //
    // FIRST of two bindings on Enter, and the order is load-bearing: the rest
    // binding at the bottom of this table claims Enter everywhere a checkbox is
    // not focused, which includes a focused BUTTON. That is the same trade Space
    // already makes - a focused button does not own the key here - and it is the
    // useful way round, because alphaTab's `preventDefault()` keeps focus on
    // whatever was last clicked, so standing down for buttons would leave Enter
    // dead for writing in the commonest state of the app. There are no focusable
    // links in this UI, so nothing else loses a native Enter.
    appliesTo: isCheckbox,
    run: (_player, event) => event.target.click(),
  },
  // The four bare arrows MOVE THE CURSOR, and only when there is a cursor to
  // move: with nothing selected they are left alone and keep scrolling the page,
  // which is the only reason taking them is acceptable at all. Clicking a note
  // or a bar arms them; clicking away disarms them again.
  //
  // Left and right walk the beats, crossing bars. Up and down walk the strings
  // of the same beat, in the direction the key points - the same convention
  // Alt+arrow already uses for moving a note, so the pair reads as "the arrow
  // moves the cursor, Alt makes it move the note".
  //
  // They repeat: walking along a line or across the neck with the key held is
  // the point, and nothing is written, so a repeat costs a lookup and a
  // rectangle.
  {
    code: 'ArrowRight',
    label: 'Next beat, making room at the end of a bar',
    group: 'Moving around',
    allowRepeat: true,
    appliesTo: (el, _player, edit) => !ownsTypingKeys(el) && edit.canNavigate.value,
    // The one navigation key that WRITES: on the last beat of a bar that is not
    // exactly full it inserts a beat, and past the last beat of the last bar it
    // adds a bar. `!event.repeat` is what keeps a held key from doing either -
    // it only walks, at the keyboard's repeat rate, which is what holding an
    // arrow has always meant.
    run: (_player, event, edit) => edit.moveCursorBeat(1, { canWrite: !event.repeat }),
  },
  {
    code: 'ArrowLeft',
    label: 'Move the cursor to the previous beat',
    group: 'Moving around',
    allowRepeat: true,
    appliesTo: (el, _player, edit) => !ownsTypingKeys(el) && edit.canNavigate.value,
    run: (_player, _event, edit) => edit.moveCursorBeat(-1),
  },
  {
    code: 'ArrowUp',
    label: 'Move the cursor up one string',
    group: 'Moving around',
    // `shift: false` and no Alt, so this stays distinct from the three other
    // things the up arrow does. The modifier match is exact for Alt, Ctrl and
    // Meta already; Shift is declared because Alt+Shift+Up is a binding too and
    // an undeclared Shift would let a stray capital resolve here.
    modifiers: { shift: false },
    allowRepeat: true,
    appliesTo: (el, _player, edit) => !ownsTypingKeys(el) && edit.canNavigate.value,
    run: (_player, _event, edit) => edit.moveCursorString(1),
  },
  {
    code: 'ArrowDown',
    label: 'Move the cursor down one string',
    group: 'Moving around',
    modifiers: { shift: false },
    allowRepeat: true,
    appliesTo: (el, _player, edit) => !ownsTypingKeys(el) && edit.canNavigate.value,
    run: (_player, _event, edit) => edit.moveCursorString(-1),
  },
  // Alt + arrow moves the note to the NEXT STRING, keeping the pitch: the fret
  // changes to compensate, so the score sounds identical and only the fingering
  // moves. Up goes to the higher-pitched string, which is also the higher line
  // on the tablature, so the note moves the way the key points.
  //
  // Alt + SHIFT + arrow is the one that changes the pitch, by a semitone.
  //
  // Both declare `shift` explicitly, which is what makes it significant here
  // while Space keeps ignoring it. See matchesModifiers.
  // Ctrl+S and Cmd+S, as two entries rather than one "primary modifier" concept:
  // the modifier match is exact, and being explicit is what keeps Ctrl+Space and
  // friends from resolving to anything. Both are claimed on every platform,
  // since neither combination means anything else here.
  //
  // This deliberately overrides the browser's "Save page as", which is what the
  // key means in a document app.
  {
    key: 's',
    label: 'Save the score as .gp',
    group: 'Global',
    // `shift: false` on purpose: Ctrl+Shift+S is Firefox's responsive design
    // mode, and swallowing a devtools key to do the same thing as Ctrl+S is a
    // bad trade.
    modifiers: { ctrl: true, shift: false },
    // Applies with focus anywhere, including a text field: saving is a document
    // action, and no field owns Ctrl+S. But it stands down with no score open,
    // so the browser's own Save-page still works on the empty page rather than
    // being swallowed for nothing.
    appliesTo: (_el, player) => player.isScoreLoaded.value,
    run: saveScore,
  },
  {
    key: 's',
    label: 'Save the score as .gp',
    group: 'Global',
    modifiers: { meta: true, shift: false },
    appliesTo: (_el, player) => player.isScoreLoaded.value,
    run: saveScore,
  },
  // Ctrl+A, taken from the browser's select-all-the-text.
  //
  // Two entries for the two platforms, like Ctrl+S, and `shift: false` so
  // Ctrl+Shift+A stays free. It selects every note of the track being edited,
  // because a range here is a tick window on ONE track - the same rule the drag
  // and the double click follow.
  //
  // It stands down for anything that owns typing keys, where select-all means
  // the text in the field, and with no score open, where the browser's own is
  // the only sensible answer. Not gated on being paused: selecting writes
  // nothing.
  {
    key: 'a',
    label: 'Select every note of the track',
    modifiers: { ctrl: true, shift: false },
    group: 'Global',
    appliesTo: (el, player) => !ownsTypingKeys(el) && player.isScoreLoaded.value,
    run: (_player, _event, edit) => edit.selectAll(),
  },
  {
    key: 'a',
    label: 'Select every note of the track',
    modifiers: { meta: true, shift: false },
    group: 'Global',
    appliesTo: (el, player) => !ownsTypingKeys(el) && player.isScoreLoaded.value,
    run: (_player, _event, edit) => edit.selectAll(),
  },
  // The help itself. `?` needs Shift on most layouts and Shift is not declared,
  // so it is ignored - matching the CHARACTER is what makes this work on any
  // keyboard, whatever combination produces it there.
  //
  // Stands down in a text field, where "?" is a character someone is typing.
  {
    key: '?',
    label: 'Show the keyboard shortcuts',
    group: 'Global',
    appliesTo: (el) => !ownsTypingKeys(el),
    run: () => useHelp().toggleHelp(),
  },
  // Ctrl+Z and Cmd+Z. Two entries for the same reason Ctrl+S has two, and
  // `shift: false` so the combination stays distinct from Ctrl+Shift+Z below.
  //
  // Applies with focus anywhere, including a text field: a field's own undo is
  // not what someone pressing Ctrl+Z in a score editor is after, and the edit
  // panels commit on blur so there is rarely an uncommitted draft to lose.
  {
    key: 'z',
    label: 'Undo the last edit',
    group: 'Global',
    modifiers: { ctrl: true, shift: false },
    appliesTo: (_el, player) => player.isScoreLoaded.value,
    run: (_player, _event, edit) => edit.undo(),
  },
  {
    key: 'z',
    label: 'Undo the last edit',
    group: 'Global',
    modifiers: { meta: true, shift: false },
    appliesTo: (_el, player) => player.isScoreLoaded.value,
    run: (_player, _event, edit) => edit.undo(),
  },
  // Redo, under both keys people reach for: Ctrl+Y (Windows convention, and what
  // was asked for) and Ctrl+Shift+Z (the near-universal alternative, and what
  // Ctrl+Z's `shift: false` was already keeping free).
  //
  // Four entries rather than two, because the modifier match is exact and each
  // platform pairing is spelled out. `key: 'y'` and `key: 'z'` rather than a
  // code, for the AZERTY reason above - and it matters especially for Y, which on
  // a German QWERTZ layout sits where QWERTY puts Z.
  {
    key: 'y',
    label: 'Redo the last undone edit',
    group: 'Global',
    modifiers: { ctrl: true, shift: false },
    appliesTo: (_el, player) => player.isScoreLoaded.value,
    run: (_player, _event, edit) => edit.redo(),
  },
  {
    key: 'y',
    label: 'Redo the last undone edit',
    group: 'Global',
    modifiers: { meta: true, shift: false },
    appliesTo: (_el, player) => player.isScoreLoaded.value,
    run: (_player, _event, edit) => edit.redo(),
  },
  {
    key: 'z',
    label: 'Redo the last undone edit',
    group: 'Global',
    modifiers: { ctrl: true, shift: true },
    appliesTo: (_el, player) => player.isScoreLoaded.value,
    run: (_player, _event, edit) => edit.redo(),
  },
  {
    key: 'z',
    label: 'Redo the last undone edit',
    group: 'Global',
    modifiers: { meta: true, shift: true },
    appliesTo: (_el, player) => player.isScoreLoaded.value,
    run: (_player, _event, edit) => edit.redo(),
  },
  // Delete and Backspace both, since editors accept either and the user's
  // keyboard may label only one of them. They stand down for anything that owns
  // typing keys, where these are the text-editing keys and not ours.
  //
  // No repeat: the selection is cleared by the delete, so a held key would have
  // nothing to act on anyway, and a chain-delete is not a gesture anyone means.
  {
    code: 'Delete',
    label: 'Replace the selection with silence',
    group: 'The selected note',
    appliesTo: (el) => !ownsTypingKeys(el),
    run: (_player, _event, edit) => edit.deleteSelection(),
  },
  {
    code: 'Backspace',
    label: 'Replace the selection with silence',
    group: 'The selected note',
    appliesTo: (el) => !ownsTypingKeys(el),
    run: (_player, _event, edit) => edit.deleteSelection(),
  },
  {
    code: 'ArrowUp',
    label: 'Move up one string, same pitch',
    group: 'The selected note',
    modifiers: { alt: true, shift: false },
    // Repeats, unlike Space: holding the key to walk a note across the neck is
    // exactly the point. The midi rebuild is debounced downstream so a held key
    // does not queue one per repeat.
    allowRepeat: true,
    appliesTo: (el) => !ownsAltArrows(el),
    run: (_player, _event, edit) => edit.nudgeSelectedString(1),
  },
  {
    code: 'ArrowDown',
    label: 'Move down one string, same pitch',
    group: 'The selected note',
    modifiers: { alt: true, shift: false },
    allowRepeat: true,
    appliesTo: (el) => !ownsAltArrows(el),
    run: (_player, _event, edit) => edit.nudgeSelectedString(-1),
  },
  {
    code: 'ArrowUp',
    label: 'Up one semitone',
    group: 'The selected note',
    modifiers: { alt: true, shift: true },
    allowRepeat: true,
    appliesTo: (el) => !ownsAltArrows(el),
    run: (_player, _event, edit) => edit.nudgeSelectedFret(1),
  },
  {
    code: 'ArrowDown',
    label: 'Down one semitone',
    group: 'The selected note',
    modifiers: { alt: true, shift: true },
    allowRepeat: true,
    appliesTo: (el) => !ownsAltArrows(el),
    run: (_player, _event, edit) => edit.nudgeSelectedFret(-1),
  },
  // Alt + PageUp / PageDown: a whole octave.
  //
  // A separate key rather than a third arrow combination, because it is a
  // separate KIND of move: the fret and the string are both recomputed to land
  // on a pitch, so unlike the two above it can be impossible - going down an
  // octave is off the bottom of the instrument for most notes of a real score.
  //
  // Same `ownsAltArrows` stand-down as the arrows: nothing but a <select> and a
  // rich-text surface owns Alt + a paging key, and standing down for text fields
  // would break "type a tempo, click a note, press the key", since alphaTab's
  // preventDefault keeps focus in the field.
  {
    code: 'PageUp',
    label: 'Up one octave',
    group: 'The selected note',
    modifiers: { alt: true },
    allowRepeat: true,
    appliesTo: (el) => !ownsAltArrows(el),
    run: (_player, _event, edit) => edit.shiftSelectedOctave(1),
  },
  {
    code: 'PageDown',
    label: 'Down one octave',
    group: 'The selected note',
    modifiers: { alt: true },
    allowRepeat: true,
    appliesTo: (el) => !ownsAltArrows(el),
    run: (_player, _event, edit) => edit.shiftSelectedOctave(-1),
  },
  // ---- writing -------------------------------------------------------------
  //
  // The keys that put something into the score, and the first ones here that are
  // plain CHARACTERS rather than a combination.
  //
  // That is what makes them the strictest bindings in the table: a digit typed
  // into a tempo field is a digit, so unlike Alt+arrow these have to stand down
  // for every element that owns typing keys.
  //
  // Standing down is safe BECAUSE clicking the score blurs: `useScoreEdit`
  // listens for a press on alphaTab's host and takes the focus off whatever had
  // it, since alphaTab's own `preventDefault()` suppresses the focus change. It
  // used to mean "type a tempo, click a note, type a fret" put the fret in the
  // tempo field, which looked exactly like a broken key.
  //
  // None of them repeats. Each one calls `score.finish()`, so a held key would
  // be re-deriving the whole score at the keyboard's repeat rate.
  {
    // Ten characters, one action. See matchesKey.
    key: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
    keyName: '0-9',
    label: 'Write a fret at the cursor',
    group: 'Writing',
    // A digit needs a POSITION to write at, which is what a cursor is. With
    // nothing selected the keys are left entirely alone.
    appliesTo: (el, _player, edit) => !ownsTypingKeys(el) && edit.canWriteNote.value,
    run: (_player, event, edit) => edit.typeFret(event.key),
  },
  // `+` shortens and `-` lengthens, following the number that is written down: a
  // quarter note is a 4 and an eighth is an 8, so "more" is a shorter note.
  //
  // Matched by CHARACTER, which is what makes both the main row and the numeric
  // keypad work: the keypad's plus reports `key: '+'` too. And `+` needs Shift
  // on most layouts, which is exactly why Shift is not declared - the same
  // reason as the "?" binding.
  {
    key: '+',
    label: 'Shorter note',
    group: 'Writing',
    appliesTo: (el, _player, edit) => !ownsTypingKeys(el) && edit.canChangeDuration.value,
    run: (_player, _event, edit) => edit.changeDuration(edit.DURATION_SHORTER),
  },
  {
    key: '-',
    label: 'Longer note',
    group: 'Writing',
    appliesTo: (el, _player, edit) => !ownsTypingKeys(el) && edit.canChangeDuration.value,
    run: (_player, _event, edit) => edit.changeDuration(edit.DURATION_LONGER),
  },
  // The dot, which is part of a length rather than a mark of its own, so it
  // stands with `+` and `-` and acts on exactly what they act on. Matched by
  // character, which covers the main row and the numeric keypad's decimal, and
  // Shift is not declared because plenty of layouts need it for a full stop.
  {
    key: '.',
    label: 'Dotted note',
    group: 'Writing',
    appliesTo: (el, _player, edit) => !ownsTypingKeys(el) && edit.canChangeDuration.value,
    run: (_player, _event, edit) => edit.toggleDot(),
  },
  // Enter, which is the SECOND binding on that key: the checkbox toggle above
  // owns it while a checkbox is focused, and this one takes it everywhere else.
  // That only works because the resolver looks for the first binding that
  // matches AND applies - see onKeyDown.
  {
    code: 'Enter',
    label: 'Add a rest, or step along the bar',
    group: 'Writing',
    appliesTo: (el, _player, edit) => !ownsTypingKeys(el) && edit.canWriteNote.value,
    run: (_player, _event, edit) => edit.insertRest(),
  },
  // Whole BARS, which is the one thing the writing keys above cannot reach: the
  // right arrow only ever adds a bar at the END of the score, and nothing
  // removed one at all.
  //
  // `Ctrl` because they are the destructive pair of a set whose bare keys are
  // note-sized: `Delete` alone silences the selection, `Ctrl+Delete` takes the
  // bar it is in. The modifier match is exact, so the two never collide.
  //
  // `shift: false` leaves `Ctrl+Shift+Delete` to the browser, where it opens
  // clear-browsing-data - swallowing that to do something else is the same bad
  // trade `Ctrl+Shift+S` was.
  //
  // They stand down for anything that owns typing keys, unlike Alt+arrow:
  // `Ctrl+Delete` in a text field is delete-word-forward, which is a real
  // shortcut somebody may be using in the tempo field.
  //
  // No repeat. Each one is a structural edit that finishes the score, and a held
  // key would eat a bar per repeat - which is undoable, but only one step at a
  // time.
  {
    code: 'Insert',
    label: 'Insert a bar before this one',
    group: 'Writing',
    modifiers: { ctrl: true, shift: false },
    appliesTo: (el, _player, edit) => !ownsTypingKeys(el) && edit.canEditBars.value,
    run: (_player, _event, edit) => edit.insertBar(),
  },
  {
    code: 'Insert',
    label: 'Insert a bar before this one',
    group: 'Writing',
    modifiers: { meta: true, shift: false },
    appliesTo: (el, _player, edit) => !ownsTypingKeys(el) && edit.canEditBars.value,
    run: (_player, _event, edit) => edit.insertBar(),
  },
  {
    code: 'Delete',
    label: 'Delete this bar',
    group: 'Writing',
    modifiers: { ctrl: true, shift: false },
    appliesTo: (el, _player, edit) => !ownsTypingKeys(el) && edit.canEditBars.value,
    run: (_player, _event, edit) => edit.removeBars(),
  },
  {
    code: 'Delete',
    label: 'Delete this bar',
    group: 'Writing',
    modifiers: { meta: true, shift: false },
    appliesTo: (el, _player, edit) => !ownsTypingKeys(el) && edit.canEditBars.value,
    run: (_player, _event, edit) => edit.removeBars(),
  },
]

// Exact match on Alt, Ctrl and Meta, always. Shift only when the binding says so.
//
// Shift is OPT-IN because it is a shifting modifier rather than a command one:
// requiring its absence everywhere would silently break Shift+Space for no
// benefit. But the two arrow pairs genuinely mean different things with and
// without it, so they declare `shift` and get an exact match, which is also what
// keeps Alt+Up from resolving to two bindings at once.
// A binding matches a key event by physical position or by character, never both.
//
// `key` may be a LIST of characters, which is there for exactly one binding: the
// ten digits are one action, not ten, and ten entries would print ten key
// tokens into a help table that means to say "0-9". `keyName` is what it says
// instead.
export function matchesKey(binding, event) {
  if (binding.code) return binding.code === event.code
  if (!binding.key) return false
  const typed = (event.key || '').toLowerCase()
  if (Array.isArray(binding.key)) return binding.key.includes(typed)
  return typed === binding.key
}

export function matchesModifiers(binding, event) {
  const wanted = binding.modifiers ?? {}
  if ('shift' in wanted && !!wanted.shift !== event.shiftKey) return false
  return (
    !!wanted.alt === event.altKey &&
    !!wanted.ctrl === event.ctrlKey &&
    !!wanted.meta === event.metaKey
  )
}

// How a key reads on screen. Derived, never hand-written, so the help cannot
// drift from what the handler actually does.
const KEY_NAMES = {
  Space: 'Space',
  Enter: 'Enter',
  Delete: 'Delete',
  Backspace: 'Backspace',
  ArrowUp: '\u2191',
  ArrowDown: '\u2193',
  ArrowLeft: '\u2190',
  ArrowRight: '\u2192',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
}

export function describeBinding(binding) {
  const parts = []
  const wanted = binding.modifiers ?? {}
  // One token for both, because every Ctrl binding here has a Cmd twin - a test
  // asserts that - so listing them separately doubled every row for nothing.
  if (wanted.ctrl || wanted.meta) parts.push('Ctrl/Cmd')
  if (wanted.alt) parts.push('Alt')
  // Only when the binding WANTS it. `shift: false` is an exclusion, not a key to
  // show.
  if (wanted.shift) parts.push('Shift')

  // A binding that matches several characters names itself: see matchesKey.
  if (binding.keyName) parts.push(binding.keyName)
  else if (binding.code) parts.push(KEY_NAMES[binding.code] ?? binding.code)
  else if (binding.key) parts.push(binding.key.toUpperCase())

  return parts.join(' + ')
}

// The order the groups read in, which is the order someone learns them: what
// works everywhere, then getting around, then changing what is there, then
// putting something new in.
//
// Declared here rather than derived from BINDINGS, because the reading order of
// a help table is a decision and the order of the binding table is a
// maintenance one. A test asserts the two sets match, so a group named in a
// binding and forgotten here fails rather than disappearing from the help.
export const SHORTCUT_GROUPS = ['Global', 'Moving around', 'The selected note', 'Writing']

// One row per distinct action, with every key combination that triggers it,
// arranged in groups.
//
// Rows are folded by label, which is what puts Ctrl+S and Cmd+S on one row, and
// Delete and Backspace on another. Within a group the order follows BINDINGS, so
// the table still reads in the order a maintainer sees them.
export function shortcutHelp() {
  const byLabel = new Map()
  const groups = new Map(SHORTCUT_GROUPS.map((group) => [group, []]))

  for (const binding of BINDINGS) {
    const keys = describeBinding(binding)
    const existing = byLabel.get(binding.label)
    if (existing) {
      // Deduped: the Ctrl and Cmd twins render identically.
      if (!existing.keys.includes(keys)) existing.keys.push(keys)
      continue
    }
    const row = { label: binding.label, keys: [keys] }
    byLabel.set(binding.label, row)
    // An unknown group would silently drop the row, so it goes to the end
    // instead - and the test on SHORTCUT_GROUPS is what stops it happening.
    if (!groups.has(binding.group)) groups.set(binding.group, [])
    groups.get(binding.group).push(row)
  }

  return [...groups]
    .filter(([, rows]) => rows.length > 0)
    .map(([group, rows]) => ({ group, rows }))
}

// Every row, flat, for anything that wants the whole table rather than the
// grouped one. Kept because "is every binding accounted for" is a question
// about the table, not about how it is laid out.
export function shortcutRows() {
  return shortcutHelp().flatMap((section) => section.rows)
}

export function useShortcuts() {
  const player = usePlayer()
  const edit = useScoreEdit()

  function onKeyDown(event) {
    // A modal owns the keyboard while it is open, so Space must not reach
    // play/pause from inside the help. Asked of the DOM rather than of a flag:
    // `showModal()` is what makes a dialog modal, so `dialog[open]` is the same
    // truth the browser is using, and it covers any future dialog for free.
    //
    // Escape and the focus trap are the dialog element's own job.
    if (document.querySelector('dialog[open]')) return

    // Respect a handler that already acted.
    if (event.defaultPrevented) return

    // The first binding that matches the key AND applies to what is focused.
    //
    // `appliesTo` is part of the search rather than a check on the winner,
    // because one key legitimately has several meanings on disjoint conditions:
    // Enter toggles a focused checkbox and, everywhere else, places a rest. With
    // the check outside the search, whichever entry came first in the table
    // would have swallowed the key for the other one - silently, and only in the
    // situation the other one exists for.
    const binding = BINDINGS.find(
      (b) =>
        matchesKey(b, event) &&
        matchesModifiers(b, event) &&
        b.appliesTo(event.target, player, edit),
    )
    if (!binding) return

    // Swallow the key so it neither scrolls the page nor triggers a focused
    // button, then drop auto-repeat unless the binding asked for it.
    event.preventDefault()
    if (event.repeat && !binding.allowRepeat) return

    binding.run(player, event, edit)
  }

  onMounted(() => {
    // ScoreViewer's onMounted has run by now, so the api exists and the note
    // selection can be wired. Guarded, so calling it here is free if some other
    // consumer of useScoreEdit already did it.
    edit.bindSelection()
    window.addEventListener('keydown', onKeyDown)
  })
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
}
