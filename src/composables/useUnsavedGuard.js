import { onMounted, onBeforeUnmount } from 'vue'
import { usePlayer } from '@/composables/usePlayer'

// Warn before the page goes away with unsaved edits.
//
// `beforeunload` rather than catching F5, and that is the whole point of this
// file. A keydown handler on F5 / Ctrl+F5 covers exactly two of the ways out:
// it never sees Ctrl+R, the reload button, a closed tab, a typed URL or a back
// navigation, and some of those combinations are reserved by the browser so
// `preventDefault()` cannot touch them anyway. A warning that fires on F5 while
// the reload button silently discards the work is worse than none, because it
// teaches confidence the app has not earned.
//
// `beforeunload` covers every one of those paths, F5 and Ctrl+F5 included.
//
// Two things worth knowing about it, neither fixable from here:
//
//  - The dialog is the BROWSER'S. Its wording cannot be set and its appearance
//    cannot be styled; returning a string used to work and no longer does.
//  - Browsers only honour it after the page has had a real user interaction.
//    That is not a problem in practice here: there is no way to have unsaved
//    edits without having clicked or typed something first.
//
// Gated on `isDirty`, so nothing fires for a score that was only looked at, or
// one that has just been saved, or one whose every edit has been undone.

// Split out from the listener so the decision can be tested without a window.
// Returns whether the unload was blocked.
export function guardUnload(event, isDirty) {
  if (!isDirty) return false
  // The modern way, and the legacy way: Chrome and Firefox honour
  // preventDefault(), while older WebKit only looks at `returnValue`. Setting
  // both costs a line and covers both.
  event.preventDefault()
  event.returnValue = ''
  return true
}

export function useUnsavedGuard() {
  const { isDirty } = usePlayer()

  function onBeforeUnload(event) {
    guardUnload(event, isDirty.value)
  }

  onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
  onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))
}
