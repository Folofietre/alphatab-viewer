<template>
  <!-- Document strip: what is currently open, and how to close it. Global
       actions live in the action bar above, not here. -->
  <div class="score-header">
    <h2 class="title">{{ info.title || fileName || 'Untitled score' }}</h2>
    <p class="meta">
      <span v-if="info.artist">{{ info.artist }}</span>
      <span v-if="info.album">{{ info.album }}</span>
      <span v-if="info.tempo">{{ info.tempo }} bpm</span>
      <span>{{ info.barCount }} bars</span>
      <span>{{ info.trackCount }} {{ info.trackCount === 1 ? 'track' : 'tracks' }}</span>
    </p>
    <button type="button" class="close" @click="$emit('close')">Close</button>
  </div>
</template>

<script setup>
defineProps({
  info: { type: Object, required: true },
  fileName: { type: String, default: '' },
})
defineEmits(['close'])
</script>

<style scoped lang="scss" src="@/styles/components/ScoreHeader.scss"></style>
