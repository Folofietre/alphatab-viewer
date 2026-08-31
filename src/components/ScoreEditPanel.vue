<template>
  <section class="score-edit-panel">
    <header>
      <h2>Score <span v-if="isDirty" class="dirty" title="This score has unsaved changes">modified</span></h2>
      <div class="bulk">
        <button
          type="button"
          :disabled="isExporting"
          title="Download this score as a .gp file"
          @click="download"
        >{{ isExporting ? 'Saving...' : 'Save .gp' }}</button>
        <button
          type="button"
          :disabled="!canRevert"
          title="Throw away every change and reload the file as it was opened"
          @click="onRevert"
        >Revert</button>
      </div>
    </header>

    <p v-if="!canEdit" class="message info" role="status">
      Paused only: press stop or pause to edit this score.
    </p>
    <p v-else-if="editMessage" class="message" :class="editMessage.kind" role="status">
      {{ editMessage.text }}
    </p>

    <!-- What is currently open. Read-only: this panel edits the score, and the
         document identity is not part of this tier. -->
    <div v-if="info" class="field">
      <label>Document</label>
      <p class="inspector">{{ info.title || fileName || 'Untitled score' }}</p>
      <p class="hint">
        {{ info.barCount }} bars, {{ info.trackCount }}
        {{ info.trackCount === 1 ? 'track' : 'tracks' }}<template v-if="info.artist">,
        {{ info.artist }}</template>
      </p>
    </div>

    <hr />

    <!-- Tempo. The count matters: above one, this field scales a whole tempo
         MAP written by the author rather than a single number. -->
    <div class="field">
      <label :for="ids.tempo">Tempo (BPM)</label>
      <div class="row">
        <input
          :id="ids.tempo"
          v-model="tempoDraft"
          type="number"
          :min="MIN_TEMPO"
          :max="MAX_TEMPO"
          step="1"
          :disabled="!canEdit"
          @change="commitTempo"
          @keydown.enter.prevent="commitTempo"
        />
      </div>
      <p class="hint">
        <template v-if="tempo.automationCount > 1">
          This score has {{ tempo.automationCount }} tempo changes. Setting this
          scales all of them, keeping the author's tempo map.
        </template>
        <template v-else>Written into the score and saved with it.</template>
        Use the transport's speed control to just listen slower: that one is not
        saved.
      </p>
    </div>

    <hr />

    <p class="legend">
      Names, instruments, tunings and transposition belong to a single track, and
      live in the <strong>Track</strong> tab.
    </p>
  </section>
</template>

<script setup>
import { ref, watch, useId } from 'vue'
import { usePlayer } from '@/composables/usePlayer'
import { useScoreEdit } from '@/composables/useScoreEdit'
import { MAX_TEMPO, MIN_TEMPO } from '@/utils/scoreEdits'

const { scoreInfo: info, fileName } = usePlayer()
const {
  tempo,
  canEdit,
  editMessage,
  isExporting,
  isDirty,
  setTempo,
  download,
  revert,
  canRevert,
} = useScoreEdit()

const base = useId()
const ids = { tempo: `${base}-tempo` }

// A local draft, re-seeded whenever the model changes underneath: after a
// revert, a new file, or an edit made from somewhere else.
const tempoDraft = ref('')

watch(
  () => tempo.value.tempo,
  (value) => {
    tempoDraft.value = value == null ? '' : String(value)
  },
  { immediate: true },
)

function commitTempo() {
  const result = setTempo(tempoDraft.value)
  // A refusal must not leave the field showing a value the score does not have.
  if (!result.ok) tempoDraft.value = tempo.value.tempo == null ? '' : String(tempo.value.tempo)
}

// The one destructive action here, and there is no undo, so it asks.
function onRevert() {
  if (isDirty.value && !window.confirm('Discard every change and reload the file as it was opened?')) {
    return
  }
  revert()
}
</script>

<style scoped lang="scss" src="@/styles/components/ScoreEditPanel.scss"></style>
