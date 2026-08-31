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
// `appliesTo(element, player)` decides whether the binding acts; when it returns
// false the key is left entirely alone. Most bindings only care about the focused
// element, but the save shortcut also needs to know whether a score is open.
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
    appliesTo: (el) => !ownsTypingKeys(el),
    run: (player) => player.playPause(),
  },
  {
    code: 'Enter',
    label: 'Toggle the focused checkbox',
    // Taking Space for play/pause removes a checkbox's ONLY native toggle key:
    // Enter does nothing on a checkbox. Hand it back here, once, instead of in
    // every component that renders one. Non-checkbox targets are untouched, so
    // Enter keeps working normally on buttons and links.
    appliesTo: isCheckbox,
    run: (_player, event) => event.target.click(),
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
    modifiers: { meta: true, shift: false },
    appliesTo: (_el, player) => player.isScoreLoaded.value,
    run: saveScore,
  },
  // The help itself. `?` needs Shift on most layouts and Shift is not declared,
  // so it is ignored - matching the CHARACTER is what makes this work on any
  // keyboard, whatever combination produces it there.
  //
  // Stands down in a text field, where "?" is a character someone is typing.
  {
    key: '?',
    label: 'Show the keyboard shortcuts',
    appliesTo: (el) => !ownsTypingKeys(el),
    run: () => useHelp().toggleHelp(),
  },
  // Ctrl+Z and Cmd+Z. Two entries for the same reason Ctrl+S has two, and
  // `shift: false` because Ctrl+Shift+Z is redo everywhere - a key this editor
  // does not implement, so it is left alone rather than aliased to undo.
  //
  // Applies with focus anywhere, including a text field: a field's own undo is
  // not what someone pressing Ctrl+Z in a score editor is after, and the edit
  // panels commit on blur so there is rarely an uncommitted draft to lose.
  {
    key: 'z',
    label: 'Undo the last edit',
    modifiers: { ctrl: true, shift: false },
    appliesTo: (_el, player) => player.isScoreLoaded.value,
    run: (_player, _event, edit) => edit.undo(),
  },
  {
    key: 'z',
    label: 'Undo the last edit',
    modifiers: { meta: true, shift: false },
    appliesTo: (_el, player) => player.isScoreLoaded.value,
    run: (_player, _event, edit) => edit.undo(),
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
    appliesTo: (el) => !ownsTypingKeys(el),
    run: (_player, _event, edit) => edit.deleteSelection(),
  },
  {
    code: 'Backspace',
    label: 'Replace the selection with silence',
    appliesTo: (el) => !ownsTypingKeys(el),
    run: (_player, _event, edit) => edit.deleteSelection(),
  },
  {
    code: 'ArrowUp',
    label: 'Move up one string, same pitch',
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
    modifiers: { alt: true, shift: false },
    allowRepeat: true,
    appliesTo: (el) => !ownsAltArrows(el),
    run: (_player, _event, edit) => edit.nudgeSelectedString(-1),
  },
  {
    code: 'ArrowUp',
    label: 'Up one semitone',
    modifiers: { alt: true, shift: true },
    allowRepeat: true,
    appliesTo: (el) => !ownsAltArrows(el),
    run: (_player, _event, edit) => edit.nudgeSelectedFret(1),
  },
  {
    code: 'ArrowDown',
    label: 'Down one semitone',
    modifiers: { alt: true, shift: true },
    allowRepeat: true,
    appliesTo: (el) => !ownsAltArrows(el),
    run: (_player, _event, edit) => edit.nudgeSelectedFret(-1),
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
export function matchesKey(binding, event) {
  if (binding.code) return binding.code === event.code
  if (binding.key) return (event.key || '').toLowerCase() === binding.key
  return false
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
}

export function describeBinding(binding) {
  const parts = []
  const wanted = binding.modifiers ?? {}
  if (wanted.ctrl) parts.push('Ctrl')
  if (wanted.meta) parts.push('Cmd')
  if (wanted.alt) parts.push('Alt')
  // Only when the binding WANTS it. `shift: false` is an exclusion, not a key to
  // show.
  if (wanted.shift) parts.push('Shift')

  if (binding.code) parts.push(KEY_NAMES[binding.code] ?? binding.code)
  else if (binding.key) parts.push(binding.key.toUpperCase())

  return parts.join(' + ')
}

// One row per distinct action, with every key combination that triggers it.
//
// Grouped by label, which is what folds Ctrl+S and Cmd+S into one row, and
// Delete and Backspace into another. Order follows BINDINGS, so the table reads
// in the order a maintainer sees them.
export function shortcutHelp() {
  const rows = []
  const byLabel = new Map()
  for (const binding of BINDINGS) {
    const existing = byLabel.get(binding.label)
    if (existing) {
      existing.keys.push(describeBinding(binding))
      continue
    }
    const row = { label: binding.label, keys: [describeBinding(binding)] }
    byLabel.set(binding.label, row)
    rows.push(row)
  }
  return rows
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

    const binding = BINDINGS.find(
      (b) => matchesKey(b, event) && matchesModifiers(b, event),
    )
    if (!binding) return
    if (!binding.appliesTo(event.target, player)) return

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
