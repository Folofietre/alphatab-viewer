<template>
  <!-- The same native <dialog> the help uses, for the same reasons: it supplies
       the backdrop, the focus trap and Escape-to-close, and hand-rolling those is
       how half-accessible modals happen. The backdrop click is the one thing it
       does not handle, so the target is compared to the dialog itself. -->
  <dialog ref="dialog" class="add-track-dialog" aria-labelledby="add-track-title" @click="onBackdrop" @close="close">
    <form class="sheet" @submit.prevent="onSubmit">
      <header>
        <h2 id="add-track-title">New track</h2>
        <button type="button" class="close" aria-label="Cancel" @click="close">&times;</button>
      </header>

      <div class="body">
        <!-- Prefill first, because it is the shortcut past the other three: most
             new tracks in a piece are another of something already in it. It
             fills the fields rather than being remembered, so anything can then
             be changed - which is why it says "copy the settings of" and not
             "base this on". -->
        <label class="field">
          <span class="label">Copy the settings of</span>
          <select v-model="prefillFrom" @change="applyPrefill">
            <option value="">Nothing, start from defaults</option>
            <option v-for="track in stringedTracks" :key="track.index" :value="String(track.index)">
              {{ track.name }} - {{ track.programLabel }}, {{ track.tuningLabel }}
            </option>
          </select>
        </label>

        <hr />

        <label class="field">
          <span class="label">Name</span>
          <input
            ref="nameInput"
            v-model="name"
            type="text"
            maxlength="60"
            placeholder="Rhythm guitar"
          />
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

        <!-- The tuning is also the choice of how many strings the track has,
             since a track that does not exist yet has no string count. Grouped
             by that count so the list of forty reads as four short ones. -->
        <label class="field">
          <span class="label">Tuning</span>
          <select v-model.number="tuningIndex">
            <optgroup v-for="group in tuningGroups" :key="group.stringCount" :label="`${group.stringCount} strings`">
              <option v-for="choice in group.choices" :key="choice.index" :value="choice.index">
                {{ choice.name }}
              </option>
            </optgroup>
          </select>
        </label>

        <p class="hint">
          The track arrives empty, with a rest in every bar of the score, and is
          displayed straight away. <kbd>Ctrl/Cmd + Z</kbd> takes it back.
        </p>
      </div>

      <footer>
        <button type="button" class="ghost" @click="close">Cancel</button>
        <button type="submit" class="primary" :disabled="!canEdit">Add the track</button>
      </footer>
    </form>
  </dialog>
</template>

<script setup>
import { computed, ref, watch, nextTick } from 'vue'
import { usePlayer } from '@/composables/usePlayer'
import { useScoreEdit } from '@/composables/useScoreEdit'
import { GM_GROUPS } from '@/utils/gmPrograms'

const open = defineModel({ type: Boolean })

const dialog = ref(null)
const nameInput = ref(null)

const { tracks } = usePlayer()
const { canEdit, createTrack, newTrackTuningGroups } = useScoreEdit()

// Every preset alphaTab has, grouped by string count so a list of forty-nine
// reads as four short ones, with each entry carrying its position in the flat
// list: the select binds to that INDEX rather than to the tuning, because a
// tuning is an array and an array is not a value a <select> can carry.
//
// The grouping is in scoreEdits because the New score dialog offers the same
// list, and two copies of it could group it two ways.
const tuningGroups = newTrackTuningGroups()
const choices = tuningGroups.flatMap((group) => group.choices)

// Only tracks a new one can be modelled on. A percussion track has no tuning to
// copy, and this dialog only makes stringed tracks - offering it would fill the
// tuning field with nothing.
const stringedTracks = computed(() => tracks.value.filter((t) => t.isStringed))

const DEFAULT = choices.find((c) => c.stringCount === 6) ?? choices[0]

const name = ref('')
const program = ref(25)
const tuningIndex = ref(DEFAULT?.index ?? 0)
const prefillFrom = ref('')

function reset() {
  name.value = ''
  program.value = 25
  tuningIndex.value = DEFAULT?.index ?? 0
  prefillFrom.value = ''
}

// Copy a track's settings into the fields. Its own tuning may match no preset at
// all - measured, neither real test file's guitar tuning did - so the nearest
// choice is the first preset with the same string count, and the exact tuning
// travels separately in `spec.tunings`.
const prefilled = ref(null)

function applyPrefill() {
  const index = Number(prefillFrom.value)
  const track = tracks.value.find((t) => t.index === index)
  if (!track) {
    prefilled.value = null
    return
  }
  prefilled.value = track
  name.value = `${track.name} 2`
  program.value = track.program
  const match =
    choices.find((c) => c.tunings.join() === track.tuning.join()) ??
    choices.find((c) => c.stringCount === track.tuning.length)
  if (match) tuningIndex.value = match.index
}

function chosen() {
  const choice = choices.find((c) => c.index === tuningIndex.value)
  const source = prefilled.value
  // The source's own tuning wins over the preset when the two have the same
  // string count: it is what the user asked to copy, preset or not.
  const tunings =
    source && source.tuning.length === choice?.stringCount ? [...source.tuning] : choice?.tunings
  return {
    name: name.value,
    program: program.value,
    tunings: tunings ?? [],
    // Copied from the source, so a non-fretted track stays written where it
    // sounds. See `addTrack`.
    displayTranspositionPitch: source ? undefined : -12,
  }
}

function onSubmit() {
  const spec = chosen()
  if (spec.tunings.length === 0) return
  const result = createTrack(spec)
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
    // The name is the one field with nothing sensible to default to, so it is
    // where the caret belongs.
    await nextTick()
    nameInput.value?.focus()
  } else if (!isOpen && el.open) {
    el.close()
  }
})

function onBackdrop(event) {
  if (event.target === dialog.value) close()
}
</script>

<style scoped lang="scss" src="@/styles/components/AddTrackDialog.scss"></style>
