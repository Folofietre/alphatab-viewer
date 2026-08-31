<template>
  <section class="track-edit-panel">
    <header>
      <h2>Track</h2>
    </header>

    <p v-if="!canEdit" class="message info" role="status">
      Paused only: press stop or pause to edit this score.
    </p>
    <p v-else-if="editMessage" class="message" :class="editMessage.kind" role="status">
      {{ editMessage.text }}
    </p>

    <p v-if="!editedTrack" class="legend">No track to edit.</p>

    <template v-else>
      <!-- Which track everything below applies to. Deliberately separate from
           which tracks are DISPLAYED: clicking a note in the score sets this
           too, so the panel follows where you are working. -->
      <div class="field">
        <label :for="ids.track">Editing</label>
        <select
          :id="ids.track"
          :value="editedTrack.index"
          :disabled="!canEdit"
          @change="selectTrack(Number($event.target.value))"
        >
          <option v-for="track in tracks" :key="track.index" :value="track.index">
            {{ track.name }}
          </option>
        </select>
        <p class="hint">
          <template v-if="editedTrack.isStringed">
            {{ editedTrack.stringCount }} strings, frets
            {{ editedTrack.frets.min }}-{{ editedTrack.frets.max }},
            {{ editedTrack.frets.count }} notes
          </template>
          <template v-else>No tablature: frets and tunings do not apply.</template>
        </p>
      </div>

      <!-- Name. Commits on change and on Enter, never per keystroke: each
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

      <!-- Instrument. The 128 General MIDI programs, grouped by family.
           Percussion plays on the drum channel and is not addressed by a
           program number, so it gets a label instead. -->
      <div class="field">
        <label :for="ids.program">Instrument</label>
        <select
          v-if="!editedTrack.isPercussion"
          :id="ids.program"
          class="program"
          :value="editedTrack.program"
          :disabled="!canEdit"
          @change="setInstrument(Number($event.target.value))"
        >
          <optgroup v-for="group in GM_GROUPS" :key="group.family" :label="group.family">
            <option v-for="option in group.options" :key="option.program" :value="option.program">
              {{ option.label }}
            </option>
          </optgroup>
        </select>
        <p v-else class="inspector">Percussion kit</p>
        <p class="hint">
          Saved with the score. Volume, pan, mute and solo are listening
          settings and live in the <strong>Mixer</strong> tab.
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
        <select
          :id="ids.tuning"
          v-model="tuningId"
          :disabled="!canEdit || tuningOptions.length === 0"
        >
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

      <!-- A dragged range, or a single note: two selections, one at a time, the
           same two operations either way, and the same ring on the score marking
           every note that will change. alphaTab's own band stays underneath as
           what it actually is - the time span, and the loop range. -->
      <div class="field">
        <label>{{ selectedRange ? 'Selection' : 'Selected note' }}</label>

        <template v-if="selectedRange">
          <p class="inspector">
            <span class="badge">{{ selectedRange.noteCount }}</span>
            {{ selectedRange.noteCount === 1 ? 'note' : 'notes' }},
            bars {{ selectedRange.startBar + 1 }}-{{ selectedRange.endBar + 1 }}
          </p>

          <div class="row">
            <button
              type="button"
              :disabled="!canEdit"
              title="Move every note in the selection up one string, keeping the pitches"
              @click="nudgeSelectedString(1)"
            >String &uarr;</button>
            <button
              type="button"
              :disabled="!canEdit"
              title="Move every note in the selection down one string, keeping the pitches"
              @click="nudgeSelectedString(-1)"
            >String &darr;</button>
            <kbd>Alt + &uarr;&darr;</kbd>
          </div>

          <div class="row">
            <button
              type="button"
              :disabled="!canEdit"
              title="Move every note in the selection up a semitone"
              @click="nudgeSelectedFret(1)"
            >Pitch +1</button>
            <button
              type="button"
              :disabled="!canEdit"
              title="Move every note in the selection down a semitone"
              @click="nudgeSelectedFret(-1)"
            >Pitch -1</button>
            <kbd>Alt + &#8679; + &uarr;&darr;</kbd>
          </div>

          <div class="row">
            <button
              type="button"
              class="danger"
              :disabled="!canEdit"
              title="Replace every note in the selection with silence of the same length"
              @click="deleteSelection"
            >Silence</button>
            <kbd>Delete</kbd>
          </div>

          <p class="hint">
            Applied to <strong>every</strong> note at once, or to none: if one
            would run off the neck, the whole selection is refused. Drag on the
            score to change the range, or click a note to leave it.
            <strong>Silence</strong> cannot be undone: use <strong>Revert</strong>
            in the Score tab to get the file back.
          </p>
        </template>

        <p v-else-if="!selectedNote" class="hint">
          Click a note head to select one, or drag across the score to select a
          passage.
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
          <div class="row">
            <button
              type="button"
              class="danger"
              :disabled="!canEdit"
              title="Replace this note with silence of the same length"
              @click="deleteSelection"
            >Silence</button>
            <kbd>Delete</kbd>
          </div>

          <p class="hint">
            <strong>String</strong> keeps the pitch and only moves the fingering,
            so it stays silent. <strong>Pitch</strong> moves the note by a
            semitone on the same string, and plays it.
            <strong>Silence</strong> removes it, leaving a rest of the same
            length, and cannot be undone.
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
import { GM_GROUPS } from '@/utils/gmPrograms'

const { tracks } = usePlayer()
const {
  editedTrack,
  selectedNote,
  selectedRange,
  selectTrack,
  tuningOptions,
  canEdit,
  editMessage,
  rename,
  setInstrument,
  transposeByTuning,
  transposeByFrets,
  retune,
  nudgeSelectedFret,
  nudgeSelectedString,
  deleteSelection,
  MIN_FRET,
  MAX_FRET,
  RETUNE_KEEP_PITCH,
  RETUNE_REASSIGN,
} = useScoreEdit()

// Stable ids for the label/control pairs.
const base = useId()
const ids = {
  track: `${base}-track`,
  name: `${base}-name`,
  program: `${base}-program`,
  semitones: `${base}-semitones`,
  tuning: `${base}-tuning`,
}

// Local drafts. The model is the source of truth, so these mirror it and are
// re-seeded whenever it changes underneath.
const nameDraft = ref('')
const semitones = ref(1)
const tuningId = ref('')

watch(
  () => editedTrack.value?.name,
  (name) => {
    nameDraft.value = name ?? ''
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

function applyTuning(mode) {
  if (!pendingTuning.value) return
  retune(pendingTuning.value.tunings, mode)
}
</script>

<style scoped lang="scss" src="@/styles/components/TrackEditPanel.scss"></style>
