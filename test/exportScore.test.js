import { describe, it, expect, afterEach } from 'vitest'
import {
  canPickSaveLocation,
  exportFileName,
  exportScoreToGp,
  saveScoreAsGp,
} from '@/utils/exportScore'
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

describe('save as', () => {
  const score = loadFixture()

  afterEach(() => {
    delete globalThis.window
  })

  it('reports honestly whether this browser can choose a folder', () => {
    globalThis.window = {}
    expect(canPickSaveLocation()).toBe(false)
    globalThis.window = { showSaveFilePicker: () => {} }
    expect(canPickSaveLocation()).toBe(true)
  })

  it('writes the bytes to the handle the user picked', async () => {
    const written = []
    const closed = []
    const handle = {
      name: 'Somewhere else.gp',
      createWritable: async () => ({
        write: async (bytes) => written.push(bytes),
        close: async () => closed.push(true),
      }),
    }
    let asked = null
    globalThis.window = {
      showSaveFilePicker: async (options) => {
        asked = options
        return handle
      },
    }

    const saved = await saveScoreAsGp(score, settings, 'source.gp')
    // The name it SUGGESTS still carries the edited marker, so an original
    // cannot be overwritten by just pressing Enter.
    expect(asked.suggestedName).toMatch(/\(edited\)\.gp$/)
    // The name it REPORTS is the one the user actually chose.
    expect(saved).toMatchObject({ fileName: 'Somewhere else.gp', picked: true })
    expect(written).toHaveLength(1)
    expect(written[0].length).toBeGreaterThan(0)
    expect(closed).toEqual([true])
  })

  it('returns null when the user cancels, which is not a failure', async () => {
    // The most likely outcome of opening a save dialog by accident. If this
    // threw, the caller would paint a red error over a deliberate Escape.
    globalThis.window = {
      showSaveFilePicker: async () => {
        const error = new Error('The user aborted a request.')
        error.name = 'AbortError'
        throw error
      },
    }
    await expect(saveScoreAsGp(score, settings, 'source.gp')).resolves.toBeNull()
  })

  it('still propagates a real failure', async () => {
    globalThis.window = {
      showSaveFilePicker: async () => {
        throw new Error('disk on fire')
      },
    }
    await expect(saveScoreAsGp(score, settings, 'source.gp')).rejects.toThrow('disk on fire')
  })

  it('does not export before the picker answers', async () => {
    // The export is synchronous and cost ~400ms on a 118-bar score, so doing it
    // first would freeze the window before the dialog appeared - and an await
    // before showSaveFilePicker would spend the user gesture it requires.
    let pickerCalled = false
    let wroteBefore = null
    globalThis.window = {
      showSaveFilePicker: async () => {
        pickerCalled = true
        return {
          name: 'x.gp',
          createWritable: async () => ({
            write: async () => { wroteBefore = pickerCalled },
            close: async () => {},
          }),
        }
      },
    }
    await saveScoreAsGp(score, settings, 'source.gp')
    expect(wroteBefore).toBe(true)
  })

  it('falls back to a plain download where there is no picker', async () => {
    // Firefox and Safari. The file still gets out; the user just does not get
    // to say where it lands.
    const clicks = []
    globalThis.window = {}
    globalThis.URL.createObjectURL = () => 'blob:stub'
    globalThis.URL.revokeObjectURL = () => {}
    const link = { click: () => clicks.push(true), remove: () => {}, style: {} }
    globalThis.document = {
      createElement: () => link,
      body: { appendChild: () => {} },
    }

    const saved = await saveScoreAsGp(score, settings, 'source.gp')
    expect(saved.picked).toBe(false)
    expect(saved.fileName).toMatch(/\(edited\)\.gp$/)
    expect(clicks).toEqual([true])
    delete globalThis.document
  })
})
