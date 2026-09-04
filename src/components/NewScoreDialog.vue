<template>
  <!-- The same native <dialog> shell the other three modals use: backdrop, focus
       trap and Escape come with it, and the backdrop click is the one thing it
       does not handle. -->
  <dialog
    ref="dialog"
    class="new-score-dialog"
    aria-labelledby="new-score-title"
    @click="onBackdrop"
    @close="close"
  >
    <form class="sheet" @submit.prevent="onSubmit">
      <header>
        <h2 id="new-score-title">New score</h2>
        <button type="button" class="close" aria-label="Cancel" @click="close">&times;</button>
      </header>

      <div class="body">
        <!-- The document. Every field here is one the score header displays, so
             nothing shown on screen is left unfillable - and all of them are
             optional, because a blank score to try something out should not need
             a title first. -->
        <p class="group-label">The score</p>

        <label class="field">
          <span class="label">Title</span>
          <input ref="titleInput" v-model="title" type="text" maxlength="120" placeholder="Untitled" />
        </label>

        <div class="pair">
          <label class="field">
            <span class="label">Artist</span>
            <input v-model="artist" type="text" maxlength="120" />
          </label>
          <label class="field">
            <span class="label">Album</span>
            <input v-model="album" type="text" maxlength="120" />
          </label>
        </div>

        <div class="pair">
          <label class="field">
            <span class="label">Tempo (BPM)</span>
            <input v-model.number="tempo" type="number" min="10" max="400" step="1" />
          </label>
          <label class="field">
            <span class="label">Bars</span>
            <input v-model.number="bars" type="number" min="1" max="64" step="1" />
          </label>
        </div>

        <!-- Two fields rather than a list of the usual metres: 7/8 is as real as
             4/4, and the numerator is a free number in the model. -->
        <div class="field">
          <span class="label">Time signature</span>
          <div class="time-signature">
            <input v-model.number="numerator" type="number" min="1" max="32" step="1" aria-label="Beats per bar" />
            <span class="over">/</span>
            <select v-model.number="denominator" aria-label="Beat unit">
              <option v-for="value in TIME_SIGNATURE_DENOMINATORS" :key="value" :value="value">
                {{ value }}
              </option>
            </select>
          </div>
        </div>

        <hr />

        <!-- The first track, with the same three choices the Add track dialog
             makes, because it IS that operation: a created score is a blank
             score plus one added track. More tracks are added from the mixer. -->
        <p class="group-label">The first track</p>

        <label class="field">
          <span class="label">Name</span>
          <input v-model="trackName" type="text" maxlength="60" placeholder="Guitar" />
        </label>

        <label class="field">
          <span class="label">Instrument</span>
          <select v-model.number="program">
            <optgroup v-for="group in GM_GROUPS" :key="group.family" :label="group.family">
              <option v-for="option in group.options" :key="option.program" :value="option.program">
                {{ option.label }}
              </option>
            </optgroup>
          </select>
        </label>

        <label class="field">
          <span class="label">Tuning</span>
          <select v-model.number="tuningIndex">
            <optgroup
              v-for="group in tuningGroups"
              :key="group.stringCount"
              :label="`${group.stringCount} strings`"
            >
              <option v-for="choice in group.choices" :key="choice.index" :value="choice.index">
                {{ choice.name }}
              </option>
            </optgroup>
          </select>
        </label>

        <p class="hint">
          The score arrives with a rest in every bar. Click a string to put the
          cursor there and type a fret; the right arrow past the last bar adds
          another.
        </p>
      </div>

      <footer>
        <button type="button" class="ghost" @click="close">Cancel</button>
        <button type="submit" class="primary" :disabled="!tuning">Create</button>
      </footer>
    </form>
  </dialog>
</template>

<script setup>
import { computed, ref, watch, nextTick } from 'vue'
import { useScoreEdit } from '@/composables/useScoreEdit'
import { GM_GROUPS } from '@/utils/gmPrograms'

const open = defineModel({ type: Boolean })

const dialog = ref(null)
const titleInput = ref(null)

const {
  createNewScore,
  newTrackTuningGroups,
  TIME_SIGNATURE_DENOMINATORS,
  NEW_SCORE_BARS,
} = useScoreEdit()

// Grouped by string count, and the entries carry their index into the flat list:
// a `<select>` holds a value and a tuning is an array. Same arrangement as the
// Add track dialog, which is why the grouping lives in scoreEdits rather than
// being written out twice.
const tuningGroups = newTrackTuningGroups()
const flatTunings = tuningGroups.flatMap((group) => group.choices)
const DEFAULT_TUNING = flatTunings.find((c) => c.stringCount === 6) ?? flatTunings[0]

const title = ref('')
const artist = ref('')
const album = ref('')
const tempo = ref(120)
const bars = ref(NEW_SCORE_BARS)
const numerator = ref(4)
const denominator = ref(4)
const trackName = ref('')
const program = ref(25)
const tuningIndex = ref(DEFAULT_TUNING?.index ?? 0)

const tuning = computed(() => flatTunings.find((c) => c.index === tuningIndex.value) ?? null)

function reset() {
  title.value = ''
  artist.value = ''
  album.value = ''
  tempo.value = 120
  bars.value = NEW_SCORE_BARS
  numerator.value = 4
  denominator.value = 4
  trackName.value = ''
  program.value = 25
  tuningIndex.value = DEFAULT_TUNING?.index ?? 0
}

function onSubmit() {
  if (!tuning.value) return
  const result = createNewScore({
    title: title.value,
    artist: artist.value,
    album: album.value,
    tempo: tempo.value,
    barCount: bars.value,
    timeSignatureNumerator: numerator.value,
    timeSignatureDenominator: denominator.value,
    track: {
      name: trackName.value,
      program: program.value,
      tunings: tuning.value.tunings,
    },
  })
  // A refusal keeps the dialog open with the message in the Score panel, so the
  // number that was out of range can be corrected rather than retyped whole.
  if (result?.ok) close()
}

function close() {
  open.value = false
}

watch(open, async (isOpen) => {
  const el = dialog.value
  if (!el) return
  if (isOpen && !el.open) {
    reset()
    el.showModal()
    // The title is the only field with nothing sensible to default to.
    await nextTick()
    titleInput.value?.focus()
  } else if (!isOpen && el.open) {
    el.close()
  }
})

function onBackdrop(event) {
  if (event.target === dialog.value) close()
}
</script>

<style scoped lang="scss" src="@/styles/components/NewScoreDialog.scss"></style>
