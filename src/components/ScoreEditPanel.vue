<template>
  <section class="score-edit-panel">
    <header v-help="PANEL_HELP">
      <h2>
        Score <span v-if="isDirty" class="dirty" title="This score has unsaved changes">modified</span>
        <HelpTip />
      </h2>
      <div class="bulk">
        <button
          type="button"
          :disabled="isExporting"
          title="Download this score as a .gp file (Ctrl+S)"
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
    <div class="field" v-help="tempoHelp">
      <label :for="ids.tempo">Tempo (BPM)<HelpTip /></label>
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
    </div>

  </section>
</template>

<script setup>
import { computed, ref, watch, useId } from 'vue'
import { usePlayer } from '@/composables/usePlayer'
import { useScoreEdit } from '@/composables/useScoreEdit'
import { MAX_TEMPO, MIN_TEMPO } from '@/utils/scoreEdits'
import HelpTip from '@/components/HelpTip.vue'

const PANEL_HELP =
  'Everything here acts on the whole document. Ctrl+S saves the .gp file rather ' +
  'than the web page. Names, instruments, tunings and transposition belong to a ' +
  'single track and live in the Track panel; anything acting on the note or ' +
  'passage you have selected is in the Edit panel on the right.'

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

// Whether this field is setting one number or rescaling a whole tempo MAP is
// the thing worth knowing before typing in it, and it depends on the score, so
// the tooltip is built rather than written.
const tempoHelp = computed(() => {
  const count = tempo.value.automationCount
  const head =
    count > 1
      ? `This score has ${count} tempo changes. Setting this scales all of them, keeping the author's tempo map.`
      : 'Written into the score and saved with it.'
  return `${head} Use the transport's speed control to just listen slower: that one is not saved.`
})

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

// Reverting throws away EVERY edit at once, including any the 30-step undo
// stack has already dropped, so this is the one control that asks.
function onRevert() {
  if (isDirty.value && !window.confirm('Discard every change and reload the file as it was opened?')) {
    return
  }
  revert()
}
</script>

<style scoped lang="scss" src="@/styles/components/ScoreEditPanel.scss"></style>
