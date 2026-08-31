import { describe, it, expect } from 'vitest'
import * as alphaTab from '@coderline/alphatab'
import { loadFixture, settings } from './helpers'

// Why note selection needs `core.includeNoteBounds`, pinned so it cannot regress.
//
// This is the bug that made "click a note, press Alt + arrow" do nothing at all,
// with no error anywhere: `api.noteMouseDown` is gated on this setting, which
// DEFAULTS TO FALSE, and with it off the renderer builds no note bounding boxes,
// so alphaTab's hit-test has nothing to find and never fires the event.
//
// Rendered here through `ScoreRenderer` directly - no AlphaTabApi, no DOM - which
// is what lets a Node test reach the bounds lookup at all.

// usePlayer reads the stored master volume at module scope. A two-method stub is
// cheaper than pulling jsdom in for a suite that touches no DOM.
globalThis.localStorage ??= {
  getItem: () => null,
  setItem: () => {},
}
const { playerSettings } = await import('@/composables/usePlayer')

function renderTrack(includeNoteBounds) {
  const renderSettings = new alphaTab.Settings()
  renderSettings.core.engine = 'svg'
  renderSettings.core.enableLazyLoading = false
  renderSettings.core.includeNoteBounds = includeNoteBounds
  renderSettings.display.layoutMode = alphaTab.LayoutMode.Page

  const renderer = new alphaTab.rendering.ScoreRenderer(renderSettings)
  renderer.width = 1000
  renderer.renderScore(loadFixture(), [0])
  return renderer.boundsLookup
}

function noteBoxesOf(lookup) {
  const boxes = []
  for (const system of lookup.staffSystems) {
    for (const masterBar of system.bars) {
      for (const bar of masterBar.bars) {
        for (const beat of bar.beats) {
          for (const note of beat.notes ?? []) boxes.push(note)
        }
      }
    }
  }
  return boxes
}

describe('the app settings', () => {
  it('turn includeNoteBounds ON, without which note selection cannot work', () => {
    expect(playerSettings(null).core.includeNoteBounds).toBe(true)
  })

  it('keep enableUserInteraction on too, which is a DIFFERENT setting', () => {
    // It governs click-to-seek and drag-to-select-a-range, not the note
    // hit-test. Conflating the two is what hid the bug.
    expect(playerSettings(null).player.enableUserInteraction).toBe(true)
  })

  it('and alphaTab still defaults includeNoteBounds to false', () => {
    // If this ever fails, alphaTab changed its default and the comment in
    // usePlayer explaining why the setting is there needs revisiting.
    expect(new alphaTab.Settings().core.includeNoteBounds).toBe(false)
    expect(settings.core.includeNoteBounds).toBe(false)
  })
})

describe('the bounds lookup', () => {
  it('builds NO note bounding boxes when includeNoteBounds is off', () => {
    const lookup = renderTrack(false)
    expect(lookup).not.toBeNull()
    // Beats are found, so click-to-seek works - which is why the failure looked
    // like a broken shortcut rather than a broken setting.
    expect(noteBoxesOf(lookup)).toHaveLength(0)
  })

  it('builds them when it is on', () => {
    expect(noteBoxesOf(renderTrack(true)).length).toBeGreaterThan(0)
  })

  it('finds a note when the click lands on the centre of its head', () => {
    const lookup = renderTrack(true)
    const boxes = noteBoxesOf(lookup)
    expect(boxes.length).toBeGreaterThan(0)

    let hits = 0
    for (const box of boxes) {
      const x = box.noteHeadBounds.x + box.noteHeadBounds.w / 2
      const y = box.noteHeadBounds.y + box.noteHeadBounds.h / 2
      const beat = lookup.getBeatAtPos(x, y)
      expect(beat).not.toBeNull()
      if (lookup.getNoteAtPos(beat, x, y)) hits += 1
    }
    // Every single one, since alphaTab's hit-test is the note head rectangle.
    expect(hits).toBe(boxes.length)
  })

  it('can go the OTHER way too: from a Note to its rectangles', () => {
    // The selection marker depends on this reverse path, which has no dedicated
    // API: findBeats(beat) returns one BeatBounds per staff, and each carries a
    // NoteBounds per note with a `.note` back-reference.
    const lookup = renderTrack(true)
    const score = loadFixture()

    // Re-render THIS score so the lookup refers to its own Note objects.
    const renderSettings = new alphaTab.Settings()
    renderSettings.core.engine = 'svg'
    renderSettings.core.enableLazyLoading = false
    renderSettings.core.includeNoteBounds = true
    renderSettings.display.layoutMode = alphaTab.LayoutMode.Page
    const renderer = new alphaTab.rendering.ScoreRenderer(renderSettings)
    renderer.width = 1000
    renderer.renderScore(score, [0])
    const own = renderer.boundsLookup
    expect(own).not.toBeNull()
    expect(lookup).not.toBeNull()

    const note = score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0]
    const rects = []
    for (const beatBounds of own.findBeats(note.beat) ?? []) {
      for (const noteBounds of beatBounds.notes ?? []) {
        if (noteBounds.note !== note) continue
        rects.push(noteBounds.noteHeadBounds)
      }
    }

    // The fixture's first track renders standard notation AND tablature, so the
    // note is drawn twice and gets two rectangles.
    expect(rects).toHaveLength(2)
    for (const rect of rects) {
      expect(rect.w).toBeGreaterThan(0)
      expect(rect.h).toBeGreaterThan(0)
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.y).toBeGreaterThanOrEqual(0)
    }
    // Two staves, so two different vertical positions.
    expect(rects[0].y).not.toBe(rects[1].y)

    // And the rectangles really are the hit-test targets: clicking the centre of
    // each finds this same note back.
    for (const rect of rects) {
      const x = rect.x + rect.w / 2
      const y = rect.y + rect.h / 2
      expect(own.getNoteAtPos(own.getBeatAtPos(x, y), x, y)).toBe(note)
    }
  })

  it('finds NOTHING just outside a note head, which is why a miss needs feedback', () => {
    const lookup = renderTrack(true)
    const box = noteBoxesOf(lookup)[0]
    // A few pixels above the top edge: still inside the beat, outside the note.
    const x = box.noteHeadBounds.x + box.noteHeadBounds.w / 2
    const y = box.noteHeadBounds.y - 6
    const beat = lookup.getBeatAtPos(x, y)
    if (beat) expect(lookup.getNoteAtPos(beat, x, y)).toBeNull()
  })
})
