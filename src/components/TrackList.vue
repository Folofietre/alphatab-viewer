<template>
  <section class="track-panel">
    <header>
      <h2>Tracks <span class="count">{{ tracks.length }}</span></h2>
      <div class="bulk">
        <button type="button" title="Render every track" @click="showAllTracks">All</button>
        <button type="button" title="Reset volume, mute and solo" @click="resetMixer">Reset mix</button>
      </div>
    </header>

    <p class="legend">
      The checkbox controls what is <strong>displayed</strong>; mute, solo and volume
      control what is <strong>heard</strong>. Every track is audible whether it is
      displayed or not.
    </p>

    <ul class="tracks">
      <li v-for="track in tracks" :key="track.index" :class="{ rendered: track.rendered }">
        <div class="row-main">
          <input
            :id="`render-${track.index}`"
            type="checkbox"
            :checked="track.rendered"
            :disabled="track.rendered && renderedCount === 1"
            :title="track.rendered && renderedCount === 1
              ? 'At least one track must stay displayed'
              : 'Display this track'"
            @change="setTrackRendered(track.index, $event.target.checked)"
            @keydown.enter.prevent="setTrackRendered(track.index, !track.rendered)"
          />
          <label class="name" :for="`render-${track.index}`">
            <span
              class="dot"
              :style="track.color ? { background: track.color } : null"
              aria-hidden="true"
            />
            <span class="name-text">{{ track.name }}</span>
          </label>
          <button
            type="button"
            class="only"
            title="Display only this track"
            @click="showOnlyTrack(track.index)"
          >only</button>
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

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.track-panel {
  display: flex;
  flex-direction: column;
  gap: $gap-sm;
  min-width: 0;
}
header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: $gap-sm;

  h2 {
    @include section-label;
    font-size: 0.8rem;
  }
  .count {
    @include tabular;
    margin-left: 0.2rem;
    opacity: 0.6;
  }
}
.bulk {
  display: flex;
  gap: $gap-xs;

  button {
    padding: 0.2rem 0.5rem;
    font-size: 0.72rem;
  }
}
.legend {
  @include hint-text;
  font-size: 0.75rem;

  strong { font-style: normal; }
}
.tracks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: $gap-sm;
  overflow-y: auto;

  > li {
    @include nested-card;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.55rem 0.65rem;
    border-color: var(--panel-border);

    &.rendered {
      border-color: var(--accent-border);
      background: var(--accent-bg);
    }
  }
}
.row-main {
  display: flex;
  align-items: center;
  gap: $gap-sm;
  min-width: 0;
}
.name {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex: 1;
  min-width: 0;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-h);
}
.name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dot {
  width: 0.55rem;
  height: 0.55rem;
  flex: none;
  border-radius: 50%;
  background: var(--accent-soft);
  border: 1px solid rgba(0, 0, 0, 0.12);
}
.only {
  padding: 0.15rem 0.4rem;
  font-size: 0.68rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.row-sound {
  min-width: 0;
}
.program {
  font: inherit;
  font-size: 0.8rem;
  width: 100%;
  padding: 0.25rem 0.35rem;
  color: var(--text);
  background: var(--bg-surface);
  border: 1px solid var(--panel-border);
  border-radius: $radius-sm;
  cursor: pointer;

  &:hover {
    border-color: var(--accent-border);
  }
}
.percussion {
  display: inline-block;
  font-size: 0.78rem;
  color: var(--text-muted);
  font-style: italic;
}
.row-mix {
  display: flex;
  align-items: center;
  gap: 0.35rem;

  input[type='range'] {
    flex: 1;
    min-width: 0;
  }
}
.flag {
  width: 1.6rem;
  padding: 0.15rem 0;
  font-size: 0.7rem;
  font-weight: 700;
  text-align: center;

  &.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--text-inverse);
  }
}
.vol {
  @include tabular;
  width: 2.6rem;
  font-family: var(--mono);
  font-size: 0.68rem;
  text-align: right;
  color: var(--text-muted);
}
</style>
