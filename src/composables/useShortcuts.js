import { onMounted, onBeforeUnmount } from 'vue'
import { usePlayer } from '@/composables/usePlayer'

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

// Elements that legitimately own Space while focused, so the binding stands
// down for them. <select> is in the list because Space is how it opens its
// list, and the track sound picker has 128 entries - taking that away would
// make it unusable from the keyboard. Buttons, checkboxes and range sliders are
// deliberately NOT in the list: Space belongs to play/pause everywhere else.
function ownsSpace(el) {
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((el.type || '').toLowerCase())
  return false
}

function isCheckbox(el) {
  return el?.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'checkbox'
}

// One entry per shortcut. `code` is KeyboardEvent.code, which is keyboard-layout
// independent (unlike `key`), so this works the same on AZERTY and QWERTY.
// `appliesTo` decides whether the binding acts on the focused element; when it
// returns false the key is left entirely alone. Adding a shortcut is one entry.
export const BINDINGS = [
  {
    code: 'Space',
    label: 'Play / pause',
    appliesTo: (el) => !ownsSpace(el),
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
]

export function useShortcuts() {
  const player = usePlayer()

  function onKeyDown(event) {
    // Respect a handler that already acted, and never fight a modifier combo:
    // Ctrl+Space, Cmd+Space and friends belong to the OS or the browser.
    if (event.defaultPrevented) return
    if (event.ctrlKey || event.metaKey || event.altKey) return

    const binding = BINDINGS.find((b) => b.code === event.code)
    if (!binding) return
    if (!binding.appliesTo(event.target)) return

    // Swallow auto-repeat (held key) so it neither scrolls the page nor fires
    // the action dozens of times per second.
    event.preventDefault()
    if (event.repeat) return

    binding.run(player, event)
  }

  onMounted(() => window.addEventListener('keydown', onKeyDown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
}
