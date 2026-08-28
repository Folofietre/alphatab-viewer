<template>
  <label class="dropzone" :class="[{ active: isDragging }, variant]">
    <input
      type="file"
      :accept="ACCEPT"
      class="file-input"
      @change="onPicked"
    />
    <template v-if="variant === 'full'">
      <span class="icon" aria-hidden="true">♪</span>
      <span class="headline">Drop a score here</span>
      <span class="sub">or click to browse</span>
      <small>{{ ACCEPT.split(',').join('  ') }}</small>
    </template>
    <span v-else class="compact-label">
      <slot>Open another file</slot>
    </span>
  </label>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

// Guitar Pro and MusicXML — the formats alphaTab reads from a binary/text blob.
const ACCEPT = '.gp,.gp3,.gp4,.gp5,.gpx,.xml,.musicxml'

defineProps({
  variant: { type: String, default: 'full' }, // 'full' | 'compact'
})
const emit = defineEmits(['file'])

const isDragging = ref(false)

function onPicked(e) {
  const file = e.target.files?.[0]
  if (file) emit('file', file)
  // Reset so re-picking the same file fires `change` again.
  e.target.value = ''
}

// Drag & drop is bound on the window rather than on the label: dropping
// anywhere over the app should work once a score is already open and the
// dropzone has shrunk to a small button.
function onWindowDragOver(e) {
  if (!e.dataTransfer?.types?.includes('Files')) return
  e.preventDefault()
  isDragging.value = true
}
function onWindowDragLeave(e) {
  if (e.relatedTarget) return
  isDragging.value = false
}
function onWindowDrop(e) {
  if (!e.dataTransfer?.types?.includes('Files')) return
  e.preventDefault()
  isDragging.value = false
  const file = e.dataTransfer.files?.[0]
  if (file) emit('file', file)
}

onMounted(() => {
  window.addEventListener('dragover', onWindowDragOver)
  window.addEventListener('dragleave', onWindowDragLeave)
  window.addEventListener('drop', onWindowDrop)
})
onBeforeUnmount(() => {
  window.removeEventListener('dragover', onWindowDragOver)
  window.removeEventListener('dragleave', onWindowDragLeave)
  window.removeEventListener('drop', onWindowDrop)
})
</script>

<style scoped lang="scss" src="@/styles/components/FileDropzone.scss"></style>
