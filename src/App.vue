<template>
  <div class="app">
    <!-- The action bar owns every global control. It is always present so the
         window chrome does not shift when a score is opened. -->
    <header class="action-bar">
      <div class="bar-side">
        <FileDropzone
          v-if="isScoreLoaded"
          variant="compact"
          @file="loadFile"
        >Open</FileDropzone>
      </div>

      <TransportBar v-if="isScoreLoaded" />
      <p v-else class="bar-placeholder">Drop a score to begin</p>

      <div class="bar-side bar-side-end">
        <BarsPerRow v-if="isScoreLoaded" />
        <kbd v-if="isScoreLoaded" class="bar-hint" title="Space toggles playback">Space</kbd>
      </div>
    </header>

    <ScoreHeader
      v-if="isScoreLoaded && scoreInfo"
      :info="scoreInfo"
      :file-name="fileName"
      @close="clearScore"
    />

    <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>

    <div class="workspace">
      <!-- The collapsed rail. Always in the DOM and simply covered by the panel
           when it is open, so closing reveals it instead of popping it in. -->
      <button
        v-if="isScoreLoaded"
        type="button"
        class="rail"
        :class="{ covered: isTracksOpen }"
        :aria-expanded="isTracksOpen"
        :inert="isTracksOpen ? true : undefined"
        title="Show the track panel"
        @click="isTracksOpen = true"
      >
        <span class="rail-icon" aria-hidden="true">&raquo;</span>
        <span class="rail-label">Tracks</span>
      </button>

      <!-- `inert` rather than aria-hidden: the panel keeps focusable controls
           while it sits off-screen, and aria-hidden alone would leave them
           tabbable. Passing `undefined` rather than `false` matters, because
           any present value (including the string "false") makes an element
           inert, and Vue only omits an attribute when it is null/undefined. -->
      <aside
        v-if="isScoreLoaded"
        class="sidebar"
        :class="{ closed: !isTracksOpen }"
        :inert="isTracksOpen ? undefined : true"
      >
        <TrackList @close="isTracksOpen = false" />
      </aside>

      <div
        class="stage"
        :class="{ full: !isScoreLoaded, railed: isScoreLoaded && !isTracksOpen }"
      >
        <!-- ScoreViewer owns the alphaTab instance, so it stays mounted even
             before a file is dropped: `loadFile` needs a live api, and alphaTab
             needs a laid-out host element to measure against. -->
        <ScoreViewer />
        <div v-if="!isScoreLoaded" class="empty-overlay">
          <FileDropzone @file="loadFile" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { usePlayer } from '@/composables/usePlayer'
import { useShortcuts } from '@/composables/useShortcuts'
import ScoreViewer from '@/components/ScoreViewer.vue'
import ScoreHeader from '@/components/ScoreHeader.vue'
import TrackList from '@/components/TrackList.vue'
import TransportBar from '@/components/TransportBar.vue'
import FileDropzone from '@/components/FileDropzone.vue'
import BarsPerRow from '@/components/BarsPerRow.vue'

const { loadFile, clearScore, isScoreLoaded, scoreInfo, fileName, loadError } = usePlayer()

// The track panel slides away on request. State lives here because the panel
// and the action-bar toggle both drive it, and App owns the layout.
const isTracksOpen = ref(true)

// Page-wide keys. Space is play/pause everywhere, including while a button
// still has focus from the last click.
useShortcuts()
</script>

<style scoped lang="scss" src="@/styles/components/App.scss"></style>
