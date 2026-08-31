<template>
  <div class="bars-per-row">
    <label class="toggle" title="Force a fixed number of bars on every line">
      <input
        type="checkbox"
        :checked="forceBarsPerRow"
        @change="setForceBarsPerRow($event.target.checked)"
      />
      <span>Bars/line</span>
    </label>

    <!-- Commits on `change`, not `input`: each commit re-lays out the whole
         score, so it must not fire per keystroke. -->
    <input
      class="count"
      type="number"
      min="1"
      max="32"
      step="1"
      :value="barsPerRow"
      :disabled="!forceBarsPerRow"
      aria-label="Bars per line"
      @change="setBarsPerRow(Number($event.target.value))"
    />
  </div>
</template>

<script setup>
import { usePlayer } from '@/composables/usePlayer'

const { forceBarsPerRow, barsPerRow, setForceBarsPerRow, setBarsPerRow } = usePlayer()
</script>

<style scoped lang="scss" src="@/styles/components/BarsPerRow.scss"></style>
