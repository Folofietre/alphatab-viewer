<template>
  <div class="transport">
    <div class="buttons">
      <button
        type="button"
        class="primary"
        :disabled="!isPlayerReady"
        :title="isPlaying ? 'Pause' : 'Play'"
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

    <div class="toggles">
      <button
        type="button"
        :class="{ on: isLooping }"
        title="Loop the song (or the selected range)"
        @click="isLooping = !isLooping"
      >Loop</button>
      <button
        type="button"
        :class="{ on: metronome }"
        title="Metronome"
        @click="metronome = !metronome"
      >Click</button>
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

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.transport {
  @include panel-card;
  display: flex;
  align-items: center;
  gap: $gap-lg;
  padding: 0.55rem 0.8rem;
  flex-wrap: wrap;
}
.buttons {
  display: flex;
  gap: $gap-xs;

  button {
    width: 2.4rem;
    padding: 0.35rem 0;
    text-align: center;
    line-height: 1.2;
  }
  .primary {
    @include button-accent;
    width: 2.8rem;
  }
}
.seek {
  display: flex;
  align-items: center;
  gap: $gap-sm;
  flex: 1 1 260px;
  min-width: 200px;

  input {
    flex: 1;
    min-width: 0;
  }
}
.time {
  @include tabular;
  font-family: var(--mono);
  font-size: 0.8rem;
  color: var(--text-muted);
}
.knob {
  display: flex;
  align-items: center;
  gap: $gap-sm;
  font-size: 0.8rem;
  color: var(--text-muted);

  input {
    width: 100px;
  }
  output {
    @include tabular;
    width: 3.4rem;
    font-family: var(--mono);
    font-size: 0.75rem;
    text-align: right;
  }
}
.toggles {
  display: flex;
  gap: $gap-xs;

  button {
    font-size: 0.78rem;
    padding: 0.35rem 0.6rem;

    &.on {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--text-inverse);
    }
  }
}
.loading {
  @include hint-text;
  font-size: 0.75rem;
}
</style>
