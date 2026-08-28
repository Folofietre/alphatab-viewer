<template>
  <section class="track-panel">
    <header>
      <h2>Tracks <span class="count">{{ tracks.length }}</span></h2>
      <div class="bulk">
        <button type="button" title="Render every track" @click="showAllTracks">All</button>
        <button type="button" title="Reset volume, mute and solo" @click="resetMixer">Reset mix</button>
        <button
          type="button"
          class="collapse"
          title="Hide this panel"
          aria-label="Hide the track panel"
          @click="$emit('close')"
        >&laquo;</button>
      </div>
    </header>

    <p class="legend">
      Click a track to show it <strong>alone</strong>, or tick its box to
      <strong>add</strong> it to the view. Mute, solo and volume control what is
      <strong>heard</strong>: every track is audible whether it is displayed or not.
    </p>

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
            @keydown.enter.prevent="setTrackRendered(track.index, !track.rendered)"
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

        <div class="row-sound">
          <select
            v-if="!track.isPercussion"
            class="program"
            :value="track.program"
            title="MIDI instrument used to play this track"
            @change="setTrackProgram(track.index, Number($event.target.value))"
          >
            <optgroup v-for="group in GM_GROUPS" :key="group.family" :label="group.family">
              <option v-for="option in group.options" :key="option.program" :value="option.program">
                {{ option.label }}
              </option>
            </optgroup>
          </select>
          <span v-else class="percussion" title="Percussion plays on the drum channel">
            🥁 Percussion kit
          </span>
        </div>

        <div class="row-mix">
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
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            :value="track.volume"
            title="Track volume"
            @input="setTrackVolume(track.index, Number($event.target.value))"
          />
          <span class="vol">{{ Math.round(track.volume * 100) }}%</span>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { usePlayer } from '@/composables/usePlayer'
import { GM_GROUPS } from '@/utils/gmPrograms'

defineEmits(['close'])

const {
  tracks,
  setTrackRendered,
  showOnlyTrack,
  showAllTracks,
  setTrackProgram,
  setTrackVolume,
  setTrackMute,
  setTrackSolo,
  resetMixer,
} = usePlayer()

const renderedCount = computed(() => tracks.value.filter((t) => t.rendered).length)
</script>

<style scoped lang="scss" src="@/styles/components/TrackList.scss"></style>
