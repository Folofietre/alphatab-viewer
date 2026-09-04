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

        <!-- The one real choice, and it is a NODE rather than an interval.
             Guitar Pro puts the harmonic type first, but every artificial
             harmonic written here is a pinch, so that field would be a select
             with one useful value in it. What it does need is the position: most
             intervals have several nodes along the string, so the group says
             what it sounds and the entries say where the right hand goes. -->
        <label class="field">
          <span class="label">Sounding note</span>
          <select v-model.number="value">
            <optgroup v-for="group in groups" :key="group.semitones" :label="group.label">
              <option v-for="choice in group.choices" :key="choice.harmonicValue" :value="choice.harmonicValue">
                {{ positionOf(choice) }}<template v-if="soundingName(choice)"> - {{ soundingName(choice) }}</template>
              </option>
            </optgroup>
          </select>
        </label>

        <!-- Read-outs, not fields: the pair a player reads, which is how Guitar
             Pro shows it. The left hand fret is where the note already is, and
             the right hand one is decided by the node picked above. -->
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
  offeredHarmonicNode,
  noteNameForMidi,
} = useScoreEdit()

const choices = harmonicSoundingChoices()

// One group per interval, the nodes inside it in reach order - which is the
// order `harmonicSoundingChoices` already comes in.
const groups = choices.reduce((acc, choice) => {
  let group = acc.find((g) => g.semitones === choice.semitones)
  if (!group) {
    group = { semitones: choice.semitones, label: choice.label, choices: [] }
    acc.push(group)
  }
  group.choices.push(choice)
  return acc
}, [])

const note = computed(() => selectedNote.value)
const range = computed(() => selectedRange.value)
const hasTarget = computed(() => !!range.value || !!note.value)

// The octave, which is the twelfth-fret node and the one anybody means by
// default.
const value = ref(12)

// Where the picking hand goes: the note's own fret plus the node's distance.
//
// The fractional nodes are between frets, so they are reported as such rather
// than rounded into a fret that is not where the finger goes.
const rightHandFret = computed(() => {
  const choice = choices.find((c) => c.harmonicValue === value.value)
  if (!note.value || !choice) return ''
  return round(note.value.fret + choice.frets)
})

// How one entry names its position. With a single note that is the absolute
// fret, which is what a player looks for; across a range every note has a
// different one, so it falls back to the distance the node is.
function positionOf(choice) {
  if (note.value && !range.value) return `Right hand ${round(note.value.fret + choice.frets)}`
  return `${choice.frets} frets up`
}

// Trims the float noise 4 + 2.4 leaves behind.
function round(value) {
  return Math.round(value * 10) / 10
}

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
    // on its own node rather than back at the octave. Through
    // `offeredHarmonicNode` because a file may carry a value we do not offer -
    // 3 and 3.2 are the same interval to alphaTab - and jumping to the octave
    // would retune the note the moment Apply is pressed.
    value.value = offeredHarmonicNode(note.value?.harmonicValue) ?? 12
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
