<template>
  <div class="viewer">
    <!-- The scroll container must be an ANCESTOR of the alphaTab container,
         never the same element. See the long comment in usePlayer.init(). -->
    <div
      ref="scroller"
      class="alphatab-scroll"
      :class="{ empty: !isScoreLoaded }"
    >
      <div ref="host" class="alphatab-host" />
    </div>
    <div v-if="isRendering" class="rendering">Rendering…</div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { usePlayer } from '@/composables/usePlayer'

const host = ref(null)
const scroller = ref(null)
const { init, destroy, isRendering, isScoreLoaded } = usePlayer()

onMounted(() => init(host.value, scroller.value))
onBeforeUnmount(() => destroy())
</script>

<style scoped lang="scss" src="@/styles/components/ScoreViewer.scss"></style>
