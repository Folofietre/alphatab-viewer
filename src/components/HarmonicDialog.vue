<template>
  <!-- The same native <dialog> shell the help and the new-track modal use, for
       the same reasons: backdrop, focus trap and Escape come with it. -->
  <dialog
    ref="dialog"
    class="harmonic-dialog"
    aria-labelledby="harmonic-title"
    @click="onBackdrop"
    @close="close"
  >
    <form class="sheet" @submit.prevent="onSubmit">
      <header>
        <h2 id="harmonic-title">Artificial harmonic</h2>
        <button type="button" class="close" aria-label="Cancel" @click="close">&times;</button>
      </header>

      <div class="body">
        <p class="target">
          <template v-if="range">
            <strong>{{ range.noteCount }}</strong> notes, bars
            {{ range.startBar + 1 }} to {{ range.endBar + 1 }}
          </template>
          <template v-else-if="note">
            String <strong>{{ note.string }}</strong>, fret
            <strong>{{ note.fret }}</strong>
          </template>
          <template v-else>Nothing selected.</template>
        </p>

        <!-- The one real choice. Guitar Pro puts the harmonic TYPE first, but
             every artificial harmonic written here is a pinch, so that field
             would be a select with one useful value in it. -->
        <label class="field">
          <span class="label">Sounding note</span>
          <select v-model.number="value">
            <option v-for="choice in choices" :key="choice.harmonicValue" :value="choice.harmonicValue">
              {{ choice.label }}<template v-if="soundingName(choice)"> - {{ soundingName(choice) }}</template>
            </option>
          </select>
        </label>

        <!-- Read-outs, not fields. The left hand fret is where the note already
             is, and the right hand fret follows from the interval chosen above,
             so both are shown and neither is editable: typing a right-hand fret
             would only be a second way of picking the same interval. -->
        <div v-if="note && !range" class="frets">
          <span class="fret">
            <span class="label">Left hand</span>
            <strong>{{ note.fret }}</strong>
          </span>
          <span class="fret">
            <span class="label">Right hand</span>
            <strong>{{ rightHandFret }}</strong>
          </span>
        </div>

        <p class="hint">
          Written as a pinch harmonic. <kbd>Y</kbd> writes the natural harmonic of
          the fret instead, and <kbd>Ctrl/Cmd + Z</kbd> takes either back.
        </p>
      </div>

      <footer>
        <!-- The way off, for a note that already carries one. Beside Cancel
             rather than in the list above, because "no harmonic" is not one of
             the intervals. -->
        <button type="button" class="ghost danger" :disabled="!canRemove" @click="onRemove">
          Remove
        </button>
        <span class="spacer" />
        <button type="button" class="ghost" @click="close">Cancel</button>
        <button type="submit" class="primary" :disabled="!hasTarget">Apply</button>
      </footer>
    </form>
  </dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useScoreEdit } from '@/composables/useScoreEdit'

const open = defineModel({ type: Boolean })

const dialog = ref(null)

const {
  selectedNote,
  selectedRange,
  setHarmonic,
  harmonicSoundingChoices,
  noteNameForMidi,
} = useScoreEdit()

const choices = harmonicSoundingChoices()

const note = computed(() => selectedNote.value)
const range = computed(() => selectedRange.value)
const hasTarget = computed(() => !!range.value || !!note.value)

// The octave, which is the twelfth-fret node and the one anybody means by
// default.
const value = ref(12)

// Where the picking hand goes: the note's own fret plus the node's distance.
// Only shown for a single note - across a range every note has a different one.
const rightHandFret = computed(() => {
  const choice = choices.find((c) => c.harmonicValue === value.value)
  if (!note.value || !choice) return ''
  // The fractional nodes are between frets, so they are reported as such rather
  // than rounded into a fret that is not where the finger goes.
  return note.value.fret + choice.frets
})

// What the chosen interval would sound, from the PLAIN fretted pitch: the note's
// own `midiKey` already carries whatever harmonic is on it, so adding to that
// would compound them.
function soundingName(choice) {
  const base = note.value?.frettedMidiKey
  if (!Number.isFinite(base) || range.value) return ''
  return noteNameForMidi(base + choice.semitones)
}

const canRemove = computed(
  () => !!range.value || !!note.value?.isNaturalHarmonic || !!note.value?.isArtificialHarmonic,
)

function onSubmit() {
  const result = setHarmonic(value.value)
  if (result?.ok) close()
}

function onRemove() {
  const result = setHarmonic(null)
  if (result?.ok) close()
}

function close() {
  open.value = false
}

watch(open, (isOpen) => {
  const el = dialog.value
  if (!el) return
  if (isOpen && !el.open) {
    // Opened showing what is already there, so a note carrying a harmonic starts
    // on its own interval rather than back at the octave.
    const current = note.value?.harmonicValue
    value.value = choices.some((c) => c.harmonicValue === current) ? current : 12
    el.showModal()
  } else if (!isOpen && el.open) {
    el.close()
  }
})

function onBackdrop(event) {
  if (event.target === dialog.value) close()
}
</script>

<style scoped lang="scss" src="@/styles/components/HarmonicDialog.scss"></style>
