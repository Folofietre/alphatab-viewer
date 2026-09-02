<template>
  <!-- Document strip: what is currently open, and how full the cursor's bar is.
       Every action on the document as a whole - open, save, close - lives in the
       File menu in the action bar above, not here. -->
  <div class="score-header">
    <div class="doc">
      <h2 class="title">{{ info.title || fileName || 'Untitled score' }}</h2>
      <p class="meta">
        <span v-if="info.artist">{{ info.artist }}</span>
        <span v-if="info.album">{{ info.album }}</span>
        <span v-if="info.tempo">{{ info.tempo }} bpm</span>
        <span>{{ info.barCount }} bars</span>
        <span>{{ info.trackCount }} {{ info.trackCount === 1 ? 'track' : 'tracks' }}</span>
      </p>
    </div>

    <!-- How full the cursor's bar is, optically centred in the strip.
         Wrapped rather than placed directly in the grid: BarFill renders
         NOTHING when there is no cursor, and a component that renders nothing
         leaves no grid item, so the centre column would collapse and the strip
         would re-flow every time the selection was dropped. -->
    <div class="centre"><BarFill /></div>

  </div>
</template>

<script setup>
import BarFill from '@/components/BarFill.vue'

defineProps({
  info: { type: Object, required: true },
  fileName: { type: String, default: '' },
})
</script>

<style scoped lang="scss" src="@/styles/components/ScoreHeader.scss"></style>
