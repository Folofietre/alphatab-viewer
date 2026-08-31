import { onMounted, onBeforeUnmount } from 'vue'
import { usePlayer } from '@/composables/usePlayer'
import { useScoreEdit } from '@/composables/useScoreEdit'

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

// One entry per shortcut. `code` is KeyboardEvent.code, which is keyboard-layout
// independent (unlike `key`), so this works the same on AZERTY and QWERTY.
//
// `appliesTo` decides whether the binding acts on the focused element; when it
// returns false the key is left entirely alone.
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
  {
    code: 'ArrowUp',
    label: 'Selected note: up one string, same pitch',
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
    label: 'Selected note: down one string, same pitch',
    modifiers: { alt: true, shift: false },
    allowRepeat: true,
    appliesTo: (el) => !ownsAltArrows(el),
    run: (_player, _event, edit) => edit.nudgeSelectedString(-1),
  },
  {
    code: 'ArrowUp',
    label: 'Selected note: one semitone up',
    modifiers: { alt: true, shift: true },
    allowRepeat: true,
    appliesTo: (el) => !ownsAltArrows(el),
    run: (_player, _event, edit) => edit.nudgeSelectedFret(1),
  },
  {
    code: 'ArrowDown',
    label: 'Selected note: one semitone down',
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
export function matchesModifiers(binding, event) {
  const wanted = binding.modifiers ?? {}
  if ('shift' in wanted && !!wanted.shift !== event.shiftKey) return false
  return (
    !!wanted.alt === event.altKey &&
    !!wanted.ctrl === event.ctrlKey &&
    !!wanted.meta === event.metaKey
  )
}

// TEMPORARY DIAGNOSTIC - remove once Alt + arrow is confirmed in a browser.
function debugTarget(el) {
  if (!el) return 'null'
  const cls = el.className ? `.${String(el.className).split(' ')[0]}` : ''
  return `${el.tagName ?? '?'}${el.type ? `[type=${el.type}]` : ''}${cls}`
}

export function useShortcuts() {
  const player = usePlayer()
  const edit = useScoreEdit()

  function onKeyDown(event) {
    // TEMPORARY DIAGNOSTIC: log every arrow press and every Alt combination, so
    // a key that never reaches the page is distinguishable from one that reaches
    // it and gets filtered out.
    const isInteresting = event.altKey || event.code === 'ArrowUp' || event.code === 'ArrowDown'
    if (isInteresting) {
      const binding = BINDINGS.find(
        (b) => b.code === event.code && matchesModifiers(b, event),
      )
      console.log(
        '[edit-debug] keydown',
        `code=${event.code}`,
        `key=${event.key}`,
        `alt=${event.altKey} ctrl=${event.ctrlKey} meta=${event.metaKey} shift=${event.shiftKey}`,
        `repeat=${event.repeat}`,
        `defaultPrevented=${event.defaultPrevented}`,
        `target=${debugTarget(event.target)}`,
        `activeElement=${debugTarget(document.activeElement)}`,
        `-> binding=${binding ? binding.label : 'NONE'}`,
        binding ? `appliesTo=${binding.appliesTo(event.target)}` : '',
      )
    }

    // Respect a handler that already acted.
    if (event.defaultPrevented) return

    const binding = BINDINGS.find(
      (b) => b.code === event.code && matchesModifiers(b, event),
    )
    if (!binding) return
    if (!binding.appliesTo(event.target)) return

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
    console.log('[edit-debug] keydown listener installed on window')
  })
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
}
