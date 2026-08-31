<template>
  <section class="edit-panel">
    <header>
      <h2>Edit <span v-if="isDirty" class="dirty" title="This score has unsaved changes">modified</span></h2>
      <div class="bulk">
        <button
          type="button"
          :disabled="isExporting"
          :title="isDirty ? 'Download this score as a .gp file' : 'Download this score as a .gp file (nothing changed yet)'"
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

    <!-- Editing stands down during playback. Saying so, and disabling the
         controls, beats letting a click do nothing. -->
    <p v-if="!canEdit" class="message info" role="status">
      Paused only: press stop or pause to edit this score.
    </p>
    <p v-else-if="editMessage" class="message" :class="editMessage.kind" role="status">
      {{ editMessage.text }}
    </p>

    <p v-if="!editedTrack" class="legend">No track to edit.</p>

    <template v-else>
      <!-- Which track the edits apply to. Deliberately separate from which
           tracks are DISPLAYED: clicking a note in the score also sets this. -->
      <div class="field">
        <label :for="ids.track">Track being edited</label>
        <select
          :id="ids.track"
          :disabled="!canEdit"
          :value="editedTrack.index"
          @change="selectTrack(Number($event.target.value))"
        >
          <option v-for="track in tracks" :key="track.index" :value="track.index">
            {{ track.name }}
          </option>
        </select>
        <p class="hint">
          {{ editedTrack.programLabel }}<template v-if="editedTrack.isStringed">,
          {{ editedTrack.stringCount }} strings, frets
          {{ editedTrack.frets.min }}-{{ editedTrack.frets.max }}</template>
        </p>
      </div>

      <!-- Rename. Commits on change and on Enter, never per keystroke: each
           commit re-renders the notation to repaint the stave label. -->
      <div class="field">
        <label :for="ids.name">Name</label>
        <input
          :id="ids.name"
          v-model="nameDraft"
          type="text"
          maxlength="120"
          :disabled="!canEdit"
          @change="commitName"
          @keydown.enter.prevent="commitName"
        />
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

      <!-- Transposition. Two genuinely different operations, so two buttons
           rather than one with a hidden mode. -->
      <div class="field">
        <label :for="ids.semitones">Transpose (semitones)</label>
        <div class="row">
          <input
            :id="ids.semitones"
            v-model.number="semitones"
            type="number"
            min="-24"
            max="24"
            step="1"
            :disabled="!canEdit"
          />
          <button
            type="button"
            :disabled="!canEdit || !editedTrack.isStringed"
            title="Shift the tuning and leave the frets alone, the way detuning does. Always playable."
            @click="transposeByTuning(semitones)"
          >Detune</button>
          <button
            type="button"
            :disabled="!canEdit || !editedTrack.isStringed"
            title="Move every fret and leave the tuning alone. Refused if it would run off the neck."
            @click="transposeByFrets(semitones)"
          >Move frets</button>
        </div>
        <p class="hint">
          <strong>Detune</strong> keeps the fingering. <strong>Move frets</strong>
          keeps the tuning, and is refused when a note would land outside frets
          {{ MIN_FRET }}-{{ MAX_FRET }}.
          <template v-if="editedTrack.naturalHarmonics > 0">
            This track has {{ editedTrack.naturalHarmonics }} natural harmonics,
            which sound at their node rather than at their fret, so only
            <strong>Detune</strong> can move them.
          </template>
        </p>
      </div>

      <hr />

      <!-- Tuning. Same shape as transposition: pick the target, then say which
           of the two things to preserve. -->
      <div class="field">
        <label :for="ids.tuning">Tuning</label>
        <select :id="ids.tuning" v-model="tuningId" :disabled="!canEdit || tuningOptions.length === 0">
          <option v-for="option in tuningOptions" :key="option.id" :value="option.id">
            {{ option.label }}
          </option>
        </select>
        <div class="row">
          <button
            type="button"
            :disabled="!canEdit || !pendingTuning || pendingTuning.isCurrent"
            title="Move the frets so the score sounds exactly as it does now"
            @click="applyTuning(RETUNE_KEEP_PITCH)"
          >Keep pitches</button>
          <button
            type="button"
            :disabled="!canEdit || !pendingTuning || pendingTuning.isCurrent"
            title="Leave the frets where they are and let the pitches move"
            @click="applyTuning(RETUNE_REASSIGN)"
          >Keep frets</button>
        </div>
        <p class="hint">
          Currently {{ editedTrack.tuningLabel || 'no tablature' }}<template
            v-if="editedTrack.tuningName"
          > ({{ editedTrack.tuningName }})</template>. Changing the number of
          strings is not supported.
        </p>
      </div>

      <hr />

      <!-- Note inspector. Text only: drawing a highlight on the score means
           boundsLookup, a positioned overlay and invalidating it on every
           re-render, which is out of scope for this tier. -->
      <div class="field">
        <label>Selected note</label>
        <p v-if="!selectedNote" class="hint">
          Click a note in the score to select it.
        </p>
        <template v-else>
          <p class="inspector">
            <span class="badge">{{ selectedNote.noteName }}</span>
            <template v-if="selectedNote.barIndex !== null">bar {{ selectedNote.barIndex + 1 }},</template>
            string {{ selectedNote.string }}/{{ selectedNote.stringCount }},
            fret {{ selectedNote.fret }}
          </p>

          <!-- Move it across the neck: same note, different fingering. -->
          <div class="row">
            <button
              type="button"
              :disabled="!canEdit || selectedNote.string >= selectedNote.stringCount"
              title="Move to the next string up, keeping the same pitch"
              @click="nudgeSelectedString(1)"
            >String &uarr;</button>
            <button
              type="button"
              :disabled="!canEdit || selectedNote.string <= 1"
              title="Move to the next string down, keeping the same pitch"
              @click="nudgeSelectedString(-1)"
            >String &darr;</button>
            <kbd title="Alt and the up or down arrow move the note across the strings">Alt + &uarr;&darr;</kbd>
          </div>

          <!-- Change what it sounds. -->
          <div class="row">
            <button
              type="button"
              :disabled="!canEdit"
              title="One semitone up: the same string, one fret higher. Sounds the new note."
              @click="nudgeSelectedFret(1)"
            >Pitch +1</button>
            <button
              type="button"
              :disabled="!canEdit"
              title="One semitone down: the same string, one fret lower. Sounds the new note."
              @click="nudgeSelectedFret(-1)"
            >Pitch -1</button>
            <kbd title="Alt, Shift and the up or down arrow transpose the note by a semitone">Alt + &#8679; + &uarr;&darr;</kbd>
          </div>
          <p class="hint">
            <strong>String</strong> keeps the pitch and only moves the fingering,
            so it stays silent. <strong>Pitch</strong> moves the note by a
            semitone on the same string, and plays it.
          </p>
        </template>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, ref, watch, useId } from 'vue'
import { usePlayer } from '@/composables/usePlayer'
import { useScoreEdit } from '@/composables/useScoreEdit'
import { MAX_TEMPO, MIN_TEMPO } from '@/utils/scoreEdits'

const { tracks } = usePlayer()
const {
  editedTrack,
  selectedNote,
  selectTrack,
  tuningOptions,
  tempo,
  canEdit,
  editMessage,
  isExporting,
  isDirty,
  rename,
  setTempo,
  transposeByTuning,
  transposeByFrets,
  retune,
  nudgeSelectedFret,
  nudgeSelectedString,
  download,
  revert,
  canRevert,
  MIN_FRET,
  MAX_FRET,
  RETUNE_KEEP_PITCH,
  RETUNE_REASSIGN,
} = useScoreEdit()

// Stable ids for the label/control pairs, so every <label for> points at its own
// control even though this panel is mounted once per app.
const base = useId()
const ids = {
  track: `${base}-track`,
  name: `${base}-name`,
  tempo: `${base}-tempo`,
  semitones: `${base}-semitones`,
  tuning: `${base}-tuning`,
}

// Local drafts. The model is the source of truth, so these mirror it and are
// re-seeded whenever it changes underneath - after a revert, a new file, or an
// edit made from somewhere else.
const nameDraft = ref('')
const tempoDraft = ref('')
const semitones = ref(1)
const tuningId = ref('')

watch(
  () => editedTrack.value?.name,
  (name) => {
    nameDraft.value = name ?? ''
  },
  { immediate: true },
)

watch(
  () => tempo.value.tempo,
  (value) => {
    tempoDraft.value = value == null ? '' : String(value)
  },
  { immediate: true },
)

// Re-seed the tuning picker from whatever the track's tuning currently is, so it
// shows the truth rather than a stale pick after an edit or a track change.
watch(
  tuningOptions,
  (options) => {
    tuningId.value = options.find((option) => option.isCurrent)?.id ?? options[0]?.id ?? ''
  },
  { immediate: true },
)

const pendingTuning = computed(
  () => tuningOptions.value.find((option) => option.id === tuningId.value) ?? null,
)

function commitName() {
  const result = rename(nameDraft.value)
  // A refusal (an empty name) must not leave the field showing something the
  // score does not have.
  if (!result.ok) nameDraft.value = editedTrack.value?.name ?? ''
}

function commitTempo() {
  const result = setTempo(tempoDraft.value)
  if (!result.ok) tempoDraft.value = tempo.value.tempo == null ? '' : String(tempo.value.tempo)
}

function applyTuning(mode) {
  if (!pendingTuning.value) return
  retune(pendingTuning.value.tunings, mode)
}

// The one destructive action in the panel, and there is no undo, so it asks.
function onRevert() {
  if (isDirty.value && !window.confirm('Discard every change and reload the file as it was opened?')) {
    return
  }
  revert()
}
</script>

<style scoped lang="scss" src="@/styles/components/EditPanel.scss"></style>
