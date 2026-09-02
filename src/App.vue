<template>
  <div class="app">
    <!-- The action bar owns every global control. It is always present so the
         window chrome does not shift when a score is opened. -->
    <header class="action-bar">
      <div class="bar-side">
        <!-- One File menu instead of an Open button here and a Close button in
             the strip below: everything you can do to the document as a whole,
             in the one place you would look for it. -->
        <FileMenu
          :is-score-loaded="isScoreLoaded"
          @file="openFile"
          @save="saveScore"
          @close="closeScore"
        />

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

    <ScoreHeader v-if="isScoreLoaded && scoreInfo" :info="scoreInfo" :file-name="fileName" />

    <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>

    <div class="workspace">
      <!-- The collapsed rail. Always in the DOM and simply covered by the panel
           when it is open, so closing reveals it instead of popping it in. -->
      <button
        v-if="isScoreLoaded"
        type="button"
        class="rail rail-left"
        :class="{ covered: isLeftOpen }"
        :aria-expanded="isLeftOpen"
        :inert="isLeftOpen ? true : undefined"
        :title="`Show the ${activeLeftPanelLabel.toLowerCase()} panel`"
        @click="isLeftOpen = true"
      >
        <span class="rail-icon" aria-hidden="true">&raquo;</span>
        <span class="rail-label">{{ activeLeftPanelLabel }}</span>
      </button>

      <!-- `inert` rather than aria-hidden: the panel keeps focusable controls
           while it sits off-screen, and aria-hidden alone would leave them
           tabbable. Passing `undefined` rather than `false` matters, because
           any present value (including the string "false") makes an element
           inert, and Vue only omits an attribute when it is null/undefined. -->
      <aside
        v-if="isScoreLoaded"
        class="sidebar sidebar-left"
        :class="{ closed: !isLeftOpen }"
        :inert="isLeftOpen ? undefined : true"
      >
        <!-- What is WRITTEN INTO the score, at its two scopes: one whole track,
             and the whole document. Split by scope rather than by feature -
             mixing a tempo field in among a track's name and tuning was the
             confusion this replaces.

             The other two scopes have their own edges of the window now. What is
             SELECTED is in the Edit panel on the right, and what is merely HEARD
             is in the mixer dock along the bottom: three kinds of control that
             no longer compete for the same 290px, and opening one no longer
             hides the others.

             The strip owns the collapse control, which is why neither panel has
             one of its own. Undo is NOT here: it reaches edits from both, so it
             belongs in the action bar with the other document controls. -->
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
            @click="isLeftOpen = false"
          >&laquo;</button>
        </div>

        <!-- v-show, not v-if: switching tabs must not throw away the panels'
             local state (a half-typed name, a chosen tuning) or re-run their
             setup, and none of them is expensive enough to unmount. -->
        <TrackEditPanel v-show="panel === 'track'" />
        <ScoreEditPanel v-show="panel === 'score'" />
      </aside>

      <div
        class="stage"
        :class="{
          full: !isScoreLoaded,
          'left-open': isScoreLoaded && isLeftOpen,
          'right-open': isScoreLoaded && isRightOpen,
        }"
      >
        <!-- ScoreViewer owns the alphaTab instance, so it stays mounted even
             before a file is dropped: `loadFile` needs a live api, and alphaTab
             needs a laid-out host element to measure against. -->
        <ScoreViewer />
        <div v-if="!isScoreLoaded" class="empty-overlay">
          <FileDropzone @file="openFile" />
        </div>
      </div>

      <!-- The mirror of the left sidebar, holding ONLY what is selected: one
           note, a dragged passage, or the cursor. It is a single panel rather
           than another tab strip, because there is nothing else at this scope
           to switch to - the label lives in SelectionEditPanel's own header,
           and this outer strip carries just the collapse control, exactly like
           the left one already does alongside its tabs. -->
      <aside
        v-if="isScoreLoaded"
        class="sidebar sidebar-right"
        :class="{ closed: !isRightOpen }"
        :inert="isRightOpen ? undefined : true"
      >
        <div class="panel-tabs panel-tabs-right">
          <button
            type="button"
            class="panel-collapse"
            title="Hide the edit panel"
            aria-label="Hide the edit panel"
            @click="isRightOpen = false"
          >&raquo;</button>
        </div>
        <SelectionEditPanel />
      </aside>

      <button
        v-if="isScoreLoaded"
        type="button"
        class="rail rail-right"
        :class="{ covered: isRightOpen }"
        :aria-expanded="isRightOpen"
        :inert="isRightOpen ? true : undefined"
        title="Show the edit panel"
        aria-label="Show the edit panel"
        @click="isRightOpen = true"
      >
        <span class="rail-icon" aria-hidden="true">&laquo;</span>
        <span class="rail-label">Edit</span>
      </button>
    </div>

    <!-- The mixer, docked across the bottom.
         Along the bottom rather than in a side tab for two reasons. It is a
         different SCOPE from either sidebar - nothing in it is saved with the
         score - and a mixer wants width: one narrow strip per track, side by
         side, the way a desk is laid out.
         It is also the cheapest edge to put it on. alphaTab re-lays out the
         whole score when its container WIDTH changes and only then
         (`AlphaTabApi` compares `container.width` to the renderer's), so a dock
         that changes the stage's height costs no re-layout at all, where the
         side panels each cost one per toggle. -->
    <aside v-if="isScoreLoaded && isMixerOpen" class="mixer-dock">
      <TrackList @collapse="isMixerOpen = false" />
    </aside>

    <button
      v-else-if="isScoreLoaded"
      type="button"
      class="mixer-rail"
      :aria-expanded="false"
      title="Show the mixer"
      @click="isMixerOpen = true"
    >
      <span aria-hidden="true">&#9650;</span>
      <span class="mixer-rail-label">Mixer</span>
    </button>

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
import SelectionEditPanel from '@/components/SelectionEditPanel.vue'
import TransportBar from '@/components/TransportBar.vue'
import FileDropzone from '@/components/FileDropzone.vue'
import FileMenu from '@/components/FileMenu.vue'
import BarsPerRow from '@/components/BarsPerRow.vue'
import HelpDialog from '@/components/HelpDialog.vue'

const { loadFile, clearScore, isScoreLoaded, isDirty, scoreInfo, fileName, loadError } =
  usePlayer()

// The undo control sits in the action bar, not in a sidebar panel: it reaches
// edits made from either of them, and the bar is visible even with the sidebar
// collapsed.
const {
  undo, canUndo, undoLabel, undoDepth,
  redo, canRedo, redoLabel, redoDepth,
  download,
} = useScoreEdit()

// Saving from the menu blurs first, for the same reason Ctrl+S does: the edit
// panels commit their text and number fields on `change`, which fires on blur,
// so a half-typed track name would otherwise be left out of the file.
function saveScore() {
  document.activeElement?.blur?.()
  download()
}


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

// Both sidebars slide away independently: they hold different SCOPES of
// control (global settings on the left, whatever is selected on the right), so
// there is no reason opening one should require closing the other. State lives
// here because a rail, a panel and App's own layout all need it.
const isLeftOpen = ref(true)
const isRightOpen = ref(true)

// The mixer dock. A plain show/hide rather than the slide the sidebars use:
// this one changes the stage's HEIGHT, which alphaTab does not react to at all,
// so there is no re-layout to spread over a transition and nothing to hide.
const isMixerOpen = ref(true)

// Which LEFT panel is showing. The other two docks hold exactly one panel each
// (SelectionEditPanel on the right, TrackList at the bottom) and so need no tab
// state of their own.
//
// Named for the SCOPE each one acts on, and each holds one scope and nothing
// else: Track carries no note controls and no listening controls, Score carries
// no track controls. What is selected went right, what is only heard went to the
// bottom, and what is left here is the two scopes that are written into the
// file - which is also why two tabs now fit where four were squeezed.
const PANELS = [
  { id: 'track', label: 'Track' },
  { id: 'score', label: 'Score' },
]
const panel = ref('track')

// The left rail names the panel it will reveal, so collapsing does not lose the
// user's place. The right rail needs no such lookup: it only ever says "Edit".
const activeLeftPanelLabel = computed(
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
