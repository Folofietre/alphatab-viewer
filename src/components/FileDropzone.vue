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

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.dropzone {
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  text-align: center;
  color: var(--text);
  transition:
    border-color $transition-med,
    background-color $transition-med,
    color $transition-med;

  &:hover {
    border-color: var(--accent-border);
    color: var(--accent);
  }
  &.active {
    border-color: var(--accent);
    background-color: var(--accent-bg);
    color: var(--accent);
  }
}

.dropzone.full {
  flex-direction: column;
  gap: $gap-sm;
  padding: 4rem 2rem;
  border: 2px dashed var(--panel-border);
  border-radius: $radius-lg;
  background: var(--panel);

  .icon {
    font-size: 2.5rem;
    line-height: 1;
    opacity: 0.5;
  }
  .headline {
    font-size: 1.15rem;
    font-weight: 600;
    color: var(--text-h);
  }
  .sub {
    font-size: 0.9rem;
    opacity: 0.7;
  }
  small {
    @include tabular;
    margin-top: $gap-sm;
    font-family: var(--mono);
    font-size: 0.7rem;
    opacity: 0.5;
  }
}

.dropzone.compact {
  @include button-base;
  padding: 0.4rem 0.8rem;
  font-size: 0.85rem;
  border-style: dashed;
  white-space: nowrap;
}

.file-input {
  display: none;
}
</style>
