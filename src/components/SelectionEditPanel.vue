<template>
  <section class="selection-edit-panel">
    <header v-help="PANEL_HELP">
      <h2>Edit<HelpTip /></h2>
    </header>

    <p v-if="!canEdit" class="message info" role="status">
      Paused only: press stop or pause to edit this score.
    </p>
    <p v-else-if="editMessage" class="message" :class="editMessage.kind" role="status">
      {{ editMessage.text }}
    </p>

    <!-- A dragged range, or a single note: two selections, one at a time, the
         same operations either way, and the same ring on the score marking every
         note that will change. alphaTab's own band stays underneath as what it
         actually is - the time span, and the loop range. -->
    <div class="field" v-help="selectionHelp">
      <label>
        {{ selectedRange ? 'Selection' : 'Selected note' }}
        <HelpTip />
      </label>

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

        <!-- A whole octave, which is a re-fingering and not a fret shift: the
             string moves too when the fret alone cannot reach. -->
        <div class="row">
          <button
            type="button"
            :disabled="!canEdit"
            title="Move every note in the selection up an octave, changing string where the fret alone cannot reach"
            @click="shiftSelectedOctave(1)"
          >Octave +1</button>
          <button
            type="button"
            :disabled="!canEdit"
            title="Move every note in the selection down an octave. Notes already at the bottom of the tuning stay where they are."
            @click="shiftSelectedOctave(-1)"
          >Octave -1</button>
          <kbd>Alt + PageUp/Dn</kbd>
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
      </template>

      <p v-else-if="!selectedNote" class="hint">
        Click a note head, or drag across the score for a passage.
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

        <!-- Twelve semitones, which is often a different STRING and not just a
             different fret: an octave down is off the bottom of the instrument
             for most notes of a real score. -->
        <div class="row">
          <button
            type="button"
            :disabled="!canEdit"
            title="Up an octave. Moves to another string when the fret alone cannot reach."
            @click="shiftSelectedOctave(1)"
          >Octave +1</button>
          <button
            type="button"
            :disabled="!canEdit"
            title="Down an octave. Refused when the tuning does not go that low."
            @click="shiftSelectedOctave(-1)"
          >Octave -1</button>
          <kbd title="Alt and PageUp or PageDown move the note by a whole octave">Alt + PageUp/Dn</kbd>
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
      </template>
    </div>

    <hr />

    <!-- Where the cursor is. A position, which may hold a note or be an empty
         string: the same thing the ring or the dashed outline is drawn on. -->
    <div class="field" v-help="CURSOR_HELP">
      <label>Cursor<HelpTip /></label>
      <p v-if="!cursor" class="hint">Click anywhere in a bar to place it.</p>
      <template v-else>
        <p class="inspector">
          <span class="badge">Bar {{ cursor.barIndex + 1 }}</span>
          beat {{ cursor.beatIndex + 1 }}<template v-if="cursor.string">,
          string {{ cursor.string }}/{{ cursor.stringCount }}</template>
          <template v-else>, no string</template>
        </p>
        <p v-if="cursorBarFill" class="inspector">
          <span class="badge" :class="cursorBarFill.state">
            {{ cursorBarFill.beats }} / {{ cursorBarFill.beatCapacity }}
          </span>
          beats of {{ cursorBarFill.numerator }}/{{ cursorBarFill.denominator }}
        </p>
        <!-- Stays VISIBLE, unlike the rest of this panel's prose: it is not an
             explanation of a control, it is a fact about the bar the cursor is
             in, and it is the one thing nothing else in the chain reports. A
             warning nobody can see until they hover is not a warning. -->
        <p v-if="cursorBarFill?.state === 'over'" class="hint over">
          This bar holds <strong>more than its time signature allows</strong>,
          and every tool in the chain will save it that way without complaining.
        </p>
      </template>
    </div>

  </section>
</template>

<script setup>
import { computed } from 'vue'
import { useScoreEdit } from '@/composables/useScoreEdit'
import HelpTip from '@/components/HelpTip.vue'

const PANEL_HELP =
  'Everything here acts on what is selected in the score: one note, a dragged ' +
  'passage, or the cursor. Names, instruments, tunings and transposition act on ' +
  'a whole track and live in the Track panel; tempo and saving are in Score.'

const CURSOR_HELP =
  'Click anywhere in a bar to put the cursor there. Left and right walk the ' +
  'beats, crossing bars; up and down walk the strings of this beat. With ' +
  'nothing selected the arrows scroll the score instead.'

// Everything that acts on what is SELECTED, split out of the Track panel.
//
// The split is by scope, like the other three tabs: Mixer is what you hear,
// Track is one whole track, Score is the document, and this is whatever is
// currently picked out in the score. Mixing the two in one panel meant a note
// nudge sat under a track tuning, which are not the same size of change at all.
//
// The tab is labelled for the ACT rather than the scope, because the scope here
// has no short noun: it is a note, or a passage, or a position on an empty
// string, depending on what was last clicked.
// The two branches of this panel explain different things - a batch is all or
// nothing, a single note is not - so the field's tooltip switches with it
// rather than trying to cover both at once.
const selectionHelp = computed(() =>
  selectedRange.value
    ? 'String and Pitch apply to every note at once, or to none: if one would run off the neck, the whole selection is refused. ' +
      'Octave is the exception, and does what it can: a note the tuning cannot reach stays at the pitch it had rather than being moved to a wrong one. ' +
      'Drag on the score to change the range, or click a note to leave it. ' +
      'Silence cannot be undone: use Revert in the Score panel to get the file back.'
    : 'String keeps the pitch and only moves the fingering, so it stays silent. ' +
      'Pitch moves the note by a semitone on the same string, and plays it. ' +
      'Octave moves it twelve semitones and re-fingers it, changing string when the fret alone cannot reach, and refuses when no string can. ' +
      'Silence removes it, leaving a rest of the same length, and cannot be undone.',
)

const {
  selectedNote,
  selectedRange,
  cursor,
  cursorBarFill,
  canEdit,
  editMessage,
  nudgeSelectedFret,
  nudgeSelectedString,
  shiftSelectedOctave,
  deleteSelection,
} = useScoreEdit()
</script>

<style scoped lang="scss" src="@/styles/components/SelectionEditPanel.scss"></style>
