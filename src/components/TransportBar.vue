<template>
  <div class="transport">
    <div class="buttons">
      <button
        type="button"
        class="primary"
        :disabled="!isPlayerReady"
        :title="isPlaying ? 'Pause (Space)' : 'Play (Space)'"
        @click="playPause"
      >
        {{ isPlaying ? '❙❙' : '▶' }}
      </button>
      <button type="button" :disabled="!isPlayerReady" title="Stop" @click="stop">■</button>
    </div>

    <div class="seek">
      <span class="time">{{ formatTime(displayedTime) }}</span>
      <input
        type="range"
        min="0"
        :max="Math.max(1, position.endTime)"
        :value="displayedTime"
        :disabled="!isPlayerReady"
        @input="onScrub"
        @change="onScrubEnd"
      />
      <span class="time">{{ formatTime(position.endTime) }}</span>
    </div>

    <label class="knob">
      <span>Speed</span>
      <input v-model.number="playbackSpeed" type="range" min="0.25" max="2" step="0.05" />
      <output>{{ playbackSpeed.toFixed(2) }}×</output>
    </label>

    <label class="knob">
      <span>Volume</span>
      <input v-model.number="masterVolume" type="range" min="0" max="1" step="0.01" />
      <output>{{ Math.round(masterVolume * 100) }}%</output>
    </label>

    <!-- Icon-only, so both need an explicit accessible name and an explicit
         pressed state: with the words gone, the CSS `on` class is the only cue
         left for a sighted user and none at all for a screen reader. -->
    <div class="toggles">
      <button
        type="button"
        class="toggle"
        :class="{ on: isLooping }"
        :aria-pressed="isLooping"
        aria-label="Loop the song, or the selected range"
        title="Loop the song (or the selected range)"
        @click="isLooping = !isLooping"
      >
        <span class="icon icon-loop" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="toggle"
        :class="{ on: metronome }"
        :aria-pressed="metronome"
        aria-label="Metronome"
        title="Metronome"
        @click="metronome = !metronome"
      >
        <span class="icon icon-metronome" aria-hidden="true" />
      </button>
    </div>

    <span v-if="!isPlayerReady" class="loading">Loading soundfont…</span>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { usePlayer } from '@/composables/usePlayer'
import { formatTime } from '@/utils/format'

const {
  playPause,
  stop,
  seekToTime,
  isPlaying,
  isPlayerReady,
  position,
  masterVolume,
  playbackSpeed,
  isLooping,
  metronome,
} = usePlayer()

// While the user drags the handle, the slider shows the dragged value instead
// of the live playhead — otherwise playerPositionChanged keeps snapping the
// handle back under the cursor. The actual seek happens on release (`change`).
const isScrubbing = ref(false)
const scrubTime = ref(0)
const displayedTime = computed(() =>
  isScrubbing.value ? scrubTime.value : position.value.currentTime,
)

function onScrub(event) {
  isScrubbing.value = true
  scrubTime.value = Number(event.target.value)
}
function onScrubEnd(event) {
  isScrubbing.value = false
  seekToTime(Number(event.target.value))
}
</script>

<style scoped lang="scss" src="@/styles/components/TransportBar.scss"></style>
