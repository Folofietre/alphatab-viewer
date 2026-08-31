import { describe, it, expect } from 'vitest'
import * as alphaTab from '@coderline/alphatab'
import {
  MIN_FRET,
  MAX_FRET,
  MIN_TEMPO,
  MAX_TEMPO,
  RETUNE_KEEP_PITCH,
  RETUNE_REASSIGN,
  applyScoreTempo,
  describeNote,
  describeTuning,
  countNaturalHarmonics,
  fretRange,
  renameTrack,
  retuneTrack,
  deleteNotes,
  setNoteFret,
  shiftNoteString,
  shiftNotesFret,
  shiftNotesString,
  stringedNotes,
  tempoInfo,
  transposeTrackByFrets,
  transposeTrackByTuning,
  tuningChoices,
  tuningForString,
} from '@/utils/scoreEdits'
import {
  loadFixture,
  midiNoteOns,
  notesOf,
  roundTrip,
  settings,
  snapshotTrack,
  stringedTracks,
  tempoMap,
} from './helpers'

// Named so a failure points at the right track without counting indexes.
const LEAD = 0 // 6 strings, standard tuning, frets 3-12
const RHYTHM = 1 // 7 strings, custom tuning, frets 0-24 (against both bounds)
const BASS = 2 // 4 strings, standard tuning, frets 0-7
const HARM = 3 // 6 strings, carries 4 natural harmonics and 1 artificial one
const DRUMS = 4 // percussion: string -1, fret -1
const TIES = 5 // ties, hammer-ons, a slide and a chord: the delete sweep's target

describe('the fixture is what the tests assume', () => {
  it('holds the four tracks and the tempo map the suite is written against', () => {
    const score = loadFixture()
    expect(score.tracks.map((t) => t.name)).toEqual([
      'Lead', 'Rhythm', 'Bass', 'Harm', 'Drums', 'Ties',
    ])
    expect(score.tempo).toBe(120)
    expect(tempoMap(score)).toEqual([
      [0, 120],
      [1, 90],
      [3, 140],
    ])
    expect(score.tracks[LEAD].staves[0].tuning).toEqual([64, 59, 55, 50, 45, 40])
    expect(score.tracks[RHYTHM].staves[0].tuning).toEqual([64, 59, 55, 50, 45, 40, 33])
    expect(score.tracks[BASS].staves[0].tuning).toEqual([43, 38, 33, 28])
    expect(score.tracks[DRUMS].isPercussion).toBe(true)
    expect(fretRange(score.tracks[LEAD].staves[0])).toMatchObject({ min: 3, max: 12 })
    expect(fretRange(score.tracks[RHYTHM].staves[0])).toMatchObject({ min: 0, max: 24 })
    // Only the Harm track carries natural harmonics, so every other track's
    // fret-based operation is free of the pitfall-4 refusal.
    expect(countNaturalHarmonics(score.tracks[HARM].staves[0])).toBe(4)
    for (const index of [LEAD, RHYTHM, BASS, DRUMS]) {
      expect(countNaturalHarmonics(score.tracks[index].staves[0])).toBe(0)
    }
  })
})

// The pitfall that would otherwise corrupt every retuning silently. Pinned
// against alphaTab's own accessor rather than against a hard-coded expectation,
// so this fails loudly if alphaTab ever flips the convention.
describe('string numbering (pitfall 2)', () => {
  it('tuningForString agrees with Note.getStringTuning on every string', () => {
    const score = loadFixture()
    for (const track of stringedTracks(score)) {
      for (const staff of track.staves) {
        if (!staff.isStringed) continue
        for (let string = 1; string <= staff.tuning.length; string += 1) {
          expect(tuningForString(staff.tuning, string)).toBe(
            alphaTab.model.Note.getStringTuning(staff, string),
          )
        }
      }
    }
  })

  it('reads string 1 as the LOWEST string, i.e. the last stored value', () => {
    const staff = loadFixture().tracks[LEAD].staves[0]
    expect(staff.tuning).toEqual([64, 59, 55, 50, 45, 40])
    expect(tuningForString(staff.tuning, 1)).toBe(40) // low E
    expect(tuningForString(staff.tuning, 6)).toBe(64) // high E
  })

  it('every note in the fixture sounds at stringTuning + fret, harmonics aside', () => {
    const score = loadFixture()
    for (const track of stringedTracks(score)) {
      for (const staff of track.staves) {
        for (const note of stringedNotes(staff)) {
          // calculateRealValue(false, false) is the plain fret + tuning value:
          // no transposition pitch, no harmonic. `realValue` itself applies
          // both, which is pitfall 4.
          expect(note.calculateRealValue(false, false)).toBe(
            tuningForString(staff.tuning, note.string) + note.fret,
          )
        }
      }
    }
  })
})

describe('renameTrack', () => {
  it('writes both name and shortName and survives a .gp round trip', () => {
    const score = loadFixture()
    const result = renameTrack(score.tracks[LEAD], '  Solo Guitar  ')
    expect(result).toMatchObject({ ok: true, changed: true, reason: null })
    expect(score.tracks[LEAD].name).toBe('Solo Guitar')
    expect(score.tracks[LEAD].shortName).toBe('Solo Guitar')

    const back = roundTrip(score)
    expect(back.tracks[LEAD].name).toBe('Solo Guitar')
  })

  it('reports no change when the name is already that', () => {
    const score = loadFixture()
    renameTrack(score.tracks[LEAD], 'Solo')
    expect(renameTrack(score.tracks[LEAD], 'Solo')).toMatchObject({ ok: true, changed: false })
  })

  it('refuses an empty name rather than blanking the stave label', () => {
    const score = loadFixture()
    const before = score.tracks[LEAD].name
    expect(renameTrack(score.tracks[LEAD], '   ')).toMatchObject({ ok: false })
    expect(score.tracks[LEAD].name).toBe(before)
  })

  it('refuses when there is no track', () => {
    expect(renameTrack(null, 'x').ok).toBe(false)
  })
})

describe('applyScoreTempo (pitfall 1)', () => {
  it('score.tempo is read-only, which is why this function exists', () => {
    const score = loadFixture()
    expect(() => {
      score.tempo = 200
    }).toThrow(TypeError)
  })

  it('counts the automations so the UI can warn it is moving a map', () => {
    const score = loadFixture()
    const info = tempoInfo(score)
    expect(info.tempo).toBe(score.tempo)
    expect(info.automationCount).toBe(3)
  })

  it('scales the whole tempo map proportionally', () => {
    const score = loadFixture()
    expect(applyScoreTempo(score, 240)).toMatchObject({ ok: true, changed: true })
    // 120 -> 240 is a ratio of 2, applied to every automation.
    expect(tempoMap(score)).toEqual([
      [0, 240],
      [1, 180],
      [3, 280],
    ])
    expect(score.tempo).toBe(240)
  })

  it('lands the initial tempo on the exact typed value, not on a scaled one', () => {
    const score = loadFixture()
    // A ratio that does not divide cleanly, so a plain round(value * ratio)
    // would drift off the number the user typed.
    applyScoreTempo(score, 137)
    expect(score.tempo).toBe(137)
  })

  it('keeps fractional tempi instead of rounding the map to integers', () => {
    const score = loadFixture()
    // 120 -> 121 is a ratio of 121/120, which turns 90 into 90.75.
    applyScoreTempo(score, 121)
    expect(tempoMap(score)).toEqual([
      [0, 121],
      [1, 90.75],
      [3, 141.17],
    ])
    // And no float noise: everything is at most 2 decimals.
    for (const [, value] of tempoMap(score)) {
      expect(Math.round(value * 100) / 100).toBe(value)
    }
  })

  it('survives a .gp round trip', () => {
    const score = loadFixture()
    applyScoreTempo(score, 200)
    const before = tempoMap(score)
    const back = roundTrip(score)
    expect(back.tempo).toBe(200)
    expect(tempoMap(back)).toEqual(before)
  })

  it('reports no change for the tempo it already has', () => {
    const score = loadFixture()
    expect(applyScoreTempo(score, score.tempo)).toMatchObject({ ok: true, changed: false })
  })

  it('refuses values outside the guarded BPM range, and leaves the map alone', () => {
    const score = loadFixture()
    const before = tempoMap(score)
    for (const bad of [MIN_TEMPO - 1, MAX_TEMPO + 1, 0, -60, Number.NaN, 'fast']) {
      const result = applyScoreTempo(score, bad)
      expect(result.ok).toBe(false)
      expect(result.reason).toBeTruthy()
    }
    expect(tempoMap(score)).toEqual(before)
  })
})

describe('transposeTrackByTuning (keep the fingering)', () => {
  it('moves every sounding pitch by N and leaves every fret alone', () => {
    const score = loadFixture()
    const track = score.tracks[LEAD]
    const before = snapshotTrack(track)

    expect(transposeTrackByTuning(track, -2)).toMatchObject({ ok: true, changed: true })

    const after = snapshotTrack(track)
    expect(after.staves[0].tuning).toEqual(before.staves[0].tuning.map((v) => v - 2))
    after.staves[0].notes.forEach((note, i) => {
      expect(note.fret).toBe(before.staves[0].notes[i].fret)
      expect(note.realValue).toBe(before.staves[0].notes[i].realValue - 2)
    })
  })

  it('names the resulting tuning when alphaTab knows it', () => {
    const score = loadFixture()
    transposeTrackByTuning(score.tracks[LEAD], -2)
    // Standard guitar tuning down a whole step is a tuning alphaTab has a name
    // for, and writeTuning() calls finish() to pick it up.
    expect(score.tracks[LEAD].staves[0].stringTuning.name).toBe('Guitar Tune down 1 step')
  })

  it('works where the fret transposition cannot: frets already at both bounds', () => {
    const score = loadFixture()
    const track = score.tracks[RHYTHM]
    expect(fretRange(track.staves[0])).toMatchObject({ min: 0, max: 24 })
    expect(transposeTrackByFrets(track, -1).ok).toBe(false)
    expect(transposeTrackByTuning(track, -1).ok).toBe(true)
  })

  it('never mutates alphaTab shared preset table', () => {
    const score = loadFixture()
    const presetBefore = alphaTab.model.Tuning.getPresetsFor(6).map((p) => [...p.tunings])
    transposeTrackByTuning(score.tracks[LEAD], -2)
    expect(alphaTab.model.Tuning.getPresetsFor(6).map((p) => [...p.tunings])).toEqual(presetBefore)
  })

  it('survives a .gp round trip', () => {
    const score = loadFixture()
    transposeTrackByTuning(score.tracks[LEAD], 3)
    const before = snapshotTrack(score.tracks[LEAD])
    const back = roundTrip(score)
    expect(snapshotTrack(back.tracks[LEAD]).staves[0]).toEqual(before.staves[0])
  })

  it('reports no change for 0 and refuses a non-number', () => {
    const score = loadFixture()
    expect(transposeTrackByTuning(score.tracks[LEAD], 0)).toMatchObject({ changed: false })
    expect(transposeTrackByTuning(score.tracks[LEAD], 'up a bit').ok).toBe(false)
  })

  it('refuses a percussion track, which has no tablature', () => {
    const score = loadFixture()
    const result = transposeTrackByTuning(score.tracks[DRUMS], 2)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no tablature/)
  })

  it('refuses a shift that would push a string out of the midi range', () => {
    const score = loadFixture()
    const result = transposeTrackByTuning(score.tracks[LEAD], -100)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/outside the 0-127 range/)
    expect(score.tracks[LEAD].staves[0].tuning).toEqual([64, 59, 55, 50, 45, 40])
  })
})

describe('transposeTrackByFrets (keep the tuning)', () => {
  it('moves every fret and every pitch by N, tuning untouched', () => {
    const score = loadFixture()
    const track = score.tracks[LEAD]
    const before = snapshotTrack(track)

    expect(transposeTrackByFrets(track, 2)).toMatchObject({ ok: true, changed: true })

    const after = snapshotTrack(track)
    expect(after.staves[0].tuning).toEqual(before.staves[0].tuning)
    after.staves[0].notes.forEach((note, i) => {
      expect(note.fret).toBe(before.staves[0].notes[i].fret + 2)
      expect(note.realValue).toBe(before.staves[0].notes[i].realValue + 2)
    })
  })

  it('refuses rather than clamping below fret 0, with the numbers in the message', () => {
    const score = loadFixture()
    const track = score.tracks[BASS]
    expect(fretRange(track.staves[0])).toMatchObject({ min: 0, max: 7 })
    const before = snapshotTrack(track)

    const result = transposeTrackByFrets(track, -1)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('fret 0')
    expect(result.reason).toContain('fret -1')
    // Nothing written: a partial transposition is worse than none.
    expect(snapshotTrack(track)).toEqual(before)
  })

  it('refuses rather than clamping above the top fret', () => {
    const score = loadFixture()
    const track = score.tracks[RHYTHM]
    const before = snapshotTrack(track)
    const result = transposeTrackByFrets(track, 1)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain(`fret ${MAX_FRET}`)
    expect(result.reason).toContain(`fret ${MAX_FRET + 1}`)
    expect(snapshotTrack(track)).toEqual(before)
  })

  it('allows exactly the shift that lands on the bound, and no more', () => {
    const score = loadFixture()
    const room = MAX_FRET - fretRange(score.tracks[LEAD].staves[0]).max
    expect(transposeTrackByFrets(loadFixture().tracks[LEAD], room).ok).toBe(true)
    expect(transposeTrackByFrets(loadFixture().tracks[LEAD], room + 1).ok).toBe(false)
  })

  it('survives a .gp round trip', () => {
    const score = loadFixture()
    transposeTrackByFrets(score.tracks[LEAD], 5)
    const before = snapshotTrack(score.tracks[LEAD])
    expect(snapshotTrack(roundTrip(score).tracks[LEAD]).staves[0]).toEqual(before.staves[0])
  })

  it('refuses a percussion track', () => {
    expect(transposeTrackByFrets(loadFixture().tracks[DRUMS], 2).ok).toBe(false)
  })
})

describe('retuneTrack', () => {
  const DROP_D = [64, 59, 55, 50, 45, 38]

  it('reassign: frets stay, pitches move', () => {
    const score = loadFixture()
    const track = score.tracks[LEAD]
    const before = snapshotTrack(track)

    expect(retuneTrack(track, DROP_D, RETUNE_REASSIGN)).toMatchObject({ ok: true, changed: true })

    const after = snapshotTrack(track)
    expect(after.staves[0].tuning).toEqual(DROP_D)
    after.staves[0].notes.forEach((note, i) => {
      expect(note.fret).toBe(before.staves[0].notes[i].fret)
    })
    // Drop D lowers string 1 and nothing else, so only the notes played on
    // string 1 change pitch, and they drop by exactly 2.
    after.staves[0].notes.forEach((note, i) => {
      const delta = note.string === 1 ? -2 : 0
      expect(note.realValue).toBe(before.staves[0].notes[i].realValue + delta)
    })
  })

  it('keep-pitch: pitches stay, frets move by the tuning delta of their string', () => {
    const score = loadFixture()
    const track = score.tracks[LEAD]
    const before = snapshotTrack(track)

    expect(retuneTrack(track, DROP_D, RETUNE_KEEP_PITCH)).toMatchObject({ ok: true, changed: true })

    const after = snapshotTrack(track)
    expect(after.staves[0].tuning).toEqual(DROP_D)
    after.staves[0].notes.forEach((note, i) => {
      // The whole point of the mode: the score sounds identical.
      expect(note.realValue).toBe(before.staves[0].notes[i].realValue)
      // Drop D lowers string 1 by 2, so its notes need 2 more frets.
      const delta = note.string === 1 ? 2 : 0
      expect(note.fret).toBe(before.staves[0].notes[i].fret + delta)
    })
  })

  it('keep-pitch refuses rather than clamping when a fret would go out of range', () => {
    const score = loadFixture()
    const track = score.tracks[BASS]
    const before = snapshotTrack(track)
    // Raising every string by 2 needs every fret 2 LOWER, and this track plays
    // open strings, so it cannot be done.
    const raised = track.staves[0].tuning.map((v) => v + 2)
    const result = retuneTrack(track, raised, RETUNE_KEEP_PITCH)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/Keeping the pitches/)
    expect(snapshotTrack(track)).toEqual(before)
  })

  it('refuses a change in the number of strings', () => {
    const score = loadFixture()
    const result = retuneTrack(score.tracks[LEAD], [64, 59, 55, 50, 45, 40, 35], RETUNE_REASSIGN)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/7 strings and this track has 6/)
  })

  it('refuses an unknown mode instead of guessing one', () => {
    expect(retuneTrack(loadFixture().tracks[LEAD], DROP_D, 'whatever').ok).toBe(false)
  })

  it('refuses tunings that are not midi keys', () => {
    const score = loadFixture()
    expect(retuneTrack(score.tracks[LEAD], [64, 59, 55, 50, 45, 999], RETUNE_REASSIGN).ok).toBe(false)
    expect(retuneTrack(score.tracks[LEAD], [], RETUNE_REASSIGN).ok).toBe(false)
  })

  it('reports no change when asked for the tuning it already has', () => {
    const score = loadFixture()
    const same = [...score.tracks[LEAD].staves[0].tuning]
    expect(retuneTrack(score.tracks[LEAD], same, RETUNE_KEEP_PITCH)).toMatchObject({
      changed: false,
    })
  })

  it('survives a .gp round trip in both modes', () => {
    for (const mode of [RETUNE_KEEP_PITCH, RETUNE_REASSIGN]) {
      const score = loadFixture()
      retuneTrack(score.tracks[LEAD], DROP_D, mode)
      const before = snapshotTrack(score.tracks[LEAD])
      expect(snapshotTrack(roundTrip(score).tracks[LEAD]).staves[0]).toEqual(before.staves[0])
    }
  })

  it('refuses a percussion track', () => {
    expect(retuneTrack(loadFixture().tracks[DRUMS], DROP_D, RETUNE_REASSIGN).ok).toBe(false)
  })
})

describe('setNoteFret', () => {
  const firstNote = (score, trackIndex) => [...stringedNotes(score.tracks[trackIndex].staves[0])][0]

  it('writes the fret and moves the sounding pitch immediately', () => {
    const score = loadFixture()
    const note = firstNote(score, LEAD)
    const before = note.realValue

    expect(setNoteFret(note, note.fret + 1)).toMatchObject({ ok: true, changed: true })
    // No finish(), no render: realValue is a getter over stringTuning + fret.
    expect(note.realValue).toBe(before + 1)
  })

  it('survives a .gp round trip', () => {
    const score = loadFixture()
    setNoteFret(firstNote(score, LEAD), 11)
    const back = roundTrip(score)
    expect(firstNote(back, LEAD).fret).toBe(11)
  })

  it('refuses out-of-range frets and leaves the note alone', () => {
    const score = loadFixture()
    const note = firstNote(score, LEAD)
    const before = note.fret
    for (const bad of [MIN_FRET - 1, MAX_FRET + 1, -10]) {
      expect(setNoteFret(note, bad).ok).toBe(false)
    }
    expect(note.fret).toBe(before)
  })

  it('accepts both bounds', () => {
    const score = loadFixture()
    expect(setNoteFret(firstNote(score, LEAD), MIN_FRET).ok).toBe(true)
    expect(setNoteFret(firstNote(score, LEAD), MAX_FRET).ok).toBe(true)
  })

  it('reports no change for the fret it already has', () => {
    const score = loadFixture()
    const note = firstNote(score, LEAD)
    expect(setNoteFret(note, note.fret)).toMatchObject({ ok: true, changed: false })
  })

  it('refuses a percussion note, which has no fret', () => {
    const score = loadFixture()
    const note = [...notesOf(score.tracks[DRUMS].staves[0])][0]
    expect(note.isStringed).toBe(false)
    const result = setNoteFret(note, 5)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no fret/)
  })

  it('refuses when there is no note', () => {
    expect(setNoteFret(null, 3).ok).toBe(false)
  })
})

// Pitfall 4: `realValue` for a natural harmonic is
// `harmonicPitch + stringTuning`, with the fret absent from the formula. Every
// fret-based operation has to refuse rather than silently leave those notes on
// their original pitch while the rest of the track moves.
describe('natural harmonics (pitfall 4)', () => {
  const naturals = (score) =>
    [...stringedNotes(score.tracks[HARM].staves[0])].filter(
      (note) => note.harmonicType === alphaTab.model.HarmonicType.Natural,
    )

  it('a fret shift really does leave a natural harmonic behind', () => {
    const score = loadFixture()
    const note = naturals(score)[0]
    const soundingBefore = note.realValue
    const plainBefore = note.calculateRealValue(false, false)

    note.fret += 2

    // The fret moved, and the plain fret + tuning value moved with it...
    expect(note.calculateRealValue(false, false)).toBe(plainBefore + 2)
    // ...but the pitch the note actually SOUNDS did not. That gap is pitfall 4.
    expect(note.realValue).toBe(soundingBefore)
  })

  it('a tuning shift DOES move a natural harmonic, which is the way out', () => {
    const score = loadFixture()
    const before = naturals(score).map((note) => note.realValue)
    expect(transposeTrackByTuning(score.tracks[HARM], 2).ok).toBe(true)
    expect(naturals(score).map((note) => note.realValue)).toEqual(before.map((v) => v + 2))
  })

  it('transposeTrackByFrets refuses, counts them, and points at the tuning', () => {
    const score = loadFixture()
    const before = snapshotTrack(score.tracks[HARM])
    const result = transposeTrackByFrets(score.tracks[HARM], 2)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('4 notes are natural harmonics')
    expect(result.reason).toMatch(/Transpose the tuning instead/)
    expect(snapshotTrack(score.tracks[HARM])).toEqual(before)
  })

  it('keep-pitch retuning refuses for the same reason', () => {
    const score = loadFixture()
    const before = snapshotTrack(score.tracks[HARM])
    const target = score.tracks[HARM].staves[0].tuning.map((v) => v - 1)
    const result = retuneTrack(score.tracks[HARM], target, RETUNE_KEEP_PITCH)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('natural harmonics')
    expect(snapshotTrack(score.tracks[HARM])).toEqual(before)
  })

  it('reassign retuning is still allowed: it never promised to hold pitches', () => {
    const score = loadFixture()
    const target = score.tracks[HARM].staves[0].tuning.map((v) => v - 1)
    expect(retuneTrack(score.tracks[HARM], target, RETUNE_REASSIGN).ok).toBe(true)
  })

  it('setNoteFret refuses a natural harmonic', () => {
    const score = loadFixture()
    const note = naturals(score)[0]
    const before = note.fret
    const result = setNoteFret(note, before + 1)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/natural harmonic/)
    expect(note.fret).toBe(before)
  })

  it('does NOT overreach onto artificial harmonics, whose pitch does follow the fret', () => {
    const score = loadFixture()
    const artificial = [...stringedNotes(score.tracks[HARM].staves[0])].find(
      (note) => note.harmonicType === alphaTab.model.HarmonicType.Artificial,
    )
    expect(artificial).toBeDefined()
    const before = artificial.realValue
    expect(setNoteFret(artificial, artificial.fret + 1).ok).toBe(true)
    expect(artificial.realValue).toBe(before + 1)
  })

  it('leaves tracks without natural harmonics free to transpose by fret', () => {
    const score = loadFixture()
    expect(countNaturalHarmonics(score.tracks[LEAD].staves[0])).toBe(0)
    expect(transposeTrackByFrets(score.tracks[LEAD], 2).ok).toBe(true)
  })
})

// The operation Alt + arrow performs: same note, different place on the neck.
describe('shiftNoteString', () => {
  // Picked by CRITERIA, not by position: moving up a string needs 4 or 5 frets
  // of room (the gap between adjacent open strings), so the first note of a
  // track is usually NOT movable - the fixture's is on fret 3 and would need
  // fret -2. Assuming otherwise is how these tests failed first time round.
  function movableUp(score, trackIndex = LEAD) {
    const staff = score.tracks[trackIndex].staves[0]
    const note = [...stringedNotes(staff)].find(
      (n) => n.string < staff.tuning.length && n.fret >= 5,
    )
    expect(note, 'the fixture needs a note with room to move up a string').toBeDefined()
    return note
  }

  it('keeps the sounding pitch exactly and moves the fret to compensate', () => {
    const score = loadFixture()
    const note = movableUp(score)
    const staff = score.tracks[LEAD].staves[0]
    const pitch = note.realValue
    const fromString = note.string
    const fromFret = note.fret

    expect(shiftNoteString(note, 1)).toMatchObject({ ok: true, changed: true })

    expect(note.string).toBe(fromString + 1)
    expect(note.realValue).toBe(pitch)
    // Going up a string means a higher-pitched open string, so a LOWER fret.
    expect(note.fret).toBeLessThan(fromFret)
    expect(note.fret).toBe(
      fromFret +
        tuningForString(staff.tuning, fromString) -
        tuningForString(staff.tuning, fromString + 1),
    )
  })

  it('moves down a string the same way, needing a higher fret', () => {
    const score = loadFixture()
    const note = movableUp(score)
    const pitch = note.realValue
    const fromFret = note.fret

    expect(shiftNoteString(note, -1).ok).toBe(true)
    expect(note.realValue).toBe(pitch)
    expect(note.fret).toBeGreaterThan(fromFret)
  })

  it('is its own inverse', () => {
    const score = loadFixture()
    const note = movableUp(score)
    const before = { string: note.string, fret: note.fret, pitch: note.realValue }
    expect(shiftNoteString(note, 1).ok).toBe(true)
    expect(shiftNoteString(note, -1).ok).toBe(true)
    expect({ string: note.string, fret: note.fret, pitch: note.realValue }).toEqual(before)
  })

  it('keeps Beat.noteStringLookup in step (pitfall 5)', () => {
    const score = loadFixture()
    const note = movableUp(score)
    const beat = note.beat
    const fromString = note.string

    expect(beat.getNoteOnString(fromString)).toBe(note)
    expect(shiftNoteString(note, 1).ok).toBe(true)

    // The Map is what MidiFileGenerator reads to decide where a let-ring stops,
    // and nothing but finish() would otherwise rebuild it.
    expect(beat.getNoteOnString(note.string)).toBe(note)
    expect(beat.hasNoteOnString(fromString)).toBe(false)
    expect(beat.getNoteOnString(fromString)).toBeNull()
  })

  it('leaves note.index and the chord order alone', () => {
    // A remove-and-re-add would renumber and reorder; a direct write must not.
    const score = loadFixture()
    const note = movableUp(score)
    const beat = note.beat
    const before = beat.notes.map((n) => n.index)
    const order = [...beat.notes]
    expect(shiftNoteString(note, 1).ok).toBe(true)
    expect(beat.notes.map((n) => n.index)).toEqual(before)
    expect(beat.notes).toEqual(order)
  })

  it('refuses past the highest and lowest string, and writes nothing', () => {
    const score = loadFixture()
    const staff = score.tracks[LEAD].staves[0]
    const notes = [...stringedNotes(staff)]

    const top = notes.find((n) => n.string === staff.tuning.length)
    if (top) {
      const before = { string: top.string, fret: top.fret }
      const result = shiftNoteString(top, 1)
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/no string/)
      expect({ string: top.string, fret: top.fret }).toEqual(before)
    }
    // And walking one down to string 1, then one press too far.
    const low = notes.find((n) => n.string > 1)
    while (low.string > 1 && shiftNoteString(low, -1).ok) {
      // walk until it either reaches string 1 or runs out of frets
    }
    const result = shiftNoteString(low, -1)
    expect(result.ok).toBe(false)
    expect(result.reason).toBeTruthy()
  })

  it('refuses to land on a string another note of the chord already plays', () => {
    const score = loadFixture()
    const note = movableUp(score)
    const beat = note.beat
    // Put a second note on the string just above, the way a chord would.
    const neighbour = new (note.constructor)()
    neighbour.string = note.string + 1
    neighbour.fret = 0
    beat.addNote(neighbour)

    const before = { string: note.string, fret: note.fret }
    const result = shiftNoteString(note, 1)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/already played by another note/)
    expect({ string: note.string, fret: note.fret }).toEqual(before)
  })

  it('refuses when the compensating fret would run off the neck', () => {
    const score = loadFixture()
    const note = movableUp(score)
    // Park it high enough that moving DOWN a string needs a fret past 24.
    note.fret = MAX_FRET
    const before = { string: note.string, fret: note.fret }
    const result = shiftNoteString(note, -1)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/outside the 0-24 range/)
    expect({ string: note.string, fret: note.fret }).toEqual(before)
  })

  it('refuses a natural harmonic, whose pitch follows the string (pitfall 4)', () => {
    const score = loadFixture()
    const natural = [...stringedNotes(score.tracks[HARM].staves[0])].find(
      (note) => note.harmonicType === alphaTab.model.HarmonicType.Natural,
    )
    const before = { string: natural.string, fret: natural.fret }
    const result = shiftNoteString(natural, 1)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/natural harmonic/)
    expect({ string: natural.string, fret: natural.fret }).toEqual(before)
  })

  it('refuses a percussion note and a missing note', () => {
    const score = loadFixture()
    const perc = [...notesOf(score.tracks[DRUMS].staves[0])][0]
    expect(shiftNoteString(perc, 1).ok).toBe(false)
    expect(shiftNoteString(null, 1).ok).toBe(false)
  })

  it('reports no change for a delta of 0', () => {
    const score = loadFixture()
    expect(shiftNoteString(movableUp(score), 0)).toMatchObject({ ok: true, changed: false })
  })

  it('survives a .gp round trip, string and fret both', () => {
    const score = loadFixture()
    const note = movableUp(score)
    const noteIndex = [...stringedNotes(score.tracks[LEAD].staves[0])].indexOf(note)
    expect(shiftNoteString(note, 1).ok).toBe(true)
    const expected = { string: note.string, fret: note.fret, pitch: note.realValue }

    const back = roundTrip(score)
    const same = [...stringedNotes(back.tracks[LEAD].staves[0])][noteIndex]
    expect({ string: same.string, fret: same.fret, pitch: same.realValue }).toEqual(expected)
  })
})

// The claim "moving a note to another string does not change what is played",
// checked where it actually matters: in the midi alphaTab generates.
describe('shiftNoteString against the generated midi', () => {
  function moveEveryNoteUpOneString(score) {
    let moved = 0
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        if (!staff.isStringed) continue
        for (const note of [...stringedNotes(staff)]) {
          if (shiftNoteString(note, 1).changed) moved += 1
        }
      }
    }
    return moved
  }

  it('leaves every midi note-on byte-identical', () => {
    const before = midiNoteOns(loadFixture())

    const score = loadFixture()
    const moved = moveEveryNoteUpOneString(score)
    expect(moved).toBeGreaterThan(10) // the move really did happen, a lot

    expect(midiNoteOns(score)).toEqual(before)
  })

  it('and the naive write would corrupt the lookup the generator reads', () => {
    // The counter-proof for pitfall 5: assigning note.string without fixing
    // Beat.noteStringLookup leaves every moved note unfindable on its own
    // string, which is what MidiFileGenerator consults for let-ring durations.
    const score = loadFixture()
    let moved = 0
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        if (!staff.isStringed) continue
        for (const note of [...stringedNotes(staff)]) {
          const target = note.string + 1
          if (target > staff.tuning.length) continue
          if (note.harmonicType === alphaTab.model.HarmonicType.Natural) continue
          if (note.beat.getNoteOnString(target)) continue
          const fret =
            note.fret +
            tuningForString(staff.tuning, note.string) -
            tuningForString(staff.tuning, target)
          if (fret < MIN_FRET || fret > MAX_FRET) continue
          note.string = target // the naive write
          note.fret = fret
          moved += 1
        }
      }
    }

    let stale = 0
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        for (const bar of staff.bars) {
          for (const voice of bar.voices) {
            for (const beat of voice.beats) {
              for (const note of beat.notes) {
                if (note.isStringed && beat.getNoteOnString(note.string) !== note) stale += 1
              }
            }
          }
        }
      }
    }
    expect(moved).toBeGreaterThan(10)
    expect(stale).toBe(moved) // every single one
  })
})

// The only STRUCTURAL edit, and the only one that calls finish(). Deleting a
// note is also the only one with no way back except reverting the file.
describe('deleteNotes', () => {
  const LINK_FIELDS = [
    'tieOrigin', 'tieDestination', 'hammerPullOrigin', 'hammerPullDestination',
    'slurOrigin', 'slurDestination', 'slideOrigin', 'slideTarget',
    'effectSlurOrigin', 'effectSlurDestination', 'bendOrigin',
  ]

  function everyNote(score) {
    const notes = []
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        for (const bar of staff.bars) {
          for (const voice of bar.voices) {
            for (const beat of voice.beats) notes.push(...beat.notes)
          }
        }
      }
    }
    return notes
  }

  function beatsOf(score, trackIndex) {
    const beats = []
    for (const staff of score.tracks[trackIndex].staves) {
      for (const bar of staff.bars) {
        for (const voice of bar.voices) beats.push(...voice.beats)
      }
    }
    return beats
  }

  it('turns an emptied beat into a rest of the SAME duration', () => {
    const score = loadFixture()
    const beat = beatsOf(score, LEAD)[0]
    const duration = beat.duration
    const note = beat.notes[0]

    expect(beat.isRest).toBe(false)
    expect(deleteNotes([note], settings)).toMatchObject({ ok: true, changed: true })

    expect(beat.notes).toHaveLength(0)
    expect(beat.isRest).toBe(true)
    // The whole point: silence of the same length, with no duration arithmetic.
    expect(beat.duration).toBe(duration)
  })

  it('leaves the rest of a chord sounding when one of its notes goes', () => {
    const score = loadFixture()
    const chord = beatsOf(score, TIES).find((b) => b.notes.length > 1)
    expect(chord).toBeDefined()
    const before = chord.notes.length
    const survivor = chord.notes[1]
    const survivorPitch = survivor.realValue

    expect(deleteNotes([chord.notes[0]], settings).ok).toBe(true)

    expect(chord.notes).toHaveLength(before - 1)
    expect(chord.isRest).toBe(false)
    expect(survivor.realValue).toBe(survivorPitch)
  })

  it('RENUMBERS note.index, which drives whammy generation', () => {
    const score = loadFixture()
    const chord = beatsOf(score, TIES).find((b) => b.notes.length > 1)
    // removeNote() splices without renumbering, so without the fix the survivor
    // would keep index 1 and no note would be index 0.
    expect(deleteNotes([chord.notes[0]], settings).ok).toBe(true)
    expect(chord.notes.map((n) => n.index)).toEqual(chord.notes.map((_, i) => i))
  })

  it('leaves NO link pointing at a deleted note', () => {
    const score = loadFixture()
    const linked = everyNote(score).filter(
      (n) => n.tieDestination || n.hammerPullDestination || n.slideTarget,
    )
    expect(linked.length).toBeGreaterThan(0) // the fixture really has links

    const victims = new Set(linked)
    expect(deleteNotes(linked, settings).ok).toBe(true)

    // A stale link survives finish(): Note.finish() only heals a tie whose
    // origin is already null, because `tieOrigin ?? findTieOrigin(this)`
    // short-circuits on a stale reference.
    let dangling = 0
    for (const note of everyNote(score)) {
      for (const field of LINK_FIELDS) if (victims.has(note[field])) dangling += 1
    }
    expect(dangling).toBe(0)
  })

  it('and the deleted notes are gone from the midi', () => {
    const before = midiNoteOns(loadFixture()).length

    const score = loadFixture()
    const notes = beatsOf(score, LEAD).slice(0, 4).flatMap((b) => b.notes)
    expect(deleteNotes(notes, settings).ok).toBe(true)

    expect(midiNoteOns(score).length).toBe(before - notes.length)
  })

  it('survives a .gp round trip: the rests come back as rests', () => {
    const score = loadFixture()
    const notes = beatsOf(score, LEAD).slice(0, 2).flatMap((b) => b.notes)
    expect(deleteNotes(notes, settings).ok).toBe(true)

    const back = roundTrip(score)
    const beats = beatsOf(back, LEAD)
    expect(beats[0].isRest).toBe(true)
    expect(beats[1].isRest).toBe(true)
    expect(beats[2].isRest).toBe(false)
    expect(back.masterBars.length).toBe(score.masterBars.length)
  })

  it('deletes a percussion note too: it is silence like any other', () => {
    const score = loadFixture()
    const beat = beatsOf(score, DRUMS)[0]
    expect(beat.notes.length).toBeGreaterThan(0)
    expect(deleteNotes([...beat.notes], settings).ok).toBe(true)
    expect(beat.isRest).toBe(true)
  })

  it('refuses an empty list and a note with no score', () => {
    expect(deleteNotes([], settings).ok).toBe(false)
    expect(deleteNotes(null, settings).ok).toBe(false)
    expect(deleteNotes([{ beat: null }], settings).ok).toBe(false)
  })

  it('reports how many notes went and how many beats fell silent', () => {
    const score = loadFixture()
    const notes = beatsOf(score, LEAD).slice(0, 3).flatMap((b) => b.notes)
    expect(deleteNotes(notes, settings)).toMatchObject({
      ok: true,
      noteCount: notes.length,
      beatCount: 3,
      restBeats: 3,
    })
  })

  it('does not disturb the other tracks', () => {
    const score = loadFixture()
    const untouched = snapshotTrack(score.tracks[BASS])
    const notes = beatsOf(score, LEAD).slice(0, 4).flatMap((b) => b.notes)
    expect(deleteNotes(notes, settings).ok).toBe(true)
    expect(snapshotTrack(score.tracks[BASS])).toEqual(untouched)
  })
})

// Every operation carries its own `undo`, and every one of them has to put the
// model back EXACTLY. Checked the only way that means anything: snapshot the
// whole score, edit, undo, and compare - plus the generated midi, which catches
// derived state a field-by-field comparison would miss.
describe('undo restores exactly', () => {
  function fullSnapshot(score) {
    return {
      tempo: tempoMap(score),
      tracks: score.tracks.map(snapshotTrack),
      // The link graph, as indexes rather than objects so it can be compared.
      links: linkGraph(score),
    }
  }

  function linkGraph(score) {
    const FIELDS = [
      'tieOrigin', 'tieDestination', 'hammerPullOrigin', 'hammerPullDestination',
      'slurOrigin', 'slurDestination', 'slideOrigin', 'slideTarget',
      'effectSlurOrigin', 'effectSlurDestination', 'bendOrigin',
    ]
    const notes = []
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        for (const bar of staff.bars) {
          for (const voice of bar.voices) {
            for (const beat of voice.beats) notes.push(...beat.notes)
          }
        }
      }
    }
    const id = new Map(notes.map((n, i) => [n, i]))
    return notes.map((note) => FIELDS.map((f) => (note[f] ? (id.get(note[f]) ?? 'external') : null)))
  }

  // Each case: a name, and what to do to a fresh fixture.
  const CASES = [
    ['rename', (score) => renameTrack(score.tracks[LEAD], 'Something Else')],
    ['tempo', (score) => applyScoreTempo(score, 187)],
    ['detune a track', (score) => transposeTrackByTuning(score.tracks[LEAD], -3)],
    ['transpose frets', (score) => transposeTrackByFrets(score.tracks[LEAD], 2)],
    [
      'retune, keep pitches',
      (score) => retuneTrack(score.tracks[LEAD], [64, 59, 55, 50, 45, 38], RETUNE_KEEP_PITCH),
    ],
    [
      'retune, keep frets',
      (score) => retuneTrack(score.tracks[LEAD], [64, 59, 55, 50, 45, 38], RETUNE_REASSIGN),
    ],
    [
      'one note fret',
      (score) => setNoteFret([...stringedNotes(score.tracks[LEAD].staves[0])][0], 9),
    ],
    [
      'one note string',
      (score) => {
        const staff = score.tracks[LEAD].staves[0]
        const note = [...stringedNotes(staff)].find(
          (n) => n.string < staff.tuning.length && n.fret >= 5,
        )
        return shiftNoteString(note, 1)
      },
    ],
    [
      'a batch of frets',
      (score) => shiftNotesFret([...stringedNotes(score.tracks[LEAD].staves[0])].slice(0, 6), 1),
    ],
    [
      'a batch of strings',
      (score) => {
        const staff = score.tracks[LEAD].staves[0]
        const notes = [...stringedNotes(staff)].filter(
          (n) => n.string < staff.tuning.length && n.fret >= 5,
        )
        return shiftNotesString(notes, 1)
      },
    ],
    [
      'silence one note',
      (score) =>
        deleteNotes([...stringedNotes(score.tracks[LEAD].staves[0])].slice(0, 1), settings),
    ],
    [
      'silence a passage',
      (score) =>
        deleteNotes([...stringedNotes(score.tracks[LEAD].staves[0])].slice(0, 6), settings),
    ],
    [
      'silence notes that are tie and slide origins',
      (score) => {
        const notes = []
        for (const staff of score.tracks[TIES].staves) {
          for (const note of stringedNotes(staff)) {
            if (note.tieDestination || note.hammerPullDestination || note.slideTarget) {
              notes.push(note)
            }
          }
        }
        expect(notes.length).toBeGreaterThan(0)
        return deleteNotes(notes, settings)
      },
    ],
    [
      'silence one note of a chord',
      (score) => {
        let chord = null
        for (const staff of score.tracks[TIES].staves) {
          for (const bar of staff.bars) {
            for (const voice of bar.voices) {
              for (const beat of voice.beats) if (beat.notes.length > 1) chord ??= beat
            }
          }
        }
        expect(chord).not.toBeNull()
        return deleteNotes([chord.notes[0]], settings)
      },
    ],
  ]

  for (const [name, apply] of CASES) {
    it(`puts the model back after: ${name}`, () => {
      const score = loadFixture()
      const before = fullSnapshot(score)
      const beforeMidi = midiNoteOns(score)

      const result = apply(score)
      expect(result, name).toMatchObject({ ok: true, changed: true })
      expect(typeof result.undo, `${name} must carry an undo`).toBe('function')
      // The edit really did something, or the test proves nothing.
      expect(fullSnapshot(score)).not.toEqual(before)

      result.undo()

      expect(fullSnapshot(score)).toEqual(before)
      expect(midiNoteOns(score)).toEqual(beforeMidi)
    })
  }

  it('unwinds a whole STACK of mixed edits, newest first', () => {
    const score = loadFixture()
    const before = fullSnapshot(score)
    const beforeMidi = midiNoteOns(score)

    // Every case applied to the SAME score, in order. Some become a no-op or a
    // refusal once an earlier one has moved their target, which is fine and is
    // exactly why the count is not asserted - only the round trip is.
    const undos = []
    for (const [, apply] of CASES) {
      const result = apply(score)
      if (result.changed) undos.push(result.undo)
    }
    expect(undos.length).toBeGreaterThanOrEqual(CASES.length - 2)
    expect(fullSnapshot(score)).not.toEqual(before)

    for (const undo of undos.reverse()) undo()

    expect(fullSnapshot(score)).toEqual(before)
    expect(midiNoteOns(score)).toEqual(beforeMidi)
  })

  it('and the undone score still exports and re-imports intact', () => {
    const score = loadFixture()
    const before = fullSnapshot(score)
    const result = deleteNotes(
      [...stringedNotes(score.tracks[TIES].staves[0])].slice(0, 5),
      settings,
    )
    result.undo()
    expect(fullSnapshot(score)).toEqual(before)

    const back = roundTrip(score)
    expect(back.tracks.map(snapshotTrack)).toEqual(before.tracks)
  })

  it('does not report an undo on a no-op', () => {
    const score = loadFixture()
    const same = renameTrack(score.tracks[LEAD], score.tracks[LEAD].name)
    expect(same).toMatchObject({ ok: true, changed: false })
    expect(same.undo).toBeUndefined()
  })
})

describe('read helpers for the UI', () => {
  it('describeNote is flat, plain and carries the master bar index', () => {
    const score = loadFixture()
    const note = [...stringedNotes(score.tracks[LEAD].staves[0])][0]
    const described = describeNote(note)
    expect(described).toMatchObject({
      trackIndex: LEAD,
      staffIndex: 0,
      barIndex: 0,
      string: note.string,
      fret: note.fret,
      stringCount: 6,
      midiKey: note.realValue,
    })
    // alphaTab spells accidentals as FLATS: midi 58 comes out "Bb3", not "A#3".
    expect(described.noteName).toMatch(/^[A-G]b?-?\d+$/)
    // Nothing that would drag the cyclic model graph into a reactive ref.
    expect(JSON.parse(JSON.stringify(described))).toEqual(described)
  })

  it('describeNote handles no selection', () => {
    expect(describeNote(null)).toBeNull()
  })

  it('describeTuning reads lowest string first, the way a player does', () => {
    expect(describeTuning([64, 59, 55, 50, 45, 40])).toBe('E A D G B E')
  })

  it('tuningChoices always contains the current tuning, preset or not', () => {
    const score = loadFixture()
    for (const track of stringedTracks(score)) {
      const staff = track.staves[0]
      const choices = tuningChoices(staff)
      expect(choices.length).toBeGreaterThan(0)
      const current = choices.filter((c) => c.isCurrent)
      expect(current).toHaveLength(1)
      expect(current[0].tunings).toEqual([...staff.tuning])
      // Every id is unique, since it is used as a <select> value.
      expect(new Set(choices.map((c) => c.id)).size).toBe(choices.length)
    }
  })

  it('tuningChoices prepends a custom entry when no preset matches', () => {
    const score = loadFixture()
    // 7 strings: alphaTab knows exactly ONE preset, and the fixture's tuning is
    // not it, so the current tuning has to be injected or it is unreachable.
    const choices = tuningChoices(score.tracks[RHYTHM].staves[0])
    expect(alphaTab.model.Tuning.findTuning(score.tracks[RHYTHM].staves[0].tuning)).toBeNull()
    expect(choices[0].isCurrent).toBe(true)
    expect(choices.length).toBe(alphaTab.model.Tuning.getPresetsFor(7).length + 1)
  })

  it('tuningChoices is empty for a staff with no tablature', () => {
    expect(tuningChoices(loadFixture().tracks[DRUMS].staves[0])).toEqual([])
  })

  it('fretRange reports zero notes rather than infinities', () => {
    expect(fretRange(loadFixture().tracks[DRUMS].staves[0])).toEqual({ count: 0, min: 0, max: 0 })
  })
})

describe('the .gp export itself', () => {
  it('round-trips an untouched score without losing tracks, bars or tempo', () => {
    const score = loadFixture()
    const back = roundTrip(score)
    expect(back.tracks.length).toBe(score.tracks.length)
    expect(back.masterBars.length).toBe(score.masterBars.length)
    expect(back.tempo).toBe(score.tempo)
    expect(back.title).toBe(score.title)
  })

  it('round-trips a score carrying several edits at once', () => {
    const score = loadFixture()
    renameTrack(score.tracks[LEAD], 'Edited Lead')
    applyScoreTempo(score, 156)
    transposeTrackByTuning(score.tracks[LEAD], -1)
    transposeTrackByFrets(score.tracks[BASS], 3)
    retuneTrack(score.tracks[RHYTHM], [64, 59, 55, 50, 45, 40, 35], RETUNE_KEEP_PITCH)
    setNoteFret([...stringedNotes(score.tracks[LEAD].staves[0])][0], 9)

    const expected = score.tracks.map(snapshotTrack)
    const expectedTempo = tempoMap(score)

    const back = roundTrip(score)
    expect(back.tracks.map(snapshotTrack)).toEqual(expected)
    expect(tempoMap(back)).toEqual(expectedTempo)
    expect(back.tempo).toBe(156)
  })
})
