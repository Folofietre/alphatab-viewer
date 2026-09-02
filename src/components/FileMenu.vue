<template>
  <div ref="root" class="file-menu">
    <button
      type="button"
      class="file-button"
      :class="{ on: isOpen }"
      aria-haspopup="menu"
      :aria-expanded="isOpen"
      title="Open, save or close a score"
      @click="isOpen = !isOpen"
    >File</button>

    <!-- Hand-rolled rather than a native `popover`, and that is a decision this
         project has already paid for once: the `title` tooltip was the right
         primitive on paper and silently did nothing here, twice. A menu that is
         our own DOM and our own state cannot be switched off by the browser. -->
    <ul v-if="isOpen" class="menu" role="menu">
      <li role="none">
        <button role="menuitem" type="button" @click="choose('open')">
          <span>Open...</span>
        </button>
      </li>
      <li role="none">
        <button role="menuitem" type="button" :disabled="!isScoreLoaded" @click="choose('save')">
          <span>Save</span><kbd>Ctrl+S</kbd>
        </button>
      </li>
      <li role="none">
        <button
          role="menuitem"
          type="button"
          :disabled="!isScoreLoaded"
          :title="saveAsTitle"
          @click="choose('save-as')"
        >
          <span>Save as...</span>
        </button>
      </li>
      <li role="none" class="sep">
        <button role="menuitem" type="button" :disabled="!isScoreLoaded" @click="choose('close')">
          <span>Close</span>
        </button>
      </li>
    </ul>

    <!-- The picker for `Open`. Its own input rather than reaching into
         FileDropzone: that component owns the empty-state target and the
         window-wide drop, which are a different job from a menu item. Both read
         the accept list from one place so they cannot drift. -->
    <input
      ref="picker"
      type="file"
      :accept="SCORE_FILE_ACCEPT"
      class="file-input"
      @change="onPicked"
    />
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { SCORE_FILE_ACCEPT } from '@/utils/scoreFiles'
import { canPickSaveLocation } from '@/utils/exportScore'

defineProps({
  isScoreLoaded: { type: Boolean, default: false },
})
const emit = defineEmits(['file', 'save', 'save-as', 'close'])

const root = ref(null)
const picker = ref(null)
const isOpen = ref(false)

// Said out loud, because "Save as..." that cannot choose a folder is a lie.
// `showSaveFilePicker` is Chromium-only; everywhere else the item still works
// and still lets the file out, it just lands wherever downloads land.
const saveAsTitle = computed(() =>
  canPickSaveLocation()
    ? 'Choose a name and a folder'
    : 'This browser cannot choose a folder, so this saves to your downloads',
)

function choose(action) {
  isOpen.value = false
  if (action === 'open') picker.value?.click()
  else emit(action)
}

function onPicked(event) {
  const file = event.target.files?.[0]
  if (file) emit('file', file)
  // Reset, so re-picking the same file fires `change` again.
  event.target.value = ''
}

// Dismissal. `mousedown` rather than `click`, so the menu is already gone by the
// time a click lands on whatever is underneath - otherwise closing it and
// pressing the thing behind it takes two clicks.
function onDocumentDown(event) {
  if (!isOpen.value) return
  if (!root.value?.contains(event.target)) isOpen.value = false
}

function onKeyDown(event) {
  if (event.key === 'Escape' && isOpen.value) {
    isOpen.value = false
    event.stopPropagation()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentDown)
  document.addEventListener('keydown', onKeyDown)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentDown)
  document.removeEventListener('keydown', onKeyDown)
})
</script>

<style scoped lang="scss" src="@/styles/components/FileMenu.scss"></style>
