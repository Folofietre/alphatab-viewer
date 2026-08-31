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

        <!-- Undo and redo. Icon only, so the whole state goes in the tooltip:
             what would move, and how many steps are left before the 30-step
             bound. In the action bar rather than in a sidebar panel because they
             reach edits made from either of them. -->
        <button
          v-if="isScoreLoaded"
          type="button"
          class="bar-undo"
          :disabled="!canUndo"
          :title="undoLabel
            ? `Undo: ${undoLabel} (Ctrl+Z), ${undoDepth} step${undoDepth === 1 ? '' : 's'} available`
            : 'Nothing to undo (Ctrl+Z)'"
          aria-label="Undo the last edit"
          @click="undo"
        >&#8630;</button>

        <button
          v-if="isScoreLoaded"
          type="button"
          class="bar-undo"
          :disabled="!canRedo"
          :title="redoLabel
            ? `Redo: ${redoLabel} (Ctrl+Y), ${redoDepth} step${redoDepth === 1 ? '' : 's'} available`
            : 'Nothing to redo (Ctrl+Y)'"
          aria-label="Redo the last undone edit"
          @click="redo"
        >&#8631;</button>
      </div>

      <TransportBar v-if="isScoreLoaded" />
      <p v-else class="bar-placeholder">Drop a score to begin</p>

      <div class="bar-side bar-side-end">
        <BarsPerRow v-if="isScoreLoaded" />
        <!-- Always present, score or not: the shortcuts are worth reading before
             opening anything, and a help button that comes and goes is a help
             button nobody finds. -->
        <button
          type="button"
          class="bar-help"
          :aria-expanded="isHelpOpen"
          title="Keyboard and mouse shortcuts (?)"
          aria-label="Show the keyboard and mouse shortcuts"
          @click="toggleHelp"
        >?</button>
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
        :title="`Show the ${activePanelLabel.toLowerCase()} panel`"
        @click="isTracksOpen = true"
      >
        <span class="rail-icon" aria-hidden="true">&raquo;</span>
        <span class="rail-label">{{ activePanelLabel }}</span>
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
        <!-- Three panels, one at a time, split by SCOPE rather than by feature:
             Mixer is what you see and hear and is never saved; Track edits one
             track; Score edits the document. Mixing a tempo field in among a
             track's name and tuning was the confusion this replaces.

             Tabs rather than a stack: the sidebar is 290px wide and the track
             list is arbitrarily long, so a panel below it would be unreachable
             on a nine-track score. The strip also owns the collapse control,
             which is why TrackList no longer has one of its own. Undo is NOT
             here: it reaches edits from both panels, so it belongs in the action
             bar with the other document controls. -->
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
          <!-- Undo lives in the strip rather than in a panel: it reaches
               edits from both of them, and the strip is the only chrome that is
               present whichever panel is open. -->
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
             setup, and none of them is expensive enough to unmount. -->
        <TrackList v-show="panel === 'mixer'" />
        <TrackEditPanel v-show="panel === 'track'" />
        <ScoreEditPanel v-show="panel === 'score'" />
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

    <HelpDialog />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { usePlayer } from '@/composables/usePlayer'
import { useScoreEdit } from '@/composables/useScoreEdit'
import { useShortcuts } from '@/composables/useShortcuts'
import { useHelp } from '@/composables/useHelp'
import { useUnsavedGuard } from '@/composables/useUnsavedGuard'
import ScoreViewer from '@/components/ScoreViewer.vue'
import ScoreHeader from '@/components/ScoreHeader.vue'
import TrackList from '@/components/TrackList.vue'
import TrackEditPanel from '@/components/TrackEditPanel.vue'
import ScoreEditPanel from '@/components/ScoreEditPanel.vue'
import TransportBar from '@/components/TransportBar.vue'
import FileDropzone from '@/components/FileDropzone.vue'
import BarsPerRow from '@/components/BarsPerRow.vue'
import HelpDialog from '@/components/HelpDialog.vue'

const { loadFile, clearScore, isScoreLoaded, isDirty, scoreInfo, fileName, loadError } =
  usePlayer()

// The undo control sits in the action bar, not in a sidebar panel: it reaches
// edits made from either of them, and the bar is visible even with the sidebar
// collapsed.
const { undo, canUndo, undoLabel, undoDepth, redo, canRedo, redoLabel, redoDepth } =
  useScoreEdit()

// The shortcut help. Driven from here and from the "?" key, which is why the
// state lives in its own composable rather than in either.
const { isHelpOpen, toggleHelp } = useHelp()

// Every way out of a score goes through a confirmation while there are unsaved
// edits: the undo stack is bounded and is cleared with the score, so nothing
// else would stop the model being replaced.
//
// The two IN-APP ways - opening another file, closing this one - are handled
// here with a plain confirm, because this is where the layout owns those
// controls. Leaving the PAGE is the third way, and it needs a different
// mechanism entirely: see useUnsavedGuard.
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

// Which sidebar panel is showing.
//
// Named for the SCOPE each one acts on. "Mixer" rather than "Tracks", because
// "Tracks" next to "Track" reads as the same thing, and what that panel does is
// choose what is displayed and mix what is heard - none of which is saved.
const PANELS = [
  { id: 'mixer', label: 'Mixer' },
  { id: 'track', label: 'Track' },
  { id: 'score', label: 'Score' },
]
const panel = ref('mixer')

// The rail names the panel it will reveal, so collapsing does not lose the
// user's place.
const activePanelLabel = computed(
  () => PANELS.find((p) => p.id === panel.value)?.label ?? PANELS[0].label,
)

// Page-wide keys. Space is play/pause everywhere, including while a button
// still has focus from the last click.
useShortcuts()

// Reloading, closing the tab or navigating away with unsaved edits. Not a key
// handler: F5 is only two of the ways out. See useUnsavedGuard.
useUnsavedGuard()
</script>

<style scoped lang="scss" src="@/styles/components/App.scss"></style>
