import { describe, it, expect } from 'vitest'
import { exportFileName, exportScoreToGp } from '@/utils/exportScore'
import { renameTrack, applyScoreTempo } from '@/utils/scoreEdits'
import { loadBytes, loadFixture, settings, snapshotTrack, tempoMap } from './helpers'

describe('exportFileName', () => {
  it('prefers the score title and marks the file as edited', () => {
    expect(exportFileName(loadFixture(), 'whatever.gp')).toBe('Edit Fixture (edited).gp')
  })

  it('falls back to the opened file name, without its extension', () => {
    expect(exportFileName({ title: '' }, 'My Song.gp5')).toBe('My Song (edited).gp')
    expect(exportFileName(null, 'no-extension')).toBe('no-extension (edited).gp')
  })

  it('never returns the original name, so an original cannot be overwritten', () => {
    const name = exportFileName({ title: 'Song' }, 'Song.gp')
    expect(name).not.toBe('Song.gp')
    expect(name).toContain('(edited)')
  })

  it('strips characters that break a filename, including path separators', () => {
    const name = exportFileName({ title: 'A/B\\C:D*E?F"G<H>I|J' }, '')
    expect(name).toBe('A-B-C-D-E-F-G-H-I-J (edited).gp')
    expect(name).not.toMatch(/[\\/:*?"<>|]/)
  })

  it('keeps ordinary spaces, which are legal in a filename', () => {
    expect(exportFileName({ title: 'Le chant des forges' }, '')).toBe(
      'Le chant des forges (edited).gp',
    )
  })

  it('has a last resort when there is neither a title nor a file', () => {
    expect(exportFileName(null, '')).toBe('score (edited).gp')
    expect(exportFileName({ title: '   ' }, '   ')).toBe('score (edited).gp')
  })

  it('caps a runaway title', () => {
    const name = exportFileName({ title: 'x'.repeat(500) }, '')
    expect(name.length).toBeLessThanOrEqual(120 + ' (edited).gp'.length)
  })
})

describe('exportScoreToGp', () => {
  it('writes bytes that import back with the edits in place', () => {
    const score = loadFixture()
    renameTrack(score.tracks[0], 'Saved Lead')
    applyScoreTempo(score, 175)

    const expected = score.tracks.map(snapshotTrack)
    const expectedTempo = tempoMap(score)

    const bytes = exportScoreToGp(score, settings)
    expect(bytes.length).toBeGreaterThan(0)

    const back = loadBytes(bytes)
    expect(back.tracks.map(snapshotTrack)).toEqual(expected)
    expect(tempoMap(back)).toEqual(expectedTempo)
    expect(back.tempo).toBe(175)
  })

  it('works with no settings passed', () => {
    expect(exportScoreToGp(loadFixture()).length).toBeGreaterThan(0)
  })

  it('throws rather than writing an empty file when there is no score', () => {
    expect(() => exportScoreToGp(null, settings)).toThrow(/No score/)
  })
})
