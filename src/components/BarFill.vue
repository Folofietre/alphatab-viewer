<template>
  <!-- Only with a cursor: this describes ONE bar, and without a cursor there is
       no bar it could be describing. A permanently visible slot showing "-" for
       most of a session would be chrome that never says anything. -->
  <p
    v-if="fill"
    class="bar-fill"
    :class="fill.state"
    :title="title"
  >
    <span class="where">Bar {{ fill.barIndex + 1 }}</span>
    <span class="count">{{ fill.beats }} / {{ fill.beatCapacity }}</span>
    <span class="unit">{{ fill.numerator }}/{{ fill.denominator }}</span>
  </p>
</template>

<script setup>
import { computed } from 'vue'
import { useScoreEdit } from '@/composables/useScoreEdit'

// How full the cursor's bar is, in BEATS of its own time signature.
//
// In beats rather than in ticks because that is the unit the reader already
// thinks in: "3 / 4" is a bar with a quarter note missing, where "2880 / 3840"
// is arithmetic. The time signature is shown beside it so the beat unit is never
// in doubt on a score that changes metre.
//
// This is the half of the overfull warning that works DURING typing. The red
// rectangle on the score tells you which bars are wrong; this tells you how far
// off the one under the cursor is, which is what you need before it goes wrong
// rather than after.
//
// It lives centred in the document strip, next to what bar and what tempo the
// score is - the same kind of fact about the document - rather than in the
// action bar among the global controls.
const { cursorBarFill: fill } = useScoreEdit()

const title = computed(() => {
  if (!fill.value) return ''
  const { state, beats, beatCapacity, numerator, denominator } = fill.value
  const head = `Bar ${fill.value.barIndex + 1} holds ${beats} of its ${beatCapacity} beats (${numerator}/${denominator})`
  if (state === 'over') {
    return `${head}. It holds MORE than its time signature allows: alphaTab will save it to the file exactly as it is, and no other tool in the chain will complain.`
  }
  if (state === 'under') return `${head}. Incomplete, which is normal while writing.`
  return `${head}. Complete.`
})
</script>

<style scoped lang="scss" src="@/styles/components/BarFill.scss"></style>
