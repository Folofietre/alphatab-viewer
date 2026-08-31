<template>
  <div class="app">
    <!-- The action bar owns every global control. It is always present so the
         window chrome does not shift when a score is opened. -->
    <header class="action-bar">
      <div class="bar-side">
        <FileDropzone
          v-if="isScoreLoaded"
          variant="compact"
          @file="openFile"
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
      @close="closeScore"
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
        :title="`Show the ${panel === 'edit' ? 'edit' : 'track'} panel`"
        @click="isTracksOpen = true"
      >
        <span class="rail-icon" aria-hidden="true">&raquo;</span>
        <span class="rail-label">{{ panel === 'edit' ? 'Edit' : 'Tracks' }}</span>
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
        <!-- Two panels, one at a time. Tabs rather than a stack: the sidebar is
             290px wide and the track list is arbitrarily long, so an edit panel
             below it would be unreachable on a nine-track score. The strip also
             owns the collapse control, which is why TrackList no longer has one
             of its own. -->
        <div class="panel-tabs">
          <!-- Toggle buttons with aria-pressed rather than role="tab": a real
               tablist promises arrow-key navigation between tabs and an
               aria-controls / role="tabpanel" pairing, and a half-implemented
               one is worse for a screen reader than an honest pair of
               toggles. -->
          <div class="tabs">
            <button
              v-for="tab in PANELS"
              :key="tab.id"
              type="button"
              class="tab"
              :class="{ on: panel === tab.id }"
              :aria-pressed="panel === tab.id"
              @click="panel = tab.id"
            >{{ tab.label }}</button>
          </div>
          <button
            type="button"
            class="panel-collapse"
            title="Hide this panel"
            aria-label="Hide the sidebar panel"
            @click="isTracksOpen = false"
          >&laquo;</button>
        </div>

        <!-- v-show, not v-if: switching tabs must not throw away the panels'
             local state (a half-typed name, a chosen tuning) or re-run their
             setup, and neither panel is expensive enough to unmount. -->
        <TrackList v-show="panel === 'tracks'" />
        <EditPanel v-show="panel === 'edit'" />
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
          <FileDropzone @file="openFile" />
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
import EditPanel from '@/components/EditPanel.vue'
import TransportBar from '@/components/TransportBar.vue'
import FileDropzone from '@/components/FileDropzone.vue'
import BarsPerRow from '@/components/BarsPerRow.vue'

const { loadFile, clearScore, isScoreLoaded, isDirty, scoreInfo, fileName, loadError } =
  usePlayer()

// Both ways out of a score go through a confirmation while there are unsaved
// edits, because there is no undo and nothing else would stop the model being
// replaced.
//
// Deliberately NOT a `beforeunload` handler: the browser shows its own
// unskippable dialog for that, which is out of proportion for a viewer, and it
// would fire on every reload during development.
function confirmDiscard(question) {
  return !isDirty.value || window.confirm(`This score has unsaved changes. ${question}`)
}

function openFile(file) {
  if (!confirmDiscard('Open another file anyway?')) return
  loadFile(file)
}

function closeScore() {
  if (!confirmDiscard('Close it anyway?')) return
  clearScore()
}

// The sidebar slides away on request. State lives here because the panel and the
// rail both drive it, and App owns the layout.
const isTracksOpen = ref(true)

// Which of the two sidebar panels is showing.
const PANELS = [
  { id: 'tracks', label: 'Tracks' },
  { id: 'edit', label: 'Edit' },
]
const panel = ref('tracks')

// Page-wide keys. Space is play/pause everywhere, including while a button
// still has focus from the last click.
useShortcuts()
</script>

<style scoped lang="scss" src="@/styles/components/App.scss"></style>
