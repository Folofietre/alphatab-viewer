import { ref } from 'vue'

// Whether the shortcut help is showing.
//
// Module scope, and its own file, because two unrelated places drive it: the "?"
// button in the action bar, and the "?" key binding. Neither owns the other, and
// threading a callback through `binding.run` would put UI state in the keyboard
// table.
const isHelpOpen = ref(false)

export function useHelp() {
  return {
    isHelpOpen,
    openHelp: () => {
      isHelpOpen.value = true
    },
    closeHelp: () => {
      isHelpOpen.value = false
    },
    toggleHelp: () => {
      isHelpOpen.value = !isHelpOpen.value
    },
  }
}
