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

<style scoped lang="scss" src="@/styles/components/ScoreHeader.scss"></style>
