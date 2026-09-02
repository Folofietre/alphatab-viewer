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
        <!-- `idle` hides alphaTab's own beat cursor while nothing is playing.
             Two vertical markers on one score is one too many: the dashed
             cursor says where you are editing, and a playback bar parked at the
             start of the piece competes with it for the same reading. -->
        <div ref="host" class="alphatab-host" :class="{ idle: !isPlaying }" />

        <!-- The bar the edit cursor is in. First of the overlays, so everything
             else draws over it: this is a wash behind the notation, not a mark
             on it. It follows the arrow keys, where alphaTab's own bar
             highlight follows the playhead. -->
        <div
          v-for="(rect, i) in cursorBarRects"
          :key="`cbar-${i}`"
          class="cursor-bar"
          aria-hidden="true"
          :style="{
            transform: `translate(${rect.x}px, ${rect.y}px)`,
            width: `${rect.w}px`,
            height: `${rect.h}px`,
          }"
        />

        <!-- Bars holding more ticks than their time signature allows.
             Underneath the selection markers, because this is a property of the
             paper rather than of what is being edited - and because nothing
             else in the stack reports it: alphaTab's model, its midi generator
             and its .gp exporter all accept an overfull bar in silence. -->
        <div
          v-for="(rect, i) in overfullRects"
          :key="`over-${i}`"
          class="bar-overfull"
          aria-hidden="true"
          :style="{
            transform: `translate(${rect.x}px, ${rect.y}px)`,
            width: `${rect.w}px`,
            height: `${rect.h}px`,
          }"
        />

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

        <!-- The cursor on an EMPTY position. Never drawn at the same time as
             the ring above: they are one notion, and the ring already marks the
             position whenever it holds a note. Dashed rather than solid, since
             the solid ring already means "this note will change" and this one
             means "this is where you are". Already padded by the geometry,
             which invents its size from the string spacing rather than
             measuring a glyph that is not there. -->
        <div
          v-for="(rect, i) in cursorRects"
          :key="`cursor-${i}`"
          class="cursor-marker"
          aria-hidden="true"
          :style="{
            transform: `translate(${rect.x}px, ${rect.y}px)`,
            width: `${rect.w}px`,
            height: `${rect.h}px`,
          }"
        />
      </div>
    </div>
    <div v-if="isRendering" class="rendering">Rendering…</div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { usePlayer } from '@/composables/usePlayer'
import { useScoreEdit } from '@/composables/useScoreEdit'

// How far the marker sits outside the note head, in px. A note head is only
// about 11x9, so without a little air the ring reads as part of the glyph.
const MARKER_PAD = 3

// How much of the score to keep visible around the cursor when following it.
const FOLLOW_MARGIN = 48

const host = ref(null)
const scroller = ref(null)
const { init, destroy, isRendering, isScoreLoaded, isPlaying } = usePlayer()
const { selectedNoteRects, cursorRects, cursorBarRects, overfullRects, cursorMoves } =
  useScoreEdit()

// Keep the cursor in view when the arrows walk it off the edge.
//
// Driven by the MOVE COUNTER, not by the rectangles. The rectangles are also
// rebuilt after every render, with the same values, so watching them would make
// the view jump on a resize or a track toggle - and during playback it would
// fight alphaTab's own scrolling. A counter only changes when the user pressed
// an arrow, which is the one moment following them is what they meant.
//
// The maths needs no element measurement: these coordinates are already offsets
// inside the scrolled content, which is the same assumption the markers are
// positioned on and which their being in the right place demonstrates.
function follow() {
  const el = scroller.value
  const rect = cursorRects.value[0] ?? selectedNoteRects.value[0] ?? null
  if (!el || !rect) return

  const top = rect.y - FOLLOW_MARGIN
  const bottom = rect.y + rect.h + FOLLOW_MARGIN
  if (top < el.scrollTop) el.scrollTop = Math.max(0, top)
  else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight

  const left = rect.x - FOLLOW_MARGIN
  const right = rect.x + rect.w + FOLLOW_MARGIN
  if (left < el.scrollLeft) el.scrollLeft = Math.max(0, left)
  else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth
}

watch(cursorMoves, follow)

onMounted(() => init(host.value, scroller.value))
onBeforeUnmount(() => destroy())
</script>

<style scoped lang="scss" src="@/styles/components/ScoreViewer.scss"></style>
