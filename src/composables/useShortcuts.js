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

// One entry per shortcut. `code` is KeyboardEvent.code, which is keyboard-layout
// independent (unlike `key`), so this works the same on AZERTY and QWERTY.
// Adding a shortcut is one entry here.
export const BINDINGS = [
  {
    code: 'Space',
    label: 'Play / pause',
    owns: ownsSpace,
    run: (player) => player.playPause(),
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
    if (binding.owns?.(event.target)) return

    // Swallow auto-repeat (held key) so it neither scrolls the page nor
    // toggles playback dozens of times per second.
    event.preventDefault()
    if (event.repeat) return

    binding.run(player)
  }

  onMounted(() => window.addEventListener('keydown', onKeyDown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
}
