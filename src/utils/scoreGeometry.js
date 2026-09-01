// Pure geometry over alphaTab's `BoundsLookup`: turning a click into a position
// in the model, and a position in the model back into a rectangle to draw.
//
// Kept out of `scoreEdits.js` on purpose. That file is "every model write, and
// nothing else"; this one never touches the model at all. It reads rectangles,
// does arithmetic, and returns plain objects - which is also what lets it be
// tested against a real headless render without an `AlphaTabApi` or a DOM.
//
// Every coordinate here is in the space alphaTab draws in, which is the same
// space `noteHeadBounds` is already used in for the selection marker: pixels
// relative to the top-left of the alphaTab host element, needing no scroll
// maths because the overlay lives inside the scrolled content.

// A bar is drawn once per NOTATION, not once per staff.
//
// `staff.showStandardNotation` and `staff.showTablature` can both be true on one
// staff, and alphaTab then renders two rows for it and produces two `BarBounds`
// carrying the SAME `Bar` object. Which row is the tablature matters, because it
// is the only one where a Y coordinate means a string.
//
// It is the LAST one, and that is not a guess: alphaTab's default stave profile
// lists its renderers as `Slash, Score, Numbered, Tab`
// (`StaveProfile._createDefaultStaveProfiles`, alphaTab 1.8.4), so the tablature
// is drawn below every other notation of the same staff, `showSlash` and
// `showNumbered` included. Sorting by Y - which `MasterBarBounds.finish()`
// already does - therefore puts it last.
function rendersOfBar(masterBarBounds, bar) {
  return (masterBarBounds?.bars ?? []).filter((bounds) => bounds.bar === bar)
}

// The vertical band the click fell in, or the nearest one.
//
// The NEAREST part is not politeness, it is required: bars are only as tall as
// the notation they hold, so between the standard staff and the tablature of one
// track there is a real gap - 56px on the test fixture - that belongs to no
// `BarBounds` at all. Without a fallback, clicking in it would do nothing, which
// reads as a broken feature rather than as a miss.
function nearestByY(list, y, boundsOf) {
  let best = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const item of list) {
    const bounds = boundsOf(item)
    if (!bounds) continue
    if (y >= bounds.y && y <= bounds.y + bounds.h) return item
    const distance = y < bounds.y ? bounds.y - y : y - (bounds.y + bounds.h)
    if (distance < bestDistance) {
      bestDistance = distance
      best = item
    }
  }
  return best
}

function nearestByX(list, x, boundsOf) {
  let best = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const item of list) {
    const bounds = boundsOf(item)
    if (!bounds) continue
    if (x >= bounds.x && x <= bounds.x + bounds.w) return item
    const distance = x < bounds.x ? bounds.x - x : x - (bounds.x + bounds.w)
    if (distance < bestDistance) {
      bestDistance = distance
      best = item
    }
  }
  return best
}

// Which beat of a row an X coordinate falls on.
//
// Written out rather than calling `BarBounds.findBeatAtPos`, which alphaTab
// compares with a strict `<`: a note whose head is drawn exactly on its beat's
// left edge - a tie destination, measured on the fixture's Ties track - then
// resolves to the PREVIOUS beat. One pixel wide, but it is the pixel the note is
// at, so it is reachable by clicking the thing itself.
//
// `beats` is sorted by X (`BarBounds.finish` does it), so the answer is the last
// one starting at or before x.
function beatBoundsAtX(barBounds, x) {
  let found = null
  for (const bounds of barBounds?.beats ?? []) {
    if (found && bounds.realBounds.x > x) break
    if (!found || bounds.realBounds.x <= x) found = bounds
  }
  return found
}

// Which string a Y coordinate falls on, inside a tablature row.
//
// The tab lines are evenly spaced across `visualBounds`, with the FIRST line at
// its top edge - so the spacing is `h / (strings - 1)` and not `h / strings`.
// `note.string` counts up from the lowest-pitched string while the lines are
// drawn highest first (pitfall 2 in scoreEdits.js), which is the subtraction at
// the end.
//
// Verified exactly, not approximately: run against a headless render of the
// fixture with all six tracks displayed, it returns the right string for all 81
// notes of the five stringed tracks, whose staves have 4, 6 and 7 strings.
//
// Clamped, so a click a little above the top line or below the bottom one still
// lands on the string it is nearest to rather than off the neck.
export function stringAtY(visualBounds, y, strings) {
  if (!visualBounds || !Number.isFinite(strings) || strings < 1) return null
  if (strings === 1) return 1
  const spacing = visualBounds.h / (strings - 1)
  if (!(spacing > 0)) return null
  const fromTop = Math.round((y - visualBounds.y) / spacing)
  return Math.min(strings, Math.max(1, strings - fromTop))
}

// The reverse: the Y of a string's line, used to place the cursor where a fret
// number would be written.
export function yOfString(visualBounds, string, strings) {
  if (!visualBounds || !string || strings < 1) return null
  if (strings === 1) return visualBounds.y + visualBounds.h / 2
  const spacing = visualBounds.h / (strings - 1)
  return visualBounds.y + (strings - string) * spacing
}

// What a click at (x, y) points at, as a position rather than as an object.
//
// This does its OWN hit-test rather than taking the `Beat` alphaTab hands to
// `beatMouseDown`, and the reason is a real defect for this feature:
// `BoundsLookup.getBeatAtPos` picks the bar by X only
// (`StaffSystemBounds.findBarAtPos(x)`), so with several tracks displayed the
// beat it returns can belong to a different track from the one that was
// clicked. Selecting a note hides that, because the note hit-test that follows
// is a rectangle and does use Y. Placing a cursor on an EMPTY string has no such
// second chance.
//
// The string is always resolved against the TABLATURE row of the bar that was
// clicked, whichever row the click actually landed in.
//
// This started out as "a click on the standard staff has no string", which is
// true - the interpolation is not merely imprecise there, it answers string 3
// for a note on string 4, measured. But it made half the score unusable to click
// on: swept pixel by pixel down one bar of a real six-track score, 128 of the
// 254 vertical pixels of a system belong to the standard row or to the gap above
// the tablature, so HALF of every bar placed a cursor with no string on it.
//
// So a click outside the tablature row is projected onto it and clamped to the
// nearest line - above the tab gives the top string, below gives the bottom.
// `isTablature` still reports whether the click landed on the tab itself, which
// is the difference between an exact reading and a nearest one.
//
// `string` stays null for a bar with no tablature at all: percussion, or a
// stringed staff whose tab is hidden. There is nothing there to project onto.
export function positionAtPoint(lookup, x, y) {
  const system = nearestByY(lookup?.staffSystems ?? [], y, (s) => s.realBounds)
  if (!system) return null

  const masterBarBounds = nearestByX(system.bars ?? [], x, (b) => b.realBounds)
  if (!masterBarBounds) return null

  const barBounds = nearestByY(masterBarBounds.bars ?? [], y, (b) => b.realBounds)
  if (!barBounds) return null

  const beatBounds = beatBoundsAtX(barBounds, x)
  if (!beatBounds) return null

  const bar = barBounds.bar
  const staff = bar?.staff ?? null
  const strings = staff?.tuning?.length ?? 0
  const renders = rendersOfBar(masterBarBounds, bar)
  // The tablature is the last render of the bar. See rendersOfBar.
  const tab = strings > 0 && !!staff?.showTablature ? renders[renders.length - 1] : null

  return {
    beat: beatBounds.beat,
    bar,
    isTablature: !!tab && tab === barBounds,
    string: tab ? stringAtY(tab.visualBounds, y, strings) : null,
  }
}

// Where to draw the cursor, in the same rectangle shape the note marker uses.
//
// Returned READY TO DRAW rather than as a note-head box to be padded, because
// the two are not the same kind of thing: the note marker rings a glyph that
// exists, this one stands where a glyph would go and has to invent its own size
// from the string spacing.
//
// With a string, one rectangle on the tablature row - the standard staff cannot
// show which string was meant, so marking it there would be a lie. Without a
// string, a full-height caret on every row of the beat, which is what "this
// beat, no string chosen yet" looks like.
export function cursorRects(lookup, beat, string) {
  const list = lookup?.findBeats(beat) ?? []
  if (list.length === 0) return []

  if (string == null) {
    const rects = []
    for (const bounds of list) {
      const bar = bounds.barBounds?.visualBounds
      if (!bar) continue
      rects.push({ x: bounds.onNotesX - 1, y: bar.y, w: 2, h: bar.h })
    }
    return rects
  }

  // The tablature is the last render of the bar. See rendersOfBar.
  const bounds = list[list.length - 1]
  const staff = bounds.barBounds?.bar?.staff ?? null
  const barVisual = bounds.barBounds?.visualBounds ?? null
  const strings = staff?.tuning?.length ?? 0
  if (!barVisual || strings === 0 || !staff.showTablature) return []
  const centreY = yOfString(barVisual, string, strings)
  if (centreY === null) return []

  const spacing = strings > 1 ? barVisual.h / (strings - 1) : barVisual.h
  const h = Math.max(9, spacing)
  const w = 11
  return [{ x: bounds.onNotesX - w / 2, y: centreY - h / 2, w, h }]
}

// One rectangle per bar the predicate accepts, covering every notation row of
// that bar at once.
//
// Merged rather than one rectangle per row, because the thing being flagged is a
// BAR of a track - a bar holding more ticks than its time signature allows - and
// that is one fact about one bar, not a separate fact about its standard staff
// and its tablature.
export function barRects(lookup, accept) {
  const rects = []
  for (const system of lookup?.staffSystems ?? []) {
    for (const masterBarBounds of system.bars ?? []) {
      const merged = new Map()
      for (const barBounds of masterBarBounds.bars ?? []) {
        const bar = barBounds.bar
        if (!bar || !accept(bar)) continue
        const b = barBounds.visualBounds
        const current = merged.get(bar)
        if (!current) {
          merged.set(bar, { x: b.x, y: b.y, w: b.w, h: b.h })
          continue
        }
        const right = Math.max(current.x + current.w, b.x + b.w)
        const bottom = Math.max(current.y + current.h, b.y + b.h)
        current.x = Math.min(current.x, b.x)
        current.y = Math.min(current.y, b.y)
        current.w = right - current.x
        current.h = bottom - current.y
      }
      for (const rect of merged.values()) rects.push(rect)
    }
  }
  return rects
}
