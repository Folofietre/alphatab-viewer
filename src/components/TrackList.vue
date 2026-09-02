<template>
  <section class="track-panel">
    <!-- The panel's own explanation rides on its header rather than sitting
         under it as a paragraph: it is orientation, read once, and it was
         costing six permanent lines above the track list. -->
    <header v-help="PANEL_HELP">
      <h2>
        Mixer <span class="count">{{ tracks.length }}</span>
        <HelpTip />
      </h2>
      <div class="bulk">
        <button type="button" title="Render every track" @click="showAllTracks">All</button>
        <button type="button" title="Reset volume, mute and solo" @click="resetMixer">Reset mix</button>
      </div>
    </header>

    <ul class="tracks">
      <li v-for="track in tracks" :key="track.index" :class="{ rendered: track.rendered }">
        <div class="row-main">
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

        <!-- The instrument is shown but not editable here: it is written into
             the score, so it belongs with the other track edits rather than
             among the listening controls. The picker is in the Track tab. -->
        <div class="row-sound">
          <span v-if="!track.isPercussion" class="program" :title="`Instrument: ${track.programLabel}. Change it in the Track tab.`">
            {{ track.programLabel }}
          </span>
          <span v-else class="program" title="Percussion plays on the drum channel">
            🥁 Percussion kit
          </span>
        </div>

        <div class="row-mix">
          <span class="flags">
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
          <span class="vol">{{ Math.round(track.volume * 100) }}%</span>
        </div>

        <!-- Same grid as the row above, so this slider lines up under the
             volume one. Panning has no live synth setter, so it previews on
             `input` and only rebuilds the midi on `change` (release). -->
        <div class="row-mix">
          <span class="pan-label">Pan</span>
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
          <span class="vol">{{ formatBalance(track.balance) }}</span>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup>
import HelpTip from '@/components/HelpTip.vue'

// Written once, read twice: the header carries it as a tooltip over the whole
// strip, and the marker beside the title is the thing that says it is there.
const PANEL_HELP =
  'Click a track to show it alone, or tick its box to add it to the view. ' +
  'Mute, solo and volume control what is heard: every track is audible whether ' +
  'it is displayed or not, and none of it is saved with the score. Names, ' +
  'instruments and tunings are, and they live in the Track panel.'

import { computed } from 'vue'
import { usePlayer } from '@/composables/usePlayer'
import { formatBalance } from '@/utils/format'

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

const renderedCount = computed(() => tracks.value.filter((t) => t.rendered).length)
</script>

<style scoped lang="scss" src="@/styles/components/TrackList.scss"></style>
