<template>
  <main class="app">
    <header class="app-header">
      <h1>AlphaTab Viewer</h1>
      <span class="tagline">Drop a score, pick the tracks, choose their sound.</span>
    </header>

    <ScoreHeader
      v-if="isScoreLoaded && scoreInfo"
      :info="scoreInfo"
      :file-name="fileName"
      @file="loadFile"
      @close="clearScore"
    />

    <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>

    <div class="grid" :class="{ empty: !isScoreLoaded }">
      <aside v-if="isScoreLoaded" class="sidebar">
        <TrackList />
      </aside>

      <div class="stage">
        <!-- ScoreViewer owns the alphaTab instance, so it stays mounted even
             before a file is dropped: `loadFile` needs a live api, and alphaTab
             needs a laid-out host element to measure against. -->
        <ScoreViewer />
        <div v-if="!isScoreLoaded" class="empty-overlay">
          <FileDropzone @file="loadFile" />
        </div>
        <TransportBar v-if="isScoreLoaded" />
      </div>
    </div>
  </main>
</template>

<script setup>
import { usePlayer } from '@/composables/usePlayer'
import { useShortcuts } from '@/composables/useShortcuts'
import ScoreViewer from '@/components/ScoreViewer.vue'
import ScoreHeader from '@/components/ScoreHeader.vue'
import TrackList from '@/components/TrackList.vue'
import TransportBar from '@/components/TransportBar.vue'
import FileDropzone from '@/components/FileDropzone.vue'

const { loadFile, clearScore, isScoreLoaded, scoreInfo, fileName, loadError } = usePlayer()

// Page-wide keys. Space is play/pause everywhere, including while a button
// still has focus from the last click.
useShortcuts()
</script>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.app {
  display: flex;
  flex-direction: column;
  gap: $gap-md;
  padding: 0.9rem 1.1rem 1.2rem;
  max-width: 1600px;
  margin: 0 auto;
}
.app-header {
  display: flex;
  align-items: baseline;
  gap: $gap-md;
  flex-wrap: wrap;

  h1 {
    font-size: 1.3rem;
    letter-spacing: 0.02em;
  }
}
.tagline {
  font-size: 0.82rem;
  color: var(--text-muted);
}
.error {
  padding: 0.6rem 0.85rem;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  border-radius: $radius-sm;
  font-size: 0.88rem;
}
.grid {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: $gap-lg;
  align-items: start;

  &.empty {
    grid-template-columns: minmax(0, 1fr);
  }
}
.sidebar {
  min-width: 0;
  max-height: calc(100vh - 160px);
  overflow-y: auto;
}
.stage {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: $gap-sm;
  min-width: 0;
}
.empty-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: var(--bg);

  > * {
    width: min(520px, 100%);
  }
}
@media (max-width: 980px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .sidebar {
    max-height: none;
  }
}
</style>
