import { describe, it, expect } from 'vitest'
import * as alphaTab from '@coderline/alphatab'
import { barFill, BAR_OVER } from '@/utils/scoreEdits'
import {
  barRects,
  cursorRects,
  positionAtPoint,
  stringAtY,
  yOfString,
} from '@/utils/scoreGeometry'
import { loadFixture, settings } from './helpers'

// The geometry, against a REAL headless render rather than a stubbed lookup.
//
// Stubbing would prove nothing here: every claim this module makes is about how
// alphaTab actually lays a score out - where the tab lines fall inside
// `visualBounds`, in what order the notations of one staff are drawn, which
// `BarBounds` belongs to which track. A hand-written lookup would only assert
// that the arithmetic matches itself.
//
// Rendered through `ScoreRenderer` directly, exactly like noteSelection.test.js:
// no AlphaTabApi and no DOM, which is what lets a Node test reach the bounds.

function render(score, tracks) {
  const renderSettings = new alphaTab.Settings()
  renderSettings.core.engine = 'svg'
  renderSettings.core.enableLazyLoading = false
  renderSettings.core.includeNoteBounds = true
  renderSettings.display.layoutMode = alphaTab.LayoutMode.Page

  const renderer = new alphaTab.rendering.ScoreRenderer(renderSettings)
  renderer.width = 900
  renderer.renderScore(score, tracks ?? score.tracks.map((t) => t.index))
  return renderer.boundsLookup
}

// Every note that was drawn on a tablature row, with the rectangle it was drawn
// in and the row it belongs to.
function tabNotes(lookup) {
  const found = []
  for (const system of lookup.staffSystems) {
    for (const masterBarBounds of system.bars) {
      const byBar = new Map()
      for (const barBounds of masterBarBounds.bars) {
        if (!byBar.has(barBounds.bar)) byBar.set(barBounds.bar, [])
        byBar.get(barBounds.bar).push(barBounds)
      }
      for (const [bar, renders] of byBar) {
        const staff = bar.staff
        if (!staff.isStringed || !staff.showTablature) continue
        const tab = renders[renders.length - 1]
        for (const beatBounds of tab.beats) {
          for (const noteBounds of beatBounds.notes ?? []) {
            found.push({ noteBounds, tab, strings: staff.tuning.length })
          }
        }
      }
    }
  }
  return found
}

describe('reading a string off a Y coordinate', () => {
  it('is exact for every note of every stringed track, all six displayed', () => {
    // The claim the whole click-on-an-empty-string feature rests on. Not "close
    // enough": if this were off by one line, clicking would place the cursor on
    // the wrong string with no way for the user to tell why.
    const lookup = render(loadFixture())
    const notes = tabNotes(lookup)
    expect(notes.length).toBeGreaterThan(50)

    for (const { noteBounds, tab, strings } of notes) {
      const box = noteBounds.noteHeadBounds
      const y = box.y + box.h / 2
      expect(stringAtY(tab.visualBounds, y, strings), `string ${noteBounds.note.string}`).toBe(
        noteBounds.note.string,
      )
    }
  })

  it('covers staves with 4, 6 and 7 strings, not just the common one', () => {
    const lookup = render(loadFixture())
    const counts = new Set(tabNotes(lookup).map((n) => n.strings))
    expect([...counts].sort((a, b) => a - b)).toEqual([4, 6, 7])
  })

  it('clamps rather than running off the neck', () => {
    const bounds = { x: 0, y: 100, w: 200, h: 65 }
    expect(stringAtY(bounds, 40, 6)).toBe(6)
    expect(stringAtY(bounds, 400, 6)).toBe(1)
  })

  it('and yOfString is its inverse on the line centres', () => {
    const bounds = { x: 0, y: 100, w: 200, h: 65 }
    for (let string = 1; string <= 6; string += 1) {
      expect(stringAtY(bounds, yOfString(bounds, string, 6), 6)).toBe(string)
    }
  })

  it('answers null rather than dividing by zero on a staff with no strings', () => {
    expect(stringAtY({ x: 0, y: 0, w: 10, h: 10 }, 5, 0)).toBeNull()
    expect(stringAtY(null, 5, 6)).toBeNull()
  })
})

describe('turning a click into a position', () => {
  it('lands on the track that was clicked, which the beat lookup alone does not', () => {
    // alphaTab's own `getBeatAtPos` picks the bar by X only, so with several
    // tracks on screen it can hand back a beat from a different one. Selecting a
    // note hides that (the note hit-test uses Y); an empty string has no such
    // second chance, which is why this does its own hit-test.
    const score = loadFixture()
    const lookup = render(score)

    for (const { noteBounds, tab } of tabNotes(lookup)) {
      const box = noteBounds.noteHeadBounds
      const position = positionAtPoint(lookup, box.x + box.w / 2, box.y + box.h / 2)
      expect(position).not.toBeNull()
      expect(position.beat).toBe(noteBounds.note.beat)
      expect(position.string).toBe(noteBounds.note.string)
      expect(position.bar).toBe(tab.bar)
    }
  })

  it('reports NO string on a standard-notation row, where Y means nothing', () => {
    // Interpolating there is not merely imprecise, it is wrong: measured, it
    // answers string 3 for a note on string 4. So the honest answer is null.
    const score = loadFixture()
    const lookup = render(score, [0])
    const masterBarBounds = lookup.staffSystems[0].bars[0]
    const standard = masterBarBounds.bars[0]
    const tab = masterBarBounds.bars[masterBarBounds.bars.length - 1]
    expect(standard.bar).toBe(tab.bar)
    expect(standard).not.toBe(tab)

    const y = standard.visualBounds.y + standard.visualBounds.h / 2
    const position = positionAtPoint(lookup, standard.visualBounds.x + 20, y)
    expect(position.isTablature).toBe(false)
    expect(position.string).toBeNull()
    // The beat is still found, so the cursor lands on the bar either way.
    expect(position.beat).not.toBeNull()
  })

  it('takes the NEAREST row, because the gap between two staves belongs to none', () => {
    // Measured on the fixture: the standard staff ends at y+36 and the tablature
    // starts 56px lower. A click in between must not do nothing.
    const score = loadFixture()
    const lookup = render(score, [0])
    const bars = lookup.staffSystems[0].bars[0].bars
    const gapTop = bars[0].realBounds.y + bars[0].realBounds.h
    const gapBottom = bars[1].realBounds.y
    expect(gapBottom).toBeGreaterThan(gapTop)

    // Just above the tablature: near enough that it is the row meant.
    const position = positionAtPoint(lookup, bars[1].realBounds.x + 40, gapBottom - 3)
    expect(position).not.toBeNull()
    expect(position.isTablature).toBe(true)
    expect(position.string).toBe(6)
  })

  it('resolves a note sitting exactly on its beat edge to ITS beat', () => {
    // alphaTab's own `findBeatAtPos` compares with a strict `<`, so a note head
    // drawn exactly at its beat's left edge - which the Ties track really does -
    // resolves to the previous beat. One pixel wide, but it is the pixel the
    // note is at.
    const score = loadFixture()
    const lookup = render(score)
    const edge = tabNotes(lookup).find(
      ({ noteBounds, tab }) => {
        const bounds = tab.beats.find((b) => b.beat === noteBounds.note.beat)
        return bounds && noteBounds.noteHeadBounds.x + noteBounds.noteHeadBounds.w / 2 === bounds.realBounds.x
      },
    )
    expect(edge, 'the fixture no longer has a note on a beat edge').toBeDefined()

    const box = edge.noteBounds.noteHeadBounds
    const position = positionAtPoint(lookup, box.x + box.w / 2, box.y + box.h / 2)
    expect(position.beat).toBe(edge.noteBounds.note.beat)
  })

  it('finds nothing outside the rendered score only when there is nothing at all', () => {
    expect(positionAtPoint(null, 10, 10)).toBeNull()
    expect(positionAtPoint({ staffSystems: [] }, 10, 10)).toBeNull()
  })
})

describe('drawing the cursor', () => {
  it('puts it on the tablature row, at the string it was asked for', () => {
    const score = loadFixture()
    const lookup = render(score, [0])
    const note = score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0]

    const rects = cursorRects(lookup, note.beat, note.string)
    expect(rects).toHaveLength(1)

    // It marks the same place the note itself was drawn on the tab, which is the
    // last of the two rectangles the note has.
    const heads = []
    for (const beatBounds of lookup.findBeats(note.beat)) {
      for (const noteBounds of beatBounds.notes ?? []) {
        if (noteBounds.note === note) heads.push(noteBounds.noteHeadBounds)
      }
    }
    const tabHead = heads[heads.length - 1]
    const centre = { x: rects[0].x + rects[0].w / 2, y: rects[0].y + rects[0].h / 2 }
    expect(Math.abs(centre.y - (tabHead.y + tabHead.h / 2))).toBeLessThan(3)
    expect(Math.abs(centre.x - (tabHead.x + tabHead.w / 2))).toBeLessThan(8)
  })

  it('draws a caret on every row when the position has no string yet', () => {
    const score = loadFixture()
    const lookup = render(score, [0])
    const beat = score.tracks[0].staves[0].bars[0].voices[0].beats[0]

    const rects = cursorRects(lookup, beat, null)
    // Standard notation and tablature.
    expect(rects).toHaveLength(2)
    for (const rect of rects) {
      expect(rect.w).toBe(2)
      expect(rect.h).toBeGreaterThan(10)
    }
    expect(rects[0].y).not.toBe(rects[1].y)
  })

  it('draws nothing for a beat that was not rendered', () => {
    const score = loadFixture()
    const lookup = render(score, [0])
    // A beat of a track that is not displayed.
    const hidden = score.tracks[2].staves[0].bars[0].voices[0].beats[0]
    expect(cursorRects(lookup, hidden, 1)).toEqual([])
  })
})

describe('marking the overfull bars', () => {
  it('produces one rectangle per bar, covering all of its notation rows', () => {
    const score = loadFixture()
    const bar = score.tracks[0].staves[0].bars[1]
    bar.voices[0].beats[0].duration = alphaTab.model.Duration.Whole
    score.finish(settings)
    expect(barFill(bar).state).toBe(BAR_OVER)

    const lookup = render(score, [0])
    const rects = barRects(lookup, (b) => barFill(b)?.state === BAR_OVER)
    expect(rects).toHaveLength(1)

    // Merged: it spans from the top of the standard staff to the bottom of the
    // tablature, because what is wrong is the BAR, not one of its two rows.
    const rows = lookup.staffSystems
      .flatMap((system) => system.bars)
      .flatMap((masterBarBounds) => masterBarBounds.bars)
      .filter((barBounds) => barBounds.bar === bar)
    expect(rows.length).toBe(2)
    const top = Math.min(...rows.map((r) => r.visualBounds.y))
    const bottom = Math.max(...rows.map((r) => r.visualBounds.y + r.visualBounds.h))
    expect(rects[0].y).toBe(top)
    expect(rects[0].y + rects[0].h).toBe(bottom)
  })

  it('marks nothing on a score whose bars are all correct', () => {
    const lookup = render(loadFixture())
    expect(barRects(lookup, (bar) => barFill(bar)?.state === BAR_OVER)).toEqual([])
  })
})
