// `v-help="text"` - a tooltip that is ours, not the browser's.
//
// This replaces the native `title` attribute, which was tried twice on these
// panels and never showed anything: first as generated content on a label, then
// on a real element owning the attribute itself. The CSS was correct in both
// (verified in the built stylesheet, and the `?` marker and help cursor both
// painted), so whatever suppresses it is not something this code can reach.
// A tooltip we render ourselves is not subject to it.
//
// It is a DIRECTIVE rather than a component for the reason `v-b-tooltip` is one:
// the trigger belongs on the zone that already exists - the field, the header -
// not on a wrapper introduced to host it. `v-help="tempoHelp"` replaces
// `:title="tempoHelp"` one character for one character at every call site.
//
// One bubble for the whole app, on `document.body`. It has to leave the panel:
// the sidebar is 290px wide and `overflow-y: auto`, so anything positioned
// inside it is clipped by its own scroll container. Fixed coordinates from
// `getBoundingClientRect()` are what let it sit outside and still track.

// Long enough not to fire while the pointer crosses a field on its way
// somewhere else, short enough to feel like an answer rather than a wait. The
// native delay is around a second, which is most of why the old one felt dead.
const SHOW_DELAY_MS = 250

// Distance between the bubble and the element it explains.
const OFFSET = 8

let bubble = null
let showTimer = 0
let activeEl = null
let seq = 0

function ensureBubble() {
  if (bubble) return bubble
  bubble = document.createElement('div')
  bubble.className = 'help-bubble'
  bubble.setAttribute('role', 'tooltip')
  bubble.hidden = true
  document.body.appendChild(bubble)
  return bubble
}

// Above the element by preference, below when there is no room above. Clamped
// to the viewport horizontally, because a field at the right edge of the right
// panel would otherwise put half its explanation off screen.
function place(el) {
  const anchor = el.getBoundingClientRect()
  const box = bubble.getBoundingClientRect()
  const margin = 8

  let top = anchor.top - box.height - OFFSET
  if (top < margin) top = anchor.bottom + OFFSET

  let left = anchor.left
  const maxLeft = window.innerWidth - box.width - margin
  if (left > maxLeft) left = maxLeft
  if (left < margin) left = margin

  bubble.style.top = `${Math.round(top)}px`
  bubble.style.left = `${Math.round(left)}px`
}

function hide() {
  window.clearTimeout(showTimer)
  if (activeEl) {
    activeEl.removeAttribute('aria-describedby')
    activeEl = null
  }
  if (bubble) bubble.hidden = true
}

function show(el) {
  const text = el.__helpText
  if (!text) return

  ensureBubble()
  bubble.textContent = text
  // Named per showing, so an element that is described now is not still
  // pointing at a bubble that has moved on to another one.
  bubble.id = `help-bubble-${(seq += 1)}`
  bubble.hidden = false
  activeEl = el
  el.setAttribute('aria-describedby', bubble.id)
  // Measured after it is visible and filled, or the height is zero and it
  // places itself against the top of the viewport.
  place(el)
}

function arm(event) {
  const el = event.currentTarget
  window.clearTimeout(showTimer)
  // Focus deserves no delay: arriving by keyboard is already deliberate.
  if (event.type === 'focusin') show(el)
  else showTimer = window.setTimeout(() => show(el), SHOW_DELAY_MS)
}

function onKeyDown(event) {
  if (event.key === 'Escape') hide()
}

export const help = {
  mounted(el, binding) {
    el.__helpText = binding.value
    el.dataset.help = ''
    el.addEventListener('mouseenter', arm)
    el.addEventListener('focusin', arm)
    el.addEventListener('mouseleave', hide)
    el.addEventListener('focusout', hide)
    el.addEventListener('keydown', onKeyDown)
  },
  updated(el, binding) {
    el.__helpText = binding.value
    // Live-update a bubble that is already open on this element: the transpose
    // and tuning explanations name values that change under the pointer when a
    // different track is picked.
    if (activeEl === el && bubble && !bubble.hidden) {
      bubble.textContent = binding.value
      place(el)
    }
  },
  unmounted(el) {
    if (activeEl === el) hide()
    el.removeEventListener('mouseenter', arm)
    el.removeEventListener('focusin', arm)
    el.removeEventListener('mouseleave', hide)
    el.removeEventListener('focusout', hide)
    el.removeEventListener('keydown', onKeyDown)
  },
}
