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

<style scoped lang="scss" src="@/styles/components/App.scss"></style>
