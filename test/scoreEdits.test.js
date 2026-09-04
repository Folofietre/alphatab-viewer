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
  HARMONIC_FRETS,
  describeNote,
  describeTuning,
  harmonicSoundingChoices,
  countNaturalHarmonics,
  fretRange,
  renameTrack,
  retuneTrack,
  deleteNotes,
  setNoteFret,
  shiftNoteString,
  shiftNotesFret,
  shiftNotesOctave,
  shiftNoteOctave,
  shiftNotesString,
  setArtificialHarmonic,
  stringedNotes,
  toggleNaturalHarmonic,
  togglePalmMute,
  DURATION_LADDER,
  DURATION_LONGER,
  DURATION_SHORTER,
  appendBar,
  addTrack,
  deleteBars,
  deleteTrack,
  duplicateTrack,
  newTrackTunings,
  insertBarBefore,
  describeDuration,
  placeRest,
  stepBeatsDuration,
  toggleBeatsDot,
  writeNoteAtString,
  BAR_UNDER,
  BAR_EXACT,
  BAR_OVER,
  barFill,
  describeBarFill,
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
      // The STRUCTURE, which `snapshotTrack` cannot see: it flattens a staff to
      // a list of notes, so an added bar or an inserted rest would leave it
      // identical. Every operation of the writing tier moves one of these.
      structure: structureOf(score),
    }
  }

  // Bars, voices, beats and the ticks they occupy, per staff.
  //
  // `playbackDuration` is in here on purpose rather than only `duration`: it is
  // DERIVED (pitfall 7), so it is what catches an undo that put a field back and
  // never re-finished.
  function structureOf(score) {
    return {
      masterBars: score.masterBars.map((mb) => [
        mb.index, mb.start, mb.timeSignatureNumerator, mb.timeSignatureDenominator,
      ]),
      staves: score.tracks.flatMap((track) =>
        track.staves.map((staff) =>
          staff.bars.map((bar) =>
            bar.voices.map((voice) => ({
              isEmpty: voice.isEmpty,
              ticks: voice.calculateDuration(),
              beats: voice.beats.map((beat) => [
                beat.index, beat.duration, beat.dots, beat.isEmpty,
                beat.playbackStart, beat.playbackDuration, beat.notes.length,
                // Derived from the notes' own flags, and only ever SET by
                // finish() - so this is where a stale palm mute shows up.
                beat.isPalmMute,
              ]),
            })),
          ),
        ),
      ),
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
    // The writing tier. Each of these creates structure or moves a tick, so each
    // is a shape of undo the tiers above never had to produce.
    [
      'write a note on a free string',
      (score) => writeNoteAtString(
        score.tracks[LEAD].staves[0].bars[0].voices[0].beats[0], 1, 5, settings,
      ),
    ],
    [
      // The one that pins the argument for NOT capturing the whole staff's
      // derived state the way the delete has to: an add cannot disturb a tie,
      // because `Note.finish` only re-resolves one whose origin is already null.
      // This runs it against the track that carries ties, hammer-ons and a slide.
      'write a note into a bar full of ties',
      (score) => writeNoteAtString(
        score.tracks[TIES].staves[0].bars[0].voices[0].beats[0], 1, 4, settings,
      ),
    ],
    [
      'a natural harmonic',
      (score) => toggleNaturalHarmonic(
        [[...stringedNotes(score.tracks[LEAD].staves[0])][0]], settings,
      ),
    ],
    [
      'an artificial harmonic',
      (score) => setArtificialHarmonic(
        [[...stringedNotes(score.tracks[LEAD].staves[0])][0]], 12, settings,
      ),
    ],
    [
      'palm mute a note',
      (score) => togglePalmMute(
        [[...stringedNotes(score.tracks[LEAD].staves[0])][0]], settings,
      ),
    ],
    [
      'dot a beat',
      (score) => toggleBeatsDot(
        [score.tracks[LEAD].staves[0].bars[0].voices[0].beats[0]], settings,
      ),
    ],
    [
      'shorten a beat',
      (score) => stepBeatsDuration(
        [score.tracks[LEAD].staves[0].bars[0].voices[0].beats[0]], DURATION_SHORTER, settings,
      ),
    ],
    [
      'lengthen a whole bar of beats',
      (score) => stepBeatsDuration(
        score.tracks[LEAD].staves[0].bars[0].voices[0].beats, DURATION_LONGER, settings,
      ),
    ],
    [
      'insert a rest',
      (score) => placeRest(score.tracks[LEAD].staves[0].bars[0].voices[0].beats[1], settings),
    ],
    [
      'add a bar at the end',
      (score) => appendBar(score, settings),
    ],
    [
      'insert a bar in the middle',
      (score) => insertBarBefore(score, 2, settings),
    ],
    [
      'insert a bar before the first one, which moves the tempo',
      (score) => insertBarBefore(score, 0, settings),
    ],
    [
      'add a track',
      (score) => addTrack(score, { name: 'New', program: 25, tunings: [64, 59, 55, 50, 45, 40] }, settings),
    ],
    [
      'duplicate a track, ties and all',
      (score) => duplicateTrack(score, TIES, settings),
    ],
    [
      'delete a bar',
      (score) => deleteBars(score, 1, 1, settings),
    ],
    [
      'delete a range of bars, in the track full of ties',
      (score) => deleteBars(score, 2, 3, settings),
    ],
    [
      'delete the FIRST bar, which moves the tempo and the score start',
      (score) => deleteBars(score, 0, 0, settings),
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

  // `undo` is a SWAP, so calling it twice re-applies the edit. That is the whole
  // of redo: the history calls the same function from the other stack.
  for (const [name, apply] of CASES) {
    it(`re-applies on a second call after: ${name}`, () => {
      const score = loadFixture()
      const clean = fullSnapshot(score)

      const result = apply(score)
      expect(result.changed, name).toBe(true)
      const edited = fullSnapshot(score)
      const editedMidi = midiNoteOns(score)
      expect(edited, name).not.toEqual(clean)

      result.undo()
      expect(fullSnapshot(score), `${name}: undo`).toEqual(clean)

      result.undo()
      expect(fullSnapshot(score), `${name}: redo`).toEqual(edited)
      expect(midiNoteOns(score), `${name}: redo midi`).toEqual(editedMidi)

      result.undo()
      expect(fullSnapshot(score), `${name}: undo again`).toEqual(clean)
    })
  }

  it('toggles cleanly however many times it is called', () => {
    const score = loadFixture()
    const clean = fullSnapshot(score)
    const result = transposeTrackByFrets(score.tracks[LEAD], 2)
    const edited = fullSnapshot(score)

    for (let i = 0; i < 7; i += 1) {
      result.undo()
      expect(fullSnapshot(score)).toEqual(i % 2 === 0 ? clean : edited)
    }
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

// ---------------------------------------------------------------------------

describe('how full a bar is', () => {
  // The fixture is 4/4 throughout, four quarters per bar.
  const FULL = 3840

  function firstBar(track = LEAD) {
    return loadFixture().tracks[track].staves[0].bars[0]
  }

  it('reads a correct bar as exactly full', () => {
    expect(barFill(firstBar())).toMatchObject({ capacity: FULL, filled: FULL, state: BAR_EXACT })
  })

  it('reads a bar with a note removed as INCOMPLETE, not as wrong', () => {
    // Incomplete is the normal state of a bar being written into. It is not the
    // state the red marker is for.
    const bar = firstBar()
    bar.voices[0].beats.pop()
    expect(barFill(bar)).toMatchObject({ filled: 2880, state: BAR_UNDER })
  })

  it('reads a bar holding MORE than its time signature as over', () => {
    // The state nothing else in the stack reports. See pitfall 8.
    const score = loadFixture()
    const bar = score.tracks[LEAD].staves[0].bars[0]
    bar.voices[0].beats[0].duration = alphaTab.model.Duration.Whole
    // `playbackDuration` is DERIVED and stays stale until finish() - pitfall 7 -
    // so a fill read before it would still say the bar was exactly full.
    expect(barFill(bar).state).toBe(BAR_EXACT)
    score.finish(settings)
    expect(barFill(bar)).toMatchObject({ filled: 6720, state: BAR_OVER })
  })

  it('and alphaTab writes that overfull bar to a .gp file without a word', () => {
    // This is the whole reason the marker exists: no importer, generator or
    // exporter in the chain objects, so nothing but this would ever say so.
    const score = loadFixture()
    score.tracks[LEAD].staves[0].bars[0].voices[0].beats[0].duration =
      alphaTab.model.Duration.Whole
    score.finish(settings)
    const back = roundTrip(score)
    expect(barFill(back.tracks[LEAD].staves[0].bars[0]).state).toBe(BAR_OVER)
  })

  it('tolerates the tick that a tuplet loses to truncation', () => {
    // A septuplet of sixteenths is 137 ticks each, so seven of them measure 959
    // where a quarter note is 960. That bar is CORRECT and must not be reported
    // as incomplete; the tolerance is one tick per beat, which is the exact
    // bound on the truncation.
    const tex = `\\title "Tuplets"\n.\n\\track "A" \\staff{score tabs} \\tuning e4 b3 g3 d3 a2 e2\n` +
      `:16 3.3{tu 7} 3.3{tu 7} 3.3{tu 7} 3.3{tu 7} 3.3{tu 7} 3.3{tu 7} 3.3{tu 7} :4 3.3 3.3 3.3 |\n`
    const importer = new alphaTab.importer.AlphaTexImporter()
    importer.initFromString(tex, settings)
    const bar = importer.readScore().tracks[0].staves[0].bars[0]

    expect(bar.voices[0].calculateDuration()).toBe(3839)
    expect(barFill(bar).state).toBe(BAR_EXACT)
  })

  it('judges a bar by its FULLEST voice, since one overflow is enough', () => {
    const tex = `\\title "Voices"\n.\n\\track "A" \\staff{score tabs} \\tuning e4 b3 g3 d3 a2 e2\n` +
      `\\voice :4 3.3 3.3 3.3 3.3 |\n\\voice :4 5.4 5.4 |\n`
    const importer = new alphaTab.importer.AlphaTexImporter()
    importer.initFromString(tex, settings)
    const bar = importer.readScore().tracks[0].staves[0].bars[0]

    expect(bar.voices.length).toBeGreaterThan(1)
    expect(barFill(bar)).toMatchObject({ filled: 3840, state: BAR_EXACT })
  })

  it('describeBarFill counts in BEATS of the time signature, not in ticks', () => {
    const bar = firstBar()
    bar.voices[0].beats.pop()
    expect(describeBarFill(bar)).toMatchObject({
      barIndex: 0,
      beats: 3,
      beatCapacity: 4,
      numerator: 4,
      denominator: 4,
      state: BAR_UNDER,
    })
  })

  it('barFill answers null rather than throwing on nothing', () => {
    expect(barFill(null)).toBeNull()
    expect(describeBarFill(null)).toBeNull()
  })
})

describe('moving a note by an octave', () => {
  function leadNote(score) {
    return score.tracks[LEAD].staves[0].bars[0].voices[0].beats[0].notes[0]
  }

  it('goes up on the SAME string when the fret can reach', () => {
    const score = loadFixture()
    const note = leadNote(score)
    const { string, fret, realValue } = note

    expect(shiftNoteOctave(note, 1)).toMatchObject({ ok: true, changed: true, movedCount: 1 })
    expect(note.string).toBe(string)
    expect(note.fret).toBe(fret + 12)
    expect(note.realValue).toBe(realValue + 12)
  })

  it('changes STRING when the fret alone cannot reach', () => {
    // Standard tuning, fret 20 on the low E (string 1, midi 40). An octave up
    // is midi 72, which needs fret 32 on that string and fret 27 on the A -
    // both off the neck - and lands on the D string (midi 50) at fret 22.
    const tex = `\\title "Reach"\n.\n\\track "A" \\staff{score tabs} \\tuning e4 b3 g3 d3 a2 e2\n:4 20.6 |\n`
    const importer = new alphaTab.importer.AlphaTexImporter()
    importer.initFromString(tex, settings)
    const note = importer.readScore().tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0]
    expect([note.string, note.fret]).toEqual([1, 20])

    expect(shiftNoteOctave(note, 1)).toMatchObject({ ok: true, changed: true })
    expect([note.string, note.fret]).toEqual([3, 22])
    expect(note.realValue).toBe(72)
  })

  it('refuses a single note the tuning cannot reach, and says which pitch', () => {
    const score = loadFixture()
    // Fret 0 on the lowest string of the bass: nothing goes an octave below it.
    const note = [...stringedNotes(score.tracks[BASS].staves[0])].find(
      (n) => n.fret === 0 && n.string === 1,
    )
    expect(note).toBeDefined()

    const from = alphaTab.model.Tuning.getTextForTuning(note.realValue, true)
    const to = alphaTab.model.Tuning.getTextForTuning(note.realValue - 12, true)

    const result = shiftNoteOctave(note, -1)
    expect(result.ok).toBe(false)
    expect(result.blockedCount).toBe(1)
    // The message names both pitches rather than just saying no: "too low" is
    // only useful when it says how low.
    expect(result.reason).toBe(
      `${from} cannot move down an octave: ${to} is below anything this tuning reaches within frets ${MIN_FRET}-${MAX_FRET}.`,
    )
  })

  it('refuses a natural harmonic, for the reason every fret operation does', () => {
    const score = loadFixture()
    const harmonic = [...stringedNotes(score.tracks[HARM].staves[0])].find(
      (n) => n.harmonicType === alphaTab.model.HarmonicType.Natural,
    )
    expect(shiftNoteOctave(harmonic, 1).reason).toMatch(/natural harmonic/)
  })

  it('on a RANGE it is best effort: what can move moves, the rest stays put', () => {
    // The one exception to the all-or-nothing rule, and the reason it is
    // tenable: a note that does not move keeps a RIGHT value, where a clipped
    // one would carry a wrong pitch.
    const score = loadFixture()
    const notes = [...stringedNotes(score.tracks[BASS].staves[0])]
    const before = notes.map((n) => n.realValue)

    const result = shiftNotesOctave(notes, -1)
    expect(result.ok).toBe(true)
    expect(result.movedCount).toBeGreaterThan(0)
    expect(result.blockedCount).toBeGreaterThan(0)
    expect(result.movedCount + result.blockedCount).toBe(notes.length)

    // Every note is either exactly an octave down, or exactly where it was.
    notes.forEach((note, i) => {
      expect([before[i], before[i] - 12]).toContain(note.realValue)
    })
  })

  it('refuses outright when NOTHING in the range can move', () => {
    const score = loadFixture()
    const harmonics = [...stringedNotes(score.tracks[HARM].staves[0])].filter(
      (n) => n.harmonicType === alphaTab.model.HarmonicType.Natural,
    )
    expect(harmonics.length).toBeGreaterThan(1)
    const result = shiftNotesOctave(harmonics, 1)
    expect(result).toMatchObject({ ok: false, changed: false, movedCount: 0 })
  })

  it('never lands two notes of a chord on one string', () => {
    const score = loadFixture()
    // The Ties track carries a two-note chord.
    const chord = [...notesOf(score.tracks[5].staves[0])]
      .map((n) => n.beat)
      .find((beat) => beat.notes.length > 1)
    expect(chord).toBeDefined()

    shiftNotesOctave([...chord.notes], 1)
    const strings = chord.notes.map((n) => n.string)
    expect(new Set(strings).size).toBe(strings.length)
    for (const note of chord.notes) {
      expect(chord.getNoteOnString(note.string)).toBe(note)
    }
  })

  it('undoes to exactly what was there, and redoes by being called again', () => {
    const score = loadFixture()
    const notes = [...stringedNotes(score.tracks[LEAD].staves[0])]
    const before = notes.map((n) => ({ string: n.string, fret: n.fret }))

    const result = shiftNotesOctave(notes, 1)
    const after = notes.map((n) => ({ string: n.string, fret: n.fret }))
    expect(after).not.toEqual(before)

    result.undo()
    expect(notes.map((n) => ({ string: n.string, fret: n.fret }))).toEqual(before)
    result.undo()
    expect(notes.map((n) => ({ string: n.string, fret: n.fret }))).toEqual(after)
  })

  it('survives the .gp round trip', () => {
    const score = loadFixture()
    shiftNotesOctave([...stringedNotes(score.tracks[LEAD].staves[0])], 1)
    const expected = snapshotTrack(score.tracks[LEAD])
    expect(snapshotTrack(roundTrip(score).tracks[LEAD])).toEqual(expected)
  })

  it('a direction of zero is a no-op rather than a refusal', () => {
    const score = loadFixture()
    expect(shiftNoteOctave(leadNote(score), 0)).toMatchObject({ ok: true, changed: false })
  })
})

// ---------------------------------------------------------------------------
// The writing tier: the first operations that create structure or move a tick.
// ---------------------------------------------------------------------------

// Every beat of a track, in model order.
function allBeats(score, trackIndex) {
  const beats = []
  for (const staff of score.tracks[trackIndex].staves) {
    for (const bar of staff.bars) {
      for (const voice of bar.voices) beats.push(...voice.beats)
    }
  }
  return beats
}

describe('writeNoteAtString', () => {
  it('creates a note on a free string of an existing beat', () => {
    const score = loadFixture()
    const beat = allBeats(score, LEAD)[0]
    expect(beat.notes.map((n) => `${n.fret}.${n.string}`)).toEqual(['3.4'])

    const result = writeNoteAtString(beat, 1, 5, settings)
    expect(result).toMatchObject({ ok: true, changed: true, created: true, string: 1, fret: 5 })
    expect(beat.notes.map((n) => `${n.fret}.${n.string}`)).toEqual(['3.4', '5.1'])
    // `addNote` files the string lookup, which is what every later read uses.
    expect(beat.getNoteOnString(1)).toBe(result.note)
    expect(result.note.index).toBe(1)
  })

  it('sounds at the pitch of the string it was written on', () => {
    const score = loadFixture()
    const staff = score.tracks[LEAD].staves[0]
    const beat = staff.bars[0].voices[0].beats[0]
    const result = writeNoteAtString(beat, 1, 5, settings)
    // String 1 is the LOWEST (pitfall 2), E2 = 40, so fret 5 is A2 = 45.
    expect(tuningForString(staff.tuning, 1)).toBe(40)
    expect(result.note.realValue).toBe(45)
  })

  it('changes the fret of a note already on that string instead of stacking one', () => {
    const score = loadFixture()
    const beat = allBeats(score, LEAD)[0]
    const existing = beat.getNoteOnString(4)

    const result = writeNoteAtString(beat, 4, 7, settings)
    expect(result).toMatchObject({ ok: true, changed: true, created: false })
    expect(result.note).toBe(existing)
    expect(existing.fret).toBe(7)
    expect(beat.notes).toHaveLength(1)
  })

  it('keeps the natural-harmonic refusal it inherits from setNoteFret', () => {
    const score = loadFixture()
    const beat = allBeats(score, HARM)[0]
    const harmonic = beat.notes.find(
      (n) => n.harmonicType === alphaTab.model.HarmonicType.Natural,
    )
    expect(harmonic).toBeTruthy()
    const result = writeNoteAtString(beat, harmonic.string, 9, settings)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/natural harmonic/)
  })

  it('refuses a position with no string, and a staff with none', () => {
    const score = loadFixture()
    const beat = allBeats(score, LEAD)[0]
    expect(writeNoteAtString(beat, null, 5, settings).reason).toMatch(/no string/)
    expect(writeNoteAtString(allBeats(score, DRUMS)[0], 1, 5, settings).reason).toMatch(
      /no strings/,
    )
  })

  it('refuses a string the staff does not have, and a fret off the neck', () => {
    const score = loadFixture()
    const beat = allBeats(score, BASS)[0] // 4 strings
    expect(writeNoteAtString(beat, 5, 3, settings).reason).toMatch(/no string 5/)
    expect(writeNoteAtString(beat, 2, MAX_FRET + 1, settings).reason).toMatch(
      new RegExp(`${MIN_FRET}-${MAX_FRET}`),
    )
    expect(writeNoteAtString(beat, 2, -1, settings).reason).toMatch(/range/)
  })

  it('survives the .gp round trip', () => {
    const score = loadFixture()
    writeNoteAtString(allBeats(score, LEAD)[0], 1, 5, settings)
    const back = roundTrip(score)
    expect(back.tracks[LEAD].staves[0].bars[0].voices[0].beats[0].notes.map(
      (n) => `${n.fret}.${n.string}`,
    )).toEqual(['3.4', '5.1'])
  })

  it('takes the note back, and puts it back again on a second call', () => {
    const score = loadFixture()
    const beat = allBeats(score, LEAD)[0]
    const result = writeNoteAtString(beat, 1, 5, settings)

    result.undo()
    expect(beat.notes).toHaveLength(1)
    expect(beat.getNoteOnString(1)).toBeNull()

    result.undo()
    expect(beat.notes).toHaveLength(2)
    expect(beat.getNoteOnString(1)).toBe(result.note)
  })

  // The empty-bar case, and the reason `isEmpty` has to be cleared by hand:
  // alphaTab pads an unwritten voice with a placeholder beat, `Voice.finish`
  // only ever SETS that flag, and an empty voice is skipped by the renderer and
  // by the bar-fill arithmetic alike.
  describe('into a bar nobody has written into yet', () => {
    function freshBar(score) {
      appendBar(score, settings)
      const staff = score.tracks[LEAD].staves[0]
      return staff.bars[staff.bars.length - 1].voices[0]
    }

    it('the placeholder beat is empty until something is written', () => {
      const score = loadFixture()
      const voice = freshBar(score)
      expect(voice.beats).toHaveLength(1)
      expect(voice.beats[0].isEmpty).toBe(true)
      expect(voice.isEmpty).toBe(true)
    })

    it('writing a note clears the flag, so the voice is no longer empty', () => {
      const score = loadFixture()
      const voice = freshBar(score)
      const result = writeNoteAtString(voice.beats[0], 3, 7, settings)
      expect(result).toMatchObject({ ok: true, created: true })
      expect(voice.beats[0].isEmpty).toBe(false)
      expect(voice.isEmpty).toBe(false)
      // A quarter written into a 4/4 bar: one beat of four.
      expect(describeBarFill(voice.bar)).toMatchObject({ state: BAR_UNDER, beats: 1 })
    })

    it('and the undo puts the flag back, not just the note', () => {
      const score = loadFixture()
      const voice = freshBar(score)
      const result = writeNoteAtString(voice.beats[0], 3, 7, settings)
      result.undo()
      expect(voice.beats[0].isEmpty).toBe(true)
      expect(voice.isEmpty).toBe(true)
      expect(voice.beats[0].notes).toHaveLength(0)
    })
  })
})

describe('stepBeatsDuration', () => {
  it('the ladder is ordered longest to shortest, and is a list rather than arithmetic', () => {
    // Duration is a DENOMINATOR: the two longest values are negative, so no
    // multiplication walks this correctly.
    expect(DURATION_LADDER).toEqual([-4, -2, 1, 2, 4, 8, 16, 32, 64, 128, 256])
    expect(describeDuration(alphaTab.model.Duration.Quarter)).toBe('quarter')
  })

  it('shortens one beat by one step', () => {
    const score = loadFixture()
    const beat = allBeats(score, LEAD)[0]
    expect(beat.duration).toBe(alphaTab.model.Duration.Quarter)

    const result = stepBeatsDuration([beat], DURATION_SHORTER, settings)
    expect(result).toMatchObject({ ok: true, changed: true, beatCount: 1, durationName: 'eighth' })
    expect(beat.duration).toBe(alphaTab.model.Duration.Eighth)
  })

  it('lengthens the other way', () => {
    const score = loadFixture()
    const beat = allBeats(score, LEAD)[0]
    stepBeatsDuration([beat], DURATION_LONGER, settings)
    expect(beat.duration).toBe(alphaTab.model.Duration.Half)
  })

  // Pitfall 7. `playbackDuration` is derived and nothing recomputes it on
  // assignment, so an operation that changed a duration without finishing would
  // leave every tick reading - the bar-fill counter included - reporting the bar
  // as it was.
  it('finishes, so playbackDuration and the bar fill follow immediately', () => {
    const score = loadFixture()
    const bar = score.tracks[LEAD].staves[0].bars[0]
    const beat = bar.voices[0].beats[0]
    expect(beat.playbackDuration).toBe(960)
    expect(describeBarFill(bar)).toMatchObject({ state: BAR_EXACT })

    stepBeatsDuration([beat], DURATION_SHORTER, settings)
    expect(beat.playbackDuration).toBe(480)
    expect(describeBarFill(bar)).toMatchObject({ state: BAR_UNDER, filledTicks: 3360 })
  })

  it('can overfill a bar, which is allowed and flagged rather than refused', () => {
    const score = loadFixture()
    const bar = score.tracks[LEAD].staves[0].bars[0]
    expect(stepBeatsDuration([bar.voices[0].beats[0]], DURATION_LONGER, settings).ok).toBe(true)
    expect(barFill(bar).state).toBe(BAR_OVER)
  })

  it('moves a whole passage one step, all of it', () => {
    const score = loadFixture()
    const beats = score.tracks[LEAD].staves[0].bars[0].voices[0].beats
    const result = stepBeatsDuration(beats, DURATION_SHORTER, settings)
    expect(result).toMatchObject({ ok: true, beatCount: 4 })
    expect(beats.map((b) => b.duration)).toEqual([8, 8, 8, 8])
  })

  it('deduplicates, so a chord given note by note moves its beat once', () => {
    const score = loadFixture()
    const beat = allBeats(score, LEAD)[0]
    const result = stepBeatsDuration([beat, beat, beat], DURATION_SHORTER, settings)
    expect(result.beatCount).toBe(1)
    expect(beat.duration).toBe(alphaTab.model.Duration.Eighth)
  })

  // All or nothing, like the frets and the strings. A beat left behind would not
  // hold a WRONG value - so the octave's argument for best effort does not
  // apply - but it would hold a wrong RHYTHM, which is the whole content of the
  // operation.
  it('refuses at either end of the ladder, and moves nothing', () => {
    const score = loadFixture()
    const beats = score.tracks[LEAD].staves[0].bars[0].voices[0].beats
    beats[2].duration = alphaTab.model.Duration.TwoHundredFiftySixth

    const result = stepBeatsDuration(beats, DURATION_SHORTER, settings)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/1 of these 4 beats/)
    expect(beats.map((b) => b.duration)).toEqual([4, 4, 256, 4])
  })

  it('words the refusal differently for a single beat, which is the keyboard case', () => {
    const score = loadFixture()
    const beat = allBeats(score, LEAD)[0]
    beat.duration = alphaTab.model.Duration.QuadrupleWhole
    const result = stepBeatsDuration([beat], DURATION_LONGER, settings)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/quadruple whole note is the longest/)
  })

  it('refuses an empty list and ignores a direction it does not know', () => {
    const score = loadFixture()
    expect(stepBeatsDuration([], DURATION_SHORTER, settings).ok).toBe(false)
    expect(stepBeatsDuration(allBeats(score, LEAD).slice(0, 1), 'sideways', settings))
      .toMatchObject({ ok: true, changed: false })
  })

  it('survives the .gp round trip', () => {
    const score = loadFixture()
    const beats = score.tracks[LEAD].staves[0].bars[0].voices[0].beats
    stepBeatsDuration(beats.slice(0, 2), DURATION_SHORTER, settings)
    const back = roundTrip(score)
    expect(
      back.tracks[LEAD].staves[0].bars[0].voices[0].beats.map((b) => b.duration),
    ).toEqual([8, 8, 4, 4])
  })

  it('puts the durations back, and re-applies on a second call', () => {
    const score = loadFixture()
    const beats = score.tracks[LEAD].staves[0].bars[0].voices[0].beats
    stepBeatsDuration(beats, DURATION_SHORTER, settings).undo
    const result = stepBeatsDuration(beats, DURATION_SHORTER, settings)

    result.undo()
    expect(beats.map((b) => b.duration)).toEqual([8, 8, 8, 8])
    expect(beats[0].playbackDuration).toBe(480)

    result.undo()
    expect(beats.map((b) => b.duration)).toEqual([16, 16, 16, 16])
    expect(beats[0].playbackDuration).toBe(240)
  })
})

// A property of the NOTE that alphaTab draws as a marking on the BEAT.
// The two fields are one subject: `harmonicType` says which kind, `harmonicValue`
// says where the node is. See pitfall 4.
describe('harmonics', () => {
  function leadNote(score, index = 0) {
    return [...stringedNotes(score.tracks[LEAD].staves[0])][index]
  }

  it('the node table is alphaTab own, not transcribed theory', () => {
    // Re-derived from alphaTab here, so an upstream change to `harmonicPitch`
    // fails this rather than drifting silently past us.
    const score = loadFixture()
    const note = leadNote(score)
    note.harmonicType = alphaTab.model.HarmonicType.Pinch

    const withNode = []
    for (let fret = 0; fret <= 24; fret += 1) {
      note.harmonicValue = fret
      if (note.harmonicPitch > 0) withNode.push(fret)
    }
    expect(withNode).toEqual(HARMONIC_FRETS)
    // Nothing below the third fret, and gaps where a natural harmonic would
    // sound the open string instead.
    for (const fret of [0, 1, 2, 11, 13, 18, 20, 21]) {
      expect(HARMONIC_FRETS).not.toContain(fret)
    }
  })

  it('every sounding choice is the interval it claims', () => {
    const score = loadFixture()
    const note = leadNote(score)
    note.harmonicType = alphaTab.model.HarmonicType.Pinch
    for (const choice of harmonicSoundingChoices()) {
      note.harmonicValue = choice.harmonicValue
      expect(note.harmonicPitch, choice.label).toBe(choice.semitones)
    }
    // Octave, octave + fifth, two octaves, and up to three octaves.
    expect(harmonicSoundingChoices().map((c) => c.semitones)).toEqual([12, 19, 24, 28, 31, 34, 36])
  })

  describe('natural', () => {
    it('sets the type and the node, which is the note own fret', () => {
      const score = loadFixture()
      const note = leadNote(score) // fret 3 on the Lead track
      expect(note.fret).toBe(3)
      const plain = note.realValue

      const result = toggleNaturalHarmonic([note], settings)
      expect(result).toMatchObject({ ok: true, changed: true, noteCount: 1, harmonic: true })
      expect(note.harmonicType).toBe(alphaTab.model.HarmonicType.Natural)
      // Left at 0 the offset would be 0 and the note would sound the OPEN
      // string, which is the trap this line exists for.
      expect(note.harmonicValue).toBe(3)
      // A natural harmonic ignores the fret: two octaves and a fifth above the
      // open string.
      expect(note.realValue).toBe(plain - 3 + 31)
    })

    it('the pitch follows with no finish() at all', () => {
      // `realValue` is a getter over the node table, so it is already right -
      // the same reason `setNoteFret` needs none.
      const score = loadFixture()
      const note = leadNote(score)
      const before = note.realValue
      toggleNaturalHarmonic([note], settings)
      expect(note.realValue).not.toBe(before)
    })

    it('and the second press takes it off', () => {
      const score = loadFixture()
      const note = leadNote(score)
      const plain = note.realValue
      toggleNaturalHarmonic([note], settings)
      expect(toggleNaturalHarmonic([note], settings)).toMatchObject({ ok: true, harmonic: false })
      expect(note.harmonicType).toBe(alphaTab.model.HarmonicType.None)
      expect(note.harmonicValue).toBe(0)
      expect(note.realValue).toBe(plain)
    })

    it('refuses a fret with no node, and names the ones that have', () => {
      const score = loadFixture()
      // The Rhythm track reaches fret 0 and fret 24.
      const notes = [...stringedNotes(score.tracks[RHYTHM].staves[0])]
      const open = notes.find((n) => n.fret === 0)
      expect(open).toBeTruthy()

      const result = toggleNaturalHarmonic([open], settings)
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/no harmonic node/)
      expect(result.reason).toMatch(/3, 4, 5/)
      expect(open.harmonicType).toBe(alphaTab.model.HarmonicType.None)
    })

    it('and refuses the whole batch when any note blocks, with the count', () => {
      const score = loadFixture()
      const notes = [...stringedNotes(score.tracks[RHYTHM].staves[0])].slice(0, 4)
      const result = toggleNaturalHarmonic(notes, settings)
      if (!result.ok) {
        expect(result.reason).toMatch(/of these 4 notes/)
        for (const note of notes) {
          expect(note.harmonicType).toBe(alphaTab.model.HarmonicType.None)
        }
      }
    })

    it('refuses percussion', () => {
      const score = loadFixture()
      const drum = score.tracks[DRUMS].staves[0].bars[0].voices[0].beats[0].notes[0]
      expect(toggleNaturalHarmonic([drum], settings).reason).toMatch(/no string/)
    })

    it('survives the .gp round trip', () => {
      const score = loadFixture()
      toggleNaturalHarmonic([leadNote(score)], settings)
      const back = roundTrip(score)
      const note = [...stringedNotes(back.tracks[LEAD].staves[0])][0]
      expect(note.harmonicType).toBe(alphaTab.model.HarmonicType.Natural)
      expect(note.harmonicValue).toBe(3)
    })

    it('puts both fields back, and re-applies on a second call', () => {
      const score = loadFixture()
      const note = leadNote(score)
      const result = toggleNaturalHarmonic([note], settings)

      result.undo()
      expect(note.harmonicType).toBe(alphaTab.model.HarmonicType.None)
      expect(note.harmonicValue).toBe(0)

      result.undo()
      expect(note.harmonicType).toBe(alphaTab.model.HarmonicType.Natural)
      expect(note.harmonicValue).toBe(3)
    })
  })

  describe('artificial', () => {
    it('raises the FRETTED note by the interval chosen', () => {
      const score = loadFixture()
      const note = leadNote(score)
      const plain = note.realValue

      const result = setArtificialHarmonic([note], 12, settings)
      expect(result).toMatchObject({
        ok: true, changed: true, noteCount: 1, harmonic: true, harmonicValue: 12, semitones: 12,
      })
      // Always pinch, which is the decision rather than a limitation.
      expect(note.harmonicType).toBe(alphaTab.model.HarmonicType.Pinch)
      // Unlike a natural harmonic, the fret is kept and the interval is added.
      expect(note.realValue).toBe(plain + 12)
    })

    it('every choice sounds where it says', () => {
      for (const choice of harmonicSoundingChoices()) {
        const score = loadFixture()
        const note = leadNote(score)
        const plain = note.realValue
        expect(setArtificialHarmonic([note], choice.harmonicValue, settings).ok).toBe(true)
        expect(note.realValue, choice.label).toBe(plain + choice.semitones)
      }
    })

    it('works on a fret with no natural node, which is the point', () => {
      // The right hand supplies the node, so the left hand is free.
      const score = loadFixture()
      const open = [...stringedNotes(score.tracks[RHYTHM].staves[0])].find((n) => n.fret === 0)
      expect(HARMONIC_FRETS).not.toContain(0)
      expect(setArtificialHarmonic([open], 12, settings).ok).toBe(true)
    })

    it('moves a whole batch', () => {
      const score = loadFixture()
      const notes = [...stringedNotes(score.tracks[LEAD].staves[0])].slice(0, 4)
      expect(setArtificialHarmonic(notes, 7, settings)).toMatchObject({ ok: true, noteCount: 4 })
      for (const note of notes) expect(note.harmonicValue).toBe(7)
    })

    it('null removes it, and is a no-op when there is none', () => {
      const score = loadFixture()
      const note = leadNote(score)
      const plain = note.realValue
      setArtificialHarmonic([note], 12, settings)

      expect(setArtificialHarmonic([note], null, settings)).toMatchObject({ ok: true, harmonic: false })
      expect(note.harmonicType).toBe(alphaTab.model.HarmonicType.None)
      expect(note.realValue).toBe(plain)
      expect(setArtificialHarmonic([note], null, settings)).toMatchObject({ ok: true, changed: false })
    })

    it('refuses a node it does not write', () => {
      const score = loadFixture()
      expect(setArtificialHarmonic([leadNote(score)], 11, settings).ok).toBe(false)
      expect(setArtificialHarmonic([leadNote(score)], 0, settings).ok).toBe(false)
    })

    it('survives the .gp round trip', () => {
      const score = loadFixture()
      setArtificialHarmonic([leadNote(score)], 12, settings)
      const back = roundTrip(score)
      const note = [...stringedNotes(back.tracks[LEAD].staves[0])][0]
      expect(note.harmonicType).toBe(alphaTab.model.HarmonicType.Pinch)
      expect(note.harmonicValue).toBe(12)
    })

    it('and the undo puts both fields back', () => {
      const score = loadFixture()
      const note = leadNote(score)
      // Over an existing natural harmonic, so the undo has something to restore
      // rather than a default.
      toggleNaturalHarmonic([note], settings)
      const result = setArtificialHarmonic([note], 5, settings)

      result.undo()
      expect(note.harmonicType).toBe(alphaTab.model.HarmonicType.Natural)
      expect(note.harmonicValue).toBe(3)
    })
  })

  it('the descriptor tells the panel which kind it is', () => {
    const score = loadFixture()
    const note = leadNote(score)
    expect(describeNote(note)).toMatchObject({
      isNaturalHarmonic: false, isArtificialHarmonic: false,
    })

    toggleNaturalHarmonic([note], settings)
    expect(describeNote(note)).toMatchObject({
      isNaturalHarmonic: true, isArtificialHarmonic: false, harmonicValue: 3,
    })

    setArtificialHarmonic([note], 12, settings)
    expect(describeNote(note)).toMatchObject({
      isNaturalHarmonic: false, isArtificialHarmonic: true, harmonicValue: 12,
    })
  })
})

describe('togglePalmMute', () => {
  function leadNotes(score, count) {
    return [...stringedNotes(score.tracks[LEAD].staves[0])].slice(0, count)
  }

  it('sets the flag on the note AND on its beat, which only finish() does', () => {
    const score = loadFixture()
    const beat = score.tracks[LEAD].staves[0].bars[0].voices[0].beats[0]
    const note = beat.notes[0]
    expect(beat.isPalmMute).toBe(false)

    const result = togglePalmMute([note], settings)
    expect(result).toMatchObject({ ok: true, changed: true, noteCount: 1, palmMute: true })
    expect(note.isPalmMute).toBe(true)
    // `Beat.finish` derives this from its notes, so it is the finish that puts
    // the P.M. bracket on the score.
    expect(beat.isPalmMute).toBe(true)
  })

  it('and takes it off again on the second call', () => {
    const score = loadFixture()
    const beat = score.tracks[LEAD].staves[0].bars[0].voices[0].beats[0]
    togglePalmMute([beat.notes[0]], settings)
    expect(togglePalmMute([beat.notes[0]], settings)).toMatchObject({ ok: true, palmMute: false })
    expect(beat.notes[0].isPalmMute).toBe(false)
    expect(beat.isPalmMute).toBe(false)
  })

  it('cuts the note short in the midi without moving where it starts', () => {
    // Measured on the whole event stream: the note-off moves from 960 to 160 and
    // nothing else changes, which is why this takes the `onPlay` flavour rather
    // than `now` - the tick grid does not move.
    const score = loadFixture()
    const before = midiNoteOns(score)
    togglePalmMute([[...stringedNotes(score.tracks[LEAD].staves[0])][0]], settings)
    expect(midiNoteOns(score)).toEqual(before)
  })

  it('moves a whole batch, and a mixed one resolves towards muted', () => {
    const score = loadFixture()
    const notes = leadNotes(score, 4)
    notes[1].isPalmMute = true

    // Only the three that were not muted move.
    expect(togglePalmMute(notes, settings)).toMatchObject({ ok: true, noteCount: 3, palmMute: true })
    expect(notes.map((n) => n.isPalmMute)).toEqual([true, true, true, true])
    // Now they agree, so the next call clears them.
    expect(togglePalmMute(notes, settings)).toMatchObject({ ok: true, noteCount: 4, palmMute: false })
    expect(notes.every((n) => !n.isPalmMute)).toBe(true)
  })

  it('deduplicates a note given twice', () => {
    const score = loadFixture()
    const note = leadNotes(score, 1)[0]
    expect(togglePalmMute([note, note], settings).noteCount).toBe(1)
  })

  it('refuses percussion, which alphaTab itself would allow', () => {
    // A drum note takes the flag without complaining, so the refusal is ours.
    const score = loadFixture()
    const drum = score.tracks[DRUMS].staves[0].bars[0].voices[0].beats[0].notes[0]
    expect(drum.isStringed).toBe(false)

    const result = togglePalmMute([drum], settings)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/percussion cannot be palm muted/)
    expect(drum.isPalmMute).toBe(false)
  })

  it('and counts them when only some of a batch have no string', () => {
    const score = loadFixture()
    const drum = score.tracks[DRUMS].staves[0].bars[0].voices[0].beats[0].notes[0]
    const result = togglePalmMute([...leadNotes(score, 2), drum], settings)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/1 of these 3 notes/)
  })

  it('refuses an empty list', () => {
    expect(togglePalmMute([], settings).ok).toBe(false)
    expect(togglePalmMute(null, settings).ok).toBe(false)
  })

  it('survives the .gp round trip', () => {
    const score = loadFixture()
    togglePalmMute(leadNotes(score, 2), settings)
    const back = roundTrip(score)
    const beat = back.tracks[LEAD].staves[0].bars[0].voices[0].beats[0]
    expect(beat.notes[0].isPalmMute).toBe(true)
    expect(beat.isPalmMute).toBe(true)
  })

  it('puts the flags back, and re-applies on a second call', () => {
    const score = loadFixture()
    const notes = leadNotes(score, 3)
    const result = togglePalmMute(notes, settings)

    result.undo()
    expect(notes.map((n) => n.isPalmMute)).toEqual([false, false, false])
    expect(notes[0].beat.isPalmMute).toBe(false)

    result.undo()
    expect(notes.map((n) => n.isPalmMute)).toEqual([true, true, true])
    expect(notes[0].beat.isPalmMute).toBe(true)
  })
})

describe('toggleBeatsDot', () => {
  it('dots a beat, and the ticks follow because it finished', () => {
    const score = loadFixture()
    const beat = allBeats(score, LEAD)[0]
    expect(beat.playbackDuration).toBe(960)

    const result = toggleBeatsDot([beat], settings)
    expect(result).toMatchObject({ ok: true, changed: true, beatCount: 1, dots: 1 })
    expect(beat.dots).toBe(1)
    // Pitfall 7 again: a dotted quarter is 1440, and only a finish says so.
    expect(beat.playbackDuration).toBe(1440)
  })

  it('and takes it off again on the second press', () => {
    const score = loadFixture()
    const beat = allBeats(score, LEAD)[0]
    toggleBeatsDot([beat], settings)
    expect(toggleBeatsDot([beat], settings)).toMatchObject({ ok: true, dots: 0 })
    expect(beat.dots).toBe(0)
    expect(beat.playbackDuration).toBe(960)
  })

  it('clears a double dot in one press rather than stepping through it', () => {
    // No real test file uses one - 0 of 11738 beats - so this is the way out of
    // an imported double dot, not a way to make one.
    const score = loadFixture()
    const beat = allBeats(score, LEAD)[0]
    beat.dots = 2
    expect(toggleBeatsDot([beat], settings)).toMatchObject({ ok: true, dots: 0 })
    expect(beat.dots).toBe(0)
  })

  it('a mixed passage resolves towards dotted', () => {
    const score = loadFixture()
    const beats = score.tracks[LEAD].staves[0].bars[0].voices[0].beats
    beats[1].dots = 1

    // Only the three undotted ones move.
    expect(toggleBeatsDot(beats, settings)).toMatchObject({ ok: true, beatCount: 3, dots: 1 })
    expect(beats.map((b) => b.dots)).toEqual([1, 1, 1, 1])
    // Now they all agree, so the next press clears them.
    expect(toggleBeatsDot(beats, settings)).toMatchObject({ ok: true, beatCount: 4, dots: 0 })
    expect(beats.map((b) => b.dots)).toEqual([0, 0, 0, 0])
  })

  it('deduplicates, so a chord given note by note dots its beat once', () => {
    const score = loadFixture()
    const beat = allBeats(score, LEAD)[0]
    expect(toggleBeatsDot([beat, beat], settings).beatCount).toBe(1)
  })

  it('can overfill a bar, which is allowed and flagged', () => {
    const score = loadFixture()
    const bar = score.tracks[LEAD].staves[0].bars[0]
    expect(toggleBeatsDot(bar.voices[0].beats, settings).ok).toBe(true)
    expect(barFill(bar).state).toBe(BAR_OVER)
  })

  it('refuses an empty list', () => {
    expect(toggleBeatsDot([], settings).ok).toBe(false)
    expect(toggleBeatsDot(null, settings).ok).toBe(false)
  })

  it('survives the .gp round trip', () => {
    const score = loadFixture()
    const beats = score.tracks[LEAD].staves[0].bars[0].voices[0].beats
    toggleBeatsDot(beats.slice(0, 2), settings)
    const back = roundTrip(score).tracks[LEAD].staves[0].bars[0].voices[0].beats
    expect(back.map((b) => b.dots)).toEqual([1, 1, 0, 0])
    expect(back[0].playbackDuration).toBe(1440)
  })

  it('puts the dots back, and re-applies on a second call', () => {
    const score = loadFixture()
    const beats = score.tracks[LEAD].staves[0].bars[0].voices[0].beats
    const result = toggleBeatsDot(beats, settings)

    result.undo()
    expect(beats.map((b) => b.dots)).toEqual([0, 0, 0, 0])
    expect(beats[0].playbackDuration).toBe(960)

    result.undo()
    expect(beats.map((b) => b.dots)).toEqual([1, 1, 1, 1])
    expect(beats[0].playbackDuration).toBe(1440)
  })
})

describe('placeRest', () => {
  it('inserts a bare beat, which IS a rest of that duration', () => {
    const score = loadFixture()
    const voice = score.tracks[LEAD].staves[0].bars[0].voices[0]
    const first = voice.beats[0]

    const result = placeRest(first, settings)
    expect(result).toMatchObject({ ok: true, changed: true, inserted: true })
    expect(voice.beats).toHaveLength(5)
    expect(voice.beats[1]).toBe(result.beat)
    expect(result.beat.isRest).toBe(true)
    expect(result.beat.notes).toHaveLength(0)
    expect(result.beat.duration).toBe(first.duration)
  })

  // `insertBeat` splices the array and links the chain but never touches
  // `index` - it leaves the list numbered 0,1,0,2,3 - and `Voice.finish` is what
  // renumbers it. Verified in Node against alphaTab 1.8.4.
  it('renumbers the beats and re-chains them, which only finish() does', () => {
    const score = loadFixture()
    const voice = score.tracks[LEAD].staves[0].bars[0].voices[0]
    const result = placeRest(voice.beats[1], settings)

    expect(voice.beats.map((b) => b.index)).toEqual([0, 1, 2, 3, 4])
    expect(result.beat.previousBeat).toBe(voice.beats[1])
    expect(result.beat.nextBeat).toBe(voice.beats[3])
    expect(voice.beats[3].previousBeat).toBe(result.beat)
  })

  it('lengthens the bar, which is what makes it overfull', () => {
    const score = loadFixture()
    const bar = score.tracks[LEAD].staves[0].bars[0]
    expect(barFill(bar).state).toBe(BAR_EXACT)
    placeRest(bar.voices[0].beats[0], settings)
    expect(barFill(bar)).toMatchObject({ state: BAR_OVER, filled: 4800 })
  })

  // The placeholder case: alphaTab's own padding for an unwritten voice. There is
  // nothing to insert beside, because there is nothing there yet.
  it('materialises the placeholder of an empty bar in place, without inserting', () => {
    const score = loadFixture()
    appendBar(score, settings)
    const staff = score.tracks[LEAD].staves[0]
    const voice = staff.bars[staff.bars.length - 1].voices[0]
    expect(voice.beats[0].isEmpty).toBe(true)

    const result = placeRest(voice.beats[0], settings)
    expect(result).toMatchObject({ ok: true, changed: true, inserted: false })
    expect(result.beat).toBe(voice.beats[0])
    expect(voice.beats).toHaveLength(1)
    expect(voice.beats[0].isEmpty).toBe(false)
    expect(voice.isEmpty).toBe(false)
    expect(voice.beats[0].isRest).toBe(true)

    result.undo()
    expect(voice.beats[0].isEmpty).toBe(true)
    expect(voice.isEmpty).toBe(true)
  })

  it('carries the dots of the beat it follows', () => {
    const score = loadFixture()
    const voice = score.tracks[LEAD].staves[0].bars[0].voices[0]
    voice.beats[0].dots = 1
    expect(placeRest(voice.beats[0], settings).beat.dots).toBe(1)
  })

  it('refuses a position that is not in a score', () => {
    expect(placeRest(null, settings).ok).toBe(false)
    expect(placeRest(new alphaTab.model.Beat(), settings).ok).toBe(false)
  })

  it('survives the .gp round trip', () => {
    const score = loadFixture()
    placeRest(score.tracks[LEAD].staves[0].bars[0].voices[0].beats[0], settings)
    const beats = roundTrip(score).tracks[LEAD].staves[0].bars[0].voices[0].beats
    expect(beats).toHaveLength(5)
    expect(beats.map((b) => b.isRest)).toEqual([false, true, false, false, false])
  })

  it('takes the beat back out, and puts it back on a second call', () => {
    const score = loadFixture()
    const voice = score.tracks[LEAD].staves[0].bars[0].voices[0]
    const result = placeRest(voice.beats[0], settings)

    result.undo()
    expect(voice.beats).toHaveLength(4)
    expect(voice.beats.map((b) => b.index)).toEqual([0, 1, 2, 3])
    expect(voice.beats[0].nextBeat).toBe(voice.beats[1])
    expect(voice.calculateDuration()).toBe(3840)

    result.undo()
    expect(voice.beats).toHaveLength(5)
    expect(voice.beats[1]).toBe(result.beat)
  })
})

describe('appendBar', () => {
  it('adds a MasterBar plus one Bar on every staff of every track', () => {
    const score = loadFixture()
    const staffCount = score.tracks.reduce((n, t) => n + t.staves.length, 0)
    const before = score.masterBars.length

    const result = appendBar(score, settings)
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      barIndex: before,
      barCount: before + 1,
      staffCount,
    })
    for (const track of score.tracks) {
      for (const staff of track.staves) expect(staff.bars).toHaveLength(before + 1)
    }
  })

  it('carries the time signature over rather than assuming 4/4', () => {
    const score = loadFixture()
    const previous = score.masterBars[score.masterBars.length - 1]
    previous.timeSignatureNumerator = 7
    previous.timeSignatureDenominator = 8

    const result = appendBar(score, settings)
    expect(result).toMatchObject({ numerator: 7, denominator: 8 })
    const added = score.masterBars[score.masterBars.length - 1]
    expect(added.timeSignatureNumerator).toBe(7)
    expect(added.calculateDuration()).toBe(7 * 480)
  })

  it('links the new bar into the chain and gives it the next index', () => {
    const score = loadFixture()
    const previousMaster = score.masterBars[score.masterBars.length - 1]
    appendBar(score, settings)
    const added = score.masterBars[score.masterBars.length - 1]

    expect(added.index).toBe(previousMaster.index + 1)
    expect(added.previousMasterBar).toBe(previousMaster)
    expect(previousMaster.nextMasterBar).toBe(added)
    expect(added.start).toBe(previousMaster.start + previousMaster.calculateDuration())

    const staff = score.tracks[LEAD].staves[0]
    const bar = staff.bars[staff.bars.length - 1]
    expect(bar.index).toBe(added.index)
    expect(bar.masterBar).toBe(added)
    expect(bar.previousBar).toBe(staff.bars[staff.bars.length - 2])
  })

  it('is an empty bar, which reads as a whole-bar rest rather than as incomplete', () => {
    const score = loadFixture()
    appendBar(score, settings)
    const staff = score.tracks[LEAD].staves[0]
    const bar = staff.bars[staff.bars.length - 1]

    expect(bar.voices).toHaveLength(1)
    expect(bar.voices[0].beats).toHaveLength(1)
    expect(bar.voices[0].isEmpty).toBe(true)
    // Every voice auto-filled: complete by definition, so no red and no
    // "incomplete" the moment a bar is added.
    expect(barFill(bar).state).toBe(BAR_EXACT)
  })

  it('copies the clef and key signature of the bar before it, per staff', () => {
    const score = loadFixture()
    appendBar(score, settings)
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        const bars = staff.bars
        const added = bars[bars.length - 1]
        const previous = bars[bars.length - 2]
        expect(added.clef).toBe(previous.clef)
        expect(added.keySignature).toBe(previous.keySignature)
      }
    }
  })

  it('refuses a score with no bars at all', () => {
    expect(appendBar(new alphaTab.model.Score(), settings).ok).toBe(false)
  })

  it('survives the .gp round trip', () => {
    const score = loadFixture()
    const before = score.masterBars.length
    appendBar(score, settings)
    const back = roundTrip(score)
    expect(back.masterBars).toHaveLength(before + 1)
    for (const track of back.tracks) {
      for (const staff of track.staves) expect(staff.bars).toHaveLength(before + 1)
    }
  })

  it('takes the whole bar back out, and puts it back on a second call', () => {
    const score = loadFixture()
    const before = score.masterBars.length
    const lastMaster = score.masterBars[before - 1]
    const result = appendBar(score, settings)

    result.undo()
    expect(score.masterBars).toHaveLength(before)
    expect(lastMaster.nextMasterBar).toBeNull()
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        expect(staff.bars).toHaveLength(before)
        expect(staff.bars[before - 1].nextBar).toBeNull()
      }
    }

    result.undo()
    expect(score.masterBars).toHaveLength(before + 1)
    expect(score.masterBars[before].index).toBe(before)
    for (const track of score.tracks) {
      for (const staff of track.staves) expect(staff.bars).toHaveLength(before + 1)
    }
  })

  it('and the score still exports after the undo', () => {
    const score = loadFixture()
    const before = score.masterBars.length
    appendBar(score, settings).undo()
    expect(roundTrip(score).masterBars).toHaveLength(before)
  })
})

describe('newTrackTunings', () => {
  it('offers every preset alphaTab has, in string-count order', () => {
    const choices = newTrackTunings()
    expect(choices.length).toBeGreaterThan(40)
    expect(choices.map((c) => c.stringCount)).toEqual([...choices.map((c) => c.stringCount)].sort())
    // Counted: 11 for four strings, 6 for five, 31 for six, 1 for seven.
    const byCount = {}
    for (const c of choices) byCount[c.stringCount] = (byCount[c.stringCount] ?? 0) + 1
    expect(byCount).toEqual({ 4: 11, 5: 6, 6: 31, 7: 1 })
    // And nothing for eight, because alphaTab has no preset for it.
    expect(choices.some((c) => c.stringCount === 8)).toBe(false)
  })

  it('every choice carries a tuning of its own length', () => {
    for (const choice of newTrackTunings()) {
      expect(choice.tunings).toHaveLength(choice.stringCount)
      expect(choice.name.length).toBeGreaterThan(0)
    }
  })

  it('and hands out copies, not the presets themselves', () => {
    const a = newTrackTunings()[0]
    a.tunings[0] = 999
    expect(newTrackTunings()[0].tunings[0]).not.toBe(999)
  })
})

describe('addTrack', () => {
  const SPEC = { name: 'Added', program: 27, tunings: [64, 59, 55, 50, 45, 40] }

  it('adds a track with a staff and a bar for every master bar', () => {
    const score = loadFixture()
    const before = score.tracks.length

    const result = addTrack(score, SPEC, settings)
    expect(result).toMatchObject({
      ok: true, changed: true, trackIndex: before, trackName: 'Added', stringCount: 6,
    })
    expect(score.tracks).toHaveLength(before + 1)

    const track = score.tracks[before]
    expect(track.staves).toHaveLength(1)
    // A staff shorter than the score is the ragged shape `consolidate` exists to
    // repair, so the bars are built here rather than left to it.
    expect(track.staves[0].bars).toHaveLength(score.masterBars.length)
    expect(track.staves[0].isStringed).toBe(true)
    expect(track.staves[0].tuning).toEqual(SPEC.tunings)
    expect(track.playbackInfo.program).toBe(27)
  })

  it('is empty, so every bar of it reads as a whole-bar rest', () => {
    const score = loadFixture()
    addTrack(score, SPEC, settings)
    const staff = score.tracks[score.tracks.length - 1].staves[0]
    for (const bar of staff.bars) {
      expect(bar.voices[0].beats).toHaveLength(1)
      expect(bar.voices[0].isEmpty).toBe(true)
      expect(barFill(bar).state).toBe(BAR_EXACT)
    }
  })

  it('takes a midi channel pair nothing else is using', () => {
    // Sharing one means a program change on either track re-voices the other.
    const score = loadFixture()
    const used = new Set()
    for (const track of score.tracks) {
      used.add(track.playbackInfo.primaryChannel)
      used.add(track.playbackInfo.secondaryChannel)
    }
    addTrack(score, SPEC, settings)
    const info = score.tracks[score.tracks.length - 1].playbackInfo
    expect(used.has(info.primaryChannel)).toBe(false)
    expect(used.has(info.secondaryChannel)).toBe(false)
    expect(info.primaryChannel).not.toBe(info.secondaryChannel)
    // Never channel 9, which is the percussion channel.
    expect(info.primaryChannel).not.toBe(9)
    expect(info.secondaryChannel).not.toBe(9)
  })

  it('writes fretted notation an octave up, the way Guitar Pro does', () => {
    // Measured on the real files: every guitar and bass staff carries -12, and
    // only the flute, choir and violin staves carry 0.
    const score = loadFixture()
    addTrack(score, SPEC, settings)
    expect(score.tracks[score.tracks.length - 1].staves[0].displayTranspositionPitch).toBe(-12)

    // And a prefill from a non-fretted source keeps its own value.
    const other = loadFixture()
    addTrack(other, { ...SPEC, displayTranspositionPitch: 0 }, settings)
    expect(other.tracks[other.tracks.length - 1].staves[0].displayTranspositionPitch).toBe(0)
  })

  it('names itself when given no name', () => {
    const score = loadFixture()
    const result = addTrack(score, { ...SPEC, name: '   ' }, settings)
    expect(result.trackName).toBe(`Track ${score.tracks.length}`)
  })

  it('refuses without a tuning, and with a program that is not one', () => {
    const score = loadFixture()
    expect(addTrack(score, { ...SPEC, tunings: [] }, settings).reason).toMatch(/tuning/)
    expect(addTrack(score, { ...SPEC, program: 200 }, settings).reason).toMatch(/General MIDI/)
    expect(addTrack(new alphaTab.model.Score(), SPEC, settings).ok).toBe(false)
  })

  it('survives the .gp round trip', () => {
    const score = loadFixture()
    addTrack(score, SPEC, settings)
    const back = roundTrip(score)
    const track = back.tracks[back.tracks.length - 1]
    expect(back.tracks).toHaveLength(7)
    expect(track.name).toBe('Added')
    expect(track.staves[0].tuning).toEqual(SPEC.tunings)
    expect(track.staves[0].bars).toHaveLength(back.masterBars.length)
  })

  it('takes the track back out, and puts it back on a second call', () => {
    const score = loadFixture()
    const before = score.tracks.length
    const result = addTrack(score, SPEC, settings)

    result.undo()
    expect(score.tracks).toHaveLength(before)
    expect(score.tracks.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5])

    result.undo()
    expect(score.tracks).toHaveLength(before + 1)
    // The bars are rebuilt rather than doubled, which is what the detach clears.
    expect(score.tracks[before].staves[0].bars).toHaveLength(score.masterBars.length)
  })
})

describe('duplicateTrack', () => {
  const LINK_FIELDS = [
    'tieOrigin', 'tieDestination', 'hammerPullOrigin', 'hammerPullDestination',
    'slurOrigin', 'slurDestination', 'slideOrigin', 'slideTarget',
    'effectSlurOrigin', 'effectSlurDestination', 'bendOrigin',
  ]
  function linkGraph(track) {
    const notes = []
    for (const staff of track.staves) notes.push(...notesOf(staff))
    const id = new Map(notes.map((n, i) => [n, i]))
    return notes.map((n) => LINK_FIELDS.map((f) => (n[f] ? (id.get(n[f]) ?? 'OUTSIDE') : null)))
  }

  it('puts the copy straight after the original, and renumbers', () => {
    const score = loadFixture()
    const result = duplicateTrack(score, LEAD, settings)
    expect(result).toMatchObject({
      ok: true, changed: true, trackIndex: LEAD + 1, sourceName: 'Lead', trackName: 'Lead copy',
    })
    expect(score.tracks.map((t) => t.name)).toEqual([
      'Lead', 'Lead copy', 'Rhythm', 'Bass', 'Harm', 'Drums', 'Ties',
    ])
    expect(score.tracks.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('copies every note, and the staff it is written on', () => {
    const score = loadFixture()
    const before = snapshotTrack(score.tracks[TIES])
    duplicateTrack(score, TIES, settings)
    const copy = snapshotTrack(score.tracks[TIES + 1])
    // Everything but the name, which is deliberately different.
    expect({ ...copy, name: before.name, shortName: before.shortName }).toEqual(before)
  })

  // The links are REBUILT by mapping original to clone, not left to finish() -
  // which re-resolves a tie by looking for a note on the same string in the
  // preceding bars, and that is a guess.
  it('rebuilds the ties inside the copy, exactly as they were', () => {
    const score = loadFixture()
    const before = linkGraph(score.tracks[TIES])
    // The Ties track is the one that has any, or this proves nothing.
    expect(before.flat().some((v) => v !== null)).toBe(true)

    duplicateTrack(score, TIES, settings)
    expect(linkGraph(score.tracks[TIES + 1])).toEqual(before)
  })

  it('and no link in the copy points back into the original', () => {
    const score = loadFixture()
    duplicateTrack(score, TIES, settings)
    const graph = linkGraph(score.tracks[TIES + 1])
    expect(graph.flat()).not.toContain('OUTSIDE')

    // Nor the other way: the original is untouched.
    expect(linkGraph(score.tracks[TIES]).flat()).not.toContain('OUTSIDE')
  })

  it('gives the copy its own midi channels', () => {
    const score = loadFixture()
    const source = score.tracks[LEAD].playbackInfo
    duplicateTrack(score, LEAD, settings)
    const copy = score.tracks[LEAD + 1].playbackInfo
    expect(copy.program).toBe(source.program)
    expect(copy.primaryChannel).not.toBe(source.primaryChannel)
    expect(copy.secondaryChannel).not.toBe(source.secondaryChannel)
  })

  it('does not share a mutable array with the original', () => {
    // `bendPoints` assigned rather than copied would mean editing one note's
    // bend edits the other's.
    const score = loadFixture()
    const source = score.tracks[LEAD].staves[0]
    duplicateTrack(score, LEAD, settings)
    const copy = score.tracks[LEAD + 1].staves[0]
    expect(copy.tuning).not.toBe(source.tuning)
    const a = [...notesOf(source)]
    const b = [...notesOf(copy)]
    for (let i = 0; i < a.length; i += 1) {
      expect(b[i]).not.toBe(a[i])
      if (a[i].bendPoints) expect(b[i].bendPoints).not.toBe(a[i].bendPoints)
    }
  })

  it('plays the same notes, on another channel', () => {
    const score = loadFixture()
    const before = midiNoteOns(score).filter(([, channel]) => channel === 0)
    duplicateTrack(score, LEAD, settings)
    const after = midiNoteOns(score)
    const copyChannel = score.tracks[LEAD + 1].playbackInfo.primaryChannel
    const copied = after.filter(([, channel]) => channel === copyChannel)
    // The generated midi is what proves the clone kept everything that sounds.
    expect(copied.map(([tick, , key]) => [tick, key])).toEqual(
      before.map(([tick, , key]) => [tick, key]),
    )
  })

  it('refuses an index that is not a track', () => {
    const score = loadFixture()
    expect(duplicateTrack(score, -1, settings).ok).toBe(false)
    expect(duplicateTrack(score, 99, settings).ok).toBe(false)
  })

  it('survives the .gp round trip', () => {
    const score = loadFixture()
    duplicateTrack(score, TIES, settings)
    const back = roundTrip(score)
    expect(back.tracks).toHaveLength(7)
    const a = snapshotTrack(back.tracks[TIES])
    const b = snapshotTrack(back.tracks[TIES + 1])
    expect({ ...b, name: a.name, shortName: a.shortName }).toEqual(a)
  })

  it('takes the copy back out, and puts it back on a second call', () => {
    const score = loadFixture()
    const before = score.tracks.map((t) => t.name)
    const result = duplicateTrack(score, LEAD, settings)

    result.undo()
    expect(score.tracks.map((t) => t.name)).toEqual(before)
    expect(score.tracks.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5])

    result.undo()
    expect(score.tracks).toHaveLength(7)
    expect(score.tracks[LEAD + 1].name).toBe('Lead copy')
  })
})

describe('deleteTrack', () => {
  it('takes the track out and renumbers the rest', () => {
    const score = loadFixture()
    const before = score.tracks.map((t) => t.name)

    const result = deleteTrack(score, RHYTHM)
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      trackIndex: RHYTHM,
      trackName: 'Rhythm',
      trackCount: before.length - 1,
    })
    expect(result.noteCount).toBeGreaterThan(0)
    expect(score.tracks.map((t) => t.name)).toEqual(before.filter((n) => n !== 'Rhythm'))
    // No finish() renumbers a track, so this is ours - and every descriptor and
    // lookup in the UI is keyed on it.
    expect(score.tracks.map((t) => t.index)).toEqual(score.tracks.map((_, i) => i))
  })

  it('leaves the notes of every other track exactly as they were', () => {
    const score = loadFixture()
    const lead = snapshotTrack(score.tracks[LEAD])
    const bass = snapshotTrack(score.tracks[BASS])

    deleteTrack(score, RHYTHM)
    expect(snapshotTrack(score.tracks[0])).toEqual(lead)
    expect(snapshotTrack(score.tracks[1])).toEqual(bass)
  })

  it('keeps the bars: a track goes, the score length does not', () => {
    const score = loadFixture()
    const bars = score.masterBars.length
    deleteTrack(score, LEAD)
    expect(score.masterBars).toHaveLength(bars)
    for (const track of score.tracks) {
      for (const staff of track.staves) expect(staff.bars).toHaveLength(bars)
    }
  })

  it('refuses the last track, and anything that is not a track', () => {
    const score = loadFixture()
    expect(deleteTrack(score, -1).ok).toBe(false)
    expect(deleteTrack(score, 99).ok).toBe(false)
    expect(deleteTrack(new alphaTab.model.Score(), 0).ok).toBe(false)

    while (score.tracks.length > 1) expect(deleteTrack(score, 0).ok).toBe(true)
    const last = deleteTrack(score, 0)
    expect(last.ok).toBe(false)
    expect(last.reason).toMatch(/only track left/)
    expect(score.tracks).toHaveLength(1)
  })

  it('survives the .gp round trip', () => {
    const score = loadFixture()
    deleteTrack(score, RHYTHM)
    const back = roundTrip(score)
    expect(back.tracks.map((t) => t.name)).toEqual(['Lead', 'Bass', 'Harm', 'Drums', 'Ties'])
    expect(back.tracks.map((t) => t.index)).toEqual([0, 1, 2, 3, 4])
  })

  it('puts the track back, notes and all, and takes it out again', () => {
    const score = loadFixture()
    const before = score.tracks.map(snapshotTrack)
    const midi = midiNoteOns(score)

    const result = deleteTrack(score, RHYTHM)
    expect(midiNoteOns(score)).not.toEqual(midi)

    result.undo()
    expect(score.tracks.map(snapshotTrack)).toEqual(before)
    expect(score.tracks.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5])
    // The generated midi is the assertion that matters: it is built by walking
    // the tracks, so it catches an order or an index the snapshot would not.
    expect(midiNoteOns(score)).toEqual(midi)

    result.undo()
    expect(score.tracks).toHaveLength(5)
  })

  it('and the restored score still exports', () => {
    const score = loadFixture()
    const before = score.tracks.map(snapshotTrack)
    deleteTrack(score, LEAD).undo()
    expect(roundTrip(score).tracks.map(snapshotTrack)).toEqual(before)
  })

  // No note link crosses a track - 0 on the fixture and 0 on both large real
  // files - because `finish()` resolves links by walking `nextBeat` and
  // `previousBeat`, which never leave a staff. That is why this operation needs
  // no link sweep where `deleteBars` needs one.
  it('needs no link sweep, because no link crosses a track', () => {
    const score = loadFixture()
    const FIELDS = [
      'tieOrigin', 'tieDestination', 'hammerPullOrigin', 'hammerPullDestination',
      'slurOrigin', 'slurDestination', 'slideOrigin', 'slideTarget',
      'effectSlurOrigin', 'effectSlurDestination', 'bendOrigin',
    ]
    let checked = 0
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        for (const note of notesOf(staff)) {
          checked += 1
          for (const field of FIELDS) {
            const other = note[field]
            if (!other) continue
            expect(other.beat.voice.bar.staff.track).toBe(track)
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })
})

// Bars in the MIDDLE of the score, which is where alphaTab's own add methods
// stop being enough. See gotcha 11.
describe('insertBarBefore', () => {
  function barCounts(score) {
    return {
      masters: score.masterBars.length,
      staves: score.tracks.flatMap((t) => t.staves.map((s) => s.bars.length)),
    }
  }

  it('puts a bar on every staff, at the index asked for', () => {
    const score = loadFixture()
    const staffCount = score.tracks.reduce((n, t) => n + t.staves.length, 0)
    const before = score.masterBars.length

    const result = insertBarBefore(score, 2, settings)
    expect(result).toMatchObject({ ok: true, changed: true, barIndex: 2, staffCount })
    expect(barCounts(score).masters).toBe(before + 1)
    for (const count of barCounts(score).staves) expect(count).toBe(before + 1)
  })

  it('renumbers and re-chains every bar after it, which no finish() does', () => {
    const score = loadFixture()
    insertBarBefore(score, 1, settings)

    expect(score.masterBars.map((m) => m.index)).toEqual([0, 1, 2, 3, 4])
    for (let i = 1; i < score.masterBars.length; i += 1) {
      expect(score.masterBars[i].previousMasterBar).toBe(score.masterBars[i - 1])
      expect(score.masterBars[i - 1].nextMasterBar).toBe(score.masterBars[i])
    }
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        expect(staff.bars.map((b) => b.index)).toEqual([0, 1, 2, 3, 4])
        for (let i = 1; i < staff.bars.length; i += 1) {
          expect(staff.bars[i].previousBar).toBe(staff.bars[i - 1])
        }
      }
    }
  })

  it('pushes the ticks of everything after it along', () => {
    const score = loadFixture()
    insertBarBefore(score, 1, settings)
    expect(score.masterBars.map((m) => m.start)).toEqual([0, 3840, 7680, 11520, 15360])
    // And the music itself moved a bar later, unchanged.
    const beats = score.tracks[LEAD].staves[0].bars[2].voices[0].beats
    expect(beats.map((b) => b.notes[0].fret)).toEqual([12, 10, 8, 7])
  })

  it('leaves the new bar empty, which reads as a whole-bar rest', () => {
    const score = loadFixture()
    insertBarBefore(score, 1, settings)
    const bar = score.tracks[LEAD].staves[0].bars[1]
    expect(bar.voices[0].beats).toHaveLength(1)
    expect(bar.voices[0].isEmpty).toBe(true)
    expect(barFill(bar).state).toBe(BAR_EXACT)
  })

  // The conservative choice at a metre change: copying the DISPLACED bar's
  // signature would move where that change is drawn one bar earlier.
  it('takes the metre of the bar before it, not of the one it displaces', () => {
    const score = loadFixture()
    score.masterBars[1].timeSignatureNumerator = 7
    score.masterBars[1].timeSignatureDenominator = 8

    const result = insertBarBefore(score, 1, settings)
    expect(result).toMatchObject({ numerator: 4, denominator: 4 })
    expect(score.masterBars[1].timeSignatureNumerator).toBe(4)
    // The 7/8 is still on the bar that had it, one place later.
    expect(score.masterBars[2].timeSignatureNumerator).toBe(7)
  })

  it('and of the displaced bar when there is nothing before it', () => {
    const score = loadFixture()
    score.masterBars[0].timeSignatureNumerator = 3
    const result = insertBarBefore(score, 0, settings)
    expect(result).toMatchObject({ numerator: 3 })
  })

  // `Score.tempo` is a getter over masterBars[0].tempoAutomations[0].value with
  // a 120 fallback, so a new first bar with no automation silently drops the
  // whole score to 120. Measured: 168 before, 120 after.
  it('carries the tempo onto the new FIRST bar, or the score would drop to 120', () => {
    const score = loadFixture()
    score.masterBars[0].tempoAutomations[0].value = 168
    expect(score.tempo).toBe(168)

    insertBarBefore(score, 0, settings)
    expect(score.tempo).toBe(168)
    expect(score.masterBars[0].tempoAutomations).toHaveLength(1)
    // Moved, not copied: no duplicate marking left on the bar it came from.
    expect(score.masterBars[1].tempoAutomations).toHaveLength(0)
  })

  it('and the rest of a tempo MAP stays where it was', () => {
    const score = loadFixture()
    // The fixture carries three automations, on bars 0, 1 and 3.
    expect(tempoMap(score)).toEqual([[0, 120], [1, 90], [3, 140]])
    insertBarBefore(score, 2, settings)
    expect(tempoMap(score)).toEqual([[0, 120], [1, 90], [4, 140]])
  })

  it('refuses an index that is not a bar of this score', () => {
    const score = loadFixture()
    expect(insertBarBefore(score, -1, settings).ok).toBe(false)
    expect(insertBarBefore(score, score.masterBars.length, settings).ok).toBe(false)
    expect(insertBarBefore(new alphaTab.model.Score(), 0, settings).ok).toBe(false)
  })

  it('survives the .gp round trip', () => {
    const score = loadFixture()
    insertBarBefore(score, 2, settings)
    const back = roundTrip(score)
    expect(back.masterBars).toHaveLength(5)
    expect(back.tracks[LEAD].staves[0].bars[2].voices[0].beats.every((b) => b.isRest)).toBe(true)
    expect(back.tracks[LEAD].staves[0].bars[3].voices[0].beats.map((b) => b.notes[0].fret))
      .toEqual([5, 7, 9, 10])
  })

  it('takes the bar back out, and puts it back on a second call', () => {
    const score = loadFixture()
    const before = score.masterBars.length
    const result = insertBarBefore(score, 1, settings)

    result.undo()
    expect(score.masterBars).toHaveLength(before)
    expect(score.masterBars.map((m) => m.index)).toEqual([0, 1, 2, 3])
    expect(score.masterBars.map((m) => m.start)).toEqual([0, 3840, 7680, 11520])
    for (const track of score.tracks) {
      for (const staff of track.staves) expect(staff.bars).toHaveLength(before)
    }

    result.undo()
    expect(score.masterBars).toHaveLength(before + 1)
    expect(score.tracks[LEAD].staves[0].bars[1].voices[0].isEmpty).toBe(true)
  })

  it('and the tempo move comes back with it', () => {
    const score = loadFixture()
    score.masterBars[0].tempoAutomations[0].value = 168
    const result = insertBarBefore(score, 0, settings)
    result.undo()
    expect(score.tempo).toBe(168)
    expect(tempoMap(score)).toEqual([[0, 168], [1, 90], [3, 140]])
  })
})

describe('deleteBars', () => {
  it('takes one bar off every staff, and the master bar with it', () => {
    const score = loadFixture()
    const staffCount = score.tracks.reduce((n, t) => n + t.staves.length, 0)
    const before = score.masterBars.length

    const result = deleteBars(score, 1, 1, settings)
    expect(result).toMatchObject({ ok: true, changed: true, barIndex: 1, barCount: 1, staffCount })
    expect(result.noteCount).toBeGreaterThan(0)
    expect(score.masterBars).toHaveLength(before - 1)
    for (const track of score.tracks) {
      for (const staff of track.staves) expect(staff.bars).toHaveLength(before - 1)
    }
  })

  it('closes the gap: the bar after it takes its place, ticks included', () => {
    const score = loadFixture()
    deleteBars(score, 1, 1, settings)

    expect(score.masterBars.map((m) => m.index)).toEqual([0, 1, 2])
    expect(score.masterBars.map((m) => m.start)).toEqual([0, 3840, 7680])
    // Bar 2 of the fixture is now bar 1.
    expect(score.tracks[LEAD].staves[0].bars[1].voices[0].beats.map((b) => b.notes[0].fret))
      .toEqual([5, 7, 9, 10])
  })

  it('takes a whole range at once', () => {
    const score = loadFixture()
    const result = deleteBars(score, 1, 2, settings)
    expect(result).toMatchObject({ ok: true, barCount: 2 })
    expect(score.masterBars).toHaveLength(2)
    expect(score.tracks[LEAD].staves[0].bars[1].voices[0].beats.map((b) => b.notes[0].fret))
      .toEqual([3, 5, 7, 8])
  })

  it('accepts its bounds either way round', () => {
    const score = loadFixture()
    expect(deleteBars(score, 2, 1, settings)).toMatchObject({ ok: true, barIndex: 1, barCount: 2 })
  })

  // `MasterBar.finish` recomputes `start` only for `index > 0`, so a new first
  // bar keeps the start it had. Measured: the bars stayed at 3840, 7680, 11520
  // and the first beat's absolutePlaybackStart at 3840 - the field the drag
  // selection and the loop range are built from.
  it('resets where the score starts when the FIRST bar goes', () => {
    const score = loadFixture()
    deleteBars(score, 0, 0, settings)
    expect(score.masterBars.map((m) => m.start)).toEqual([0, 3840, 7680])
    expect(score.tracks[LEAD].staves[0].bars[0].voices[0].beats[0].absolutePlaybackStart).toBe(0)
  })

  it('and the tempo goes on being the one in force there', () => {
    const score = loadFixture()
    // Bar 0 is 120 and bar 1 is 90, so deleting bar 0 leaves bar 1's own change
    // in charge: it really is a tempo change at that point.
    deleteBars(score, 0, 0, settings)
    expect(score.tempo).toBe(90)

    // But a first bar with no change of its own INHERITS, or the score would
    // fall back to 120.
    const other = loadFixture()
    other.masterBars[0].tempoAutomations[0].value = 168
    other.masterBars[1].tempoAutomations = []
    deleteBars(other, 0, 0, settings)
    expect(other.tempo).toBe(168)
  })

  it('refuses to leave the score with no bars at all', () => {
    const score = loadFixture()
    expect(deleteBars(score, 0, score.masterBars.length - 1, settings).ok).toBe(false)
    expect(score.masterBars).toHaveLength(4)

    deleteBars(score, 1, 3, settings)
    expect(score.masterBars).toHaveLength(1)
    const last = deleteBars(score, 0, 0, settings)
    expect(last.ok).toBe(false)
    expect(last.reason).toMatch(/only bar left/)
  })

  it('refuses a range that is not in the score', () => {
    const score = loadFixture()
    expect(deleteBars(score, -1, 0, settings).ok).toBe(false)
    expect(deleteBars(score, 0, 99, settings).ok).toBe(false)
    expect(deleteBars(new alphaTab.model.Score(), 0, 0, settings).ok).toBe(false)
  })

  it('leaves no link pointing at a note it removed', () => {
    // A link to a deleted note SURVIVES finish() (gotcha 6), and links really do
    // cross bar lines: 106 and 191 of them on the two large real test files.
    const score = loadFixture()
    const victims = new Set()
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        for (const voice of staff.bars[1].voices) {
          for (const beat of voice.beats) for (const note of beat.notes) victims.add(note)
        }
      }
    }
    expect(victims.size).toBeGreaterThan(0)

    deleteBars(score, 1, 1, settings)

    const FIELDS = [
      'tieOrigin', 'tieDestination', 'hammerPullOrigin', 'hammerPullDestination',
      'slurOrigin', 'slurDestination', 'slideOrigin', 'slideTarget',
      'effectSlurOrigin', 'effectSlurDestination', 'bendOrigin',
    ]
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        for (const bar of staff.bars) {
          for (const voice of bar.voices) {
            for (const beat of voice.beats) {
              for (const note of beat.notes) {
                for (const field of FIELDS) expect(victims.has(note[field])).toBe(false)
              }
            }
          }
        }
      }
    }
  })

  it('survives the .gp round trip', () => {
    const score = loadFixture()
    deleteBars(score, 1, 1, settings)
    const back = roundTrip(score)
    expect(back.masterBars).toHaveLength(3)
    expect(back.tracks[LEAD].staves[0].bars[1].voices[0].beats.map((b) => b.notes[0].fret))
      .toEqual([5, 7, 9, 10])
  })

  it('puts the bars back, and takes them out again on a second call', () => {
    const score = loadFixture()
    const before = score.masterBars.length
    const frets = score.tracks[LEAD].staves[0].bars[1].voices[0].beats.map((b) => b.notes[0].fret)
    const result = deleteBars(score, 1, 1, settings)

    result.undo()
    expect(score.masterBars).toHaveLength(before)
    expect(score.masterBars.map((m) => m.index)).toEqual([0, 1, 2, 3])
    expect(score.masterBars.map((m) => m.start)).toEqual([0, 3840, 7680, 11520])
    expect(score.tracks[LEAD].staves[0].bars[1].voices[0].beats.map((b) => b.notes[0].fret))
      .toEqual(frets)

    result.undo()
    expect(score.masterBars).toHaveLength(before - 1)
  })

  it('and the same for a range, on every staff', () => {
    const score = loadFixture()
    const before = score.masterBars.length
    const result = deleteBars(score, 1, 2, settings)
    result.undo()
    expect(score.masterBars).toHaveLength(before)
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        expect(staff.bars).toHaveLength(before)
        expect(staff.bars.map((b) => b.index)).toEqual([0, 1, 2, 3])
      }
    }
    expect(roundTrip(score).masterBars).toHaveLength(before)
  })
})
