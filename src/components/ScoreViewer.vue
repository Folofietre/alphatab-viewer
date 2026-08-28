<template>
  <div class="viewer">
    <div ref="host" class="alphatab-host" />
    <div v-if="isRendering" class="rendering">Rendering…</div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { usePlayer } from '@/composables/usePlayer'

const host = ref(null)
const { init, destroy, isRendering } = usePlayer()

onMounted(() => init(host.value))
onBeforeUnmount(() => destroy())
</script>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.viewer {
  position: relative;
  min-width: 0;
}
.alphatab-host {
  height: calc(100vh - 210px);
  min-height: 320px;
  overflow: auto;
  background: var(--bg-surface);
  color: var(--ash-brown);
  border: 1px solid var(--panel-border);
  border-radius: $radius-md;

  // alphaTab renders its own DOM inside the host; these are its documented
  // hook classes for the playback cursor and the hovered/played elements.
  :deep(.at-surface)       { color: var(--ash-brown); }
  :deep(.at-cursor-bar)    { background: rgba(173, 193, 120, 0.32); }
  :deep(.at-cursor-beat)   { background: var(--faded-copper); width: 3px; }
  :deep(.at-selection div) { background: rgba(123, 143, 75, 0.18); }
  :deep(.at-highlight) *   { fill: var(--palm-leaf); stroke: var(--palm-leaf); }
}
.rendering {
  position: absolute;
  top: $gap-sm;
  right: $gap-sm;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
  background: var(--panel-strong);
  border: 1px solid var(--panel-border);
  font-size: 0.75rem;
  color: var(--text-muted);
  pointer-events: none;
}
</style>
