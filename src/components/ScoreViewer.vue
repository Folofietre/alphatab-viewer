<template>
  <div class="viewer">
    <!-- The scroll container must be an ANCESTOR of the alphaTab container,
         never the same element. See the long comment in usePlayer.init(). -->
    <div
      ref="scroller"
      class="alphatab-scroll"
      :class="{ empty: !isScoreLoaded }"
    >
      <!-- A positioned wrapper around the host, so the selection markers share
           the host's coordinate origin. It adds no offset and does not scroll,
           so `scroller` stays a distinct ANCESTOR of the alphaTab container and
           alphaTab's getOffset() maths is untouched. -->
      <div class="alphatab-stack">
        <div ref="host" class="alphatab-host" />

        <!-- The selected note, marked where alphaTab actually drew it.
             Coordinates come straight from `boundsLookup` and need no scroll
             maths: this sits inside the scrolled content, exactly like
             alphaTab's own playback cursor. Usually two markers - the note head
             on the standard staff and the fret number on the tablature. -->
        <div
          v-for="(rect, i) in selectedNoteRects"
          :key="i"
          class="note-marker"
          aria-hidden="true"
          :style="{
            transform: `translate(${rect.x - MARKER_PAD}px, ${rect.y - MARKER_PAD}px)`,
            width: `${rect.w + MARKER_PAD * 2}px`,
            height: `${rect.h + MARKER_PAD * 2}px`,
          }"
        />
      </div>
    </div>
    <div v-if="isRendering" class="rendering">Rendering…</div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { usePlayer } from '@/composables/usePlayer'
import { useScoreEdit } from '@/composables/useScoreEdit'

// How far the marker sits outside the note head, in px. A note head is only
// about 11x9, so without a little air the ring reads as part of the glyph.
const MARKER_PAD = 3

const host = ref(null)
const scroller = ref(null)
const { init, destroy, isRendering, isScoreLoaded } = usePlayer()
const { selectedNoteRects } = useScoreEdit()

onMounted(() => init(host.value, scroller.value))
onBeforeUnmount(() => destroy())
</script>

<style scoped lang="scss" src="@/styles/components/ScoreViewer.scss"></style>
