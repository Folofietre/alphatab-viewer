<template>
  <section class="mixer">
    <header v-help="PANEL_HELP">
      <h2>
        Mixer <span class="count">{{ tracks.length }}</span>
        <HelpTip />
      </h2>
      <div class="bulk">
        <button type="button" title="Render every track" @click="showAllTracks">All</button>
        <button type="button" title="Reset volume, mute and solo" @click="resetMixer">Reset mix</button>
        <button
          type="button"
          class="collapse"
          title="Hide the mixer"
          aria-label="Hide the mixer"
          @click="$emit('collapse')"
        >&#9660;</button>
      </div>
    </header>

    <!-- One strip per track, side by side, scrolling sideways when there are
         more than fit. A desk rather than a list: the whole reason this moved to
         the bottom edge is that width is what a mixer wants. -->
    <ul class="strips">
      <li
        v-for="track in tracks"
        :key="track.index"
        class="strip"
        :class="{ rendered: track.rendered }"
        v-help="stripHelp(track)"
      >
        <div class="top">
          <input
            type="checkbox"
            :checked="track.rendered"
            :disabled="track.rendered && renderedCount === 1"
            :aria-label="`Also display ${track.name}`"
            :title="track.rendered && renderedCount === 1
              ? 'At least one track must stay displayed'
              : 'Add this track to the view'"
            @change="setTrackRendered(track.index, $event.target.checked)"
          />
          <button
            type="button"
            class="name"
            :title="`Show only ${track.name}`"
            @click="showOnlyTrack(track.index)"
          >
            <span
              class="dot"
              :style="track.color ? { background: track.color } : null"
              aria-hidden="true"
            />
            <span class="name-text">{{ track.name }}</span>
          </button>
        </div>

        <!-- Both sliders horizontal, and the same shape as each other: a
             vertical fader would have saved width, but two controls a
             centimetre apart pointing different ways cost more in reading than
             they save in pixels. The label and the value share a line above
             each one, which is what keeps them legible at the narrow end of the
             strip's range. -->
        <label class="control">
          <span class="control-head">
            <span class="control-label">Vol</span>
            <span class="read vol">{{ Math.round(track.volume * 100) }}%</span>
          </span>
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            :value="track.volume"
            :aria-label="`Volume for ${track.name}`"
            title="Track volume"
            @input="setTrackVolume(track.index, Number($event.target.value))"
          />
        </label>

        <!-- Panning has no live synth setter, so it previews on `input` and
             only rebuilds the midi on `change` (release). -->
        <label class="control">
          <span class="control-head">
            <span class="control-label">Pan</span>
            <span class="read">{{ formatBalance(track.balance) }}</span>
          </span>
          <input
            type="range"
            min="0"
            max="16"
            step="1"
            :value="track.balance"
            :aria-label="`Panning for ${track.name}`"
            title="Panning, applied when you release the slider"
            @input="setTrackBalance(track.index, Number($event.target.value), false)"
            @change="setTrackBalance(track.index, Number($event.target.value))"
          />
        </label>

        <div class="flags">
          <button
            type="button"
            class="flag"
            :class="{ on: track.isSolo }"
            title="Solo"
            @click="setTrackSolo(track.index, !track.isSolo)"
          >S</button>
          <button
            type="button"
            class="flag"
            :class="{ on: track.isMute }"
            title="Mute"
            @click="setTrackMute(track.index, !track.isMute)"
          >M</button>
          <!-- The only control in this strip that changes the FILE rather than
               what is heard, so it is the only one that is disabled while
               playing and the only one that is red. Icon-only, so it carries
               its own aria-label: with the words gone the mask is the whole
               cue, and none at all for a screen reader. -->
          <button
            type="button"
            class="flag trash"
            :disabled="!canEdit || tracks.length === 1"
            :aria-label="`Delete the track ${track.name}`"
            :title="deleteHelp(track)"
            @click="removeTrack(track.index)"
          >
            <span class="trash-icon" aria-hidden="true" />
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { usePlayer } from '@/composables/usePlayer'
import { useScoreEdit } from '@/composables/useScoreEdit'
import { formatBalance } from '@/utils/format'
import HelpTip from '@/components/HelpTip.vue'

defineEmits(['collapse'])

const PANEL_HELP =
  'Click a track name to show it alone, or tick its box to add it to the view. ' +
  'Mute, solo and volume control what is heard: every track is audible whether ' +
  'it is displayed or not, and none of it is saved with the score. Names, ' +
  'instruments and tunings are, and they live in the Track panel. ' +
  'The bin deletes a track from the score itself, notes and all - Ctrl+Z puts ' +
  'it back.'

const {
  tracks,
  setTrackRendered,
  showOnlyTrack,
  showAllTracks,
  setTrackVolume,
  setTrackBalance,
  setTrackMute,
  setTrackSolo,
  resetMixer,
} = usePlayer()

const { canEdit, removeTrack } = useScoreEdit()

const renderedCount = computed(() => tracks.value.filter((t) => t.rendered).length)

// Why the button is off, when it is, rather than a dead control with no
// explanation. Both reasons are real: a score cannot have no tracks, and every
// edit in this app is paused-only.
function deleteHelp(track) {
  if (tracks.value.length === 1) return 'The last track cannot be deleted'
  if (!canEdit.value) return 'Pause playback to delete a track'
  return `Delete ${track.name} and everything on it. Ctrl+Z puts it back.`
}

// The instrument used to have a line of its own in each row. A strip is narrow
// and gets narrower as tracks are added, so it moved into the strip's tooltip -
// which is the better place for it anyway, since it is shown here but edited in
// the Track panel.
function stripHelp(track) {
  const sound = track.isPercussion
    ? 'Percussion kit, playing on the drum channel.'
    : `Instrument: ${track.programLabel}. Change it in the Track panel.`
  return `${track.name}. ${sound}`
}
</script>

<style scoped lang="scss" src="@/styles/components/TrackList.scss"></style>
