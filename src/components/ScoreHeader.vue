<template>
  <div class="score-header">
    <div class="titles">
      <h2>{{ info.title || fileName || 'Untitled score' }}</h2>
      <p class="meta">
        <span v-if="info.artist">{{ info.artist }}</span>
        <span v-if="info.album">{{ info.album }}</span>
        <span v-if="info.tempo">{{ info.tempo }} bpm</span>
        <span>{{ info.barCount }} bars</span>
        <span>{{ info.trackCount }} {{ info.trackCount === 1 ? 'track' : 'tracks' }}</span>
      </p>
    </div>
    <div class="actions">
      <FileDropzone variant="compact" @file="$emit('file', $event)" />
      <button type="button" @click="$emit('close')">Close</button>
    </div>
  </div>
</template>

<script setup>
import FileDropzone from './FileDropzone.vue'

defineProps({
  info: { type: Object, required: true },
  fileName: { type: String, default: '' },
})
defineEmits(['file', 'close'])
</script>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.score-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: $gap-lg;
  flex-wrap: wrap;
}
.titles {
  min-width: 0;
}
h2 {
  font-size: 1.25rem;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta {
  display: flex;
  gap: $gap-sm;
  flex-wrap: wrap;
  margin-top: 0.15rem;
  font-size: 0.8rem;
  color: var(--text-muted);

  span + span::before {
    content: '·';
    margin-right: $gap-sm;
    opacity: 0.5;
  }
}
.actions {
  display: flex;
  align-items: center;
  gap: $gap-sm;

  button {
    font-size: 0.85rem;
  }
}
</style>
