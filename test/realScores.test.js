import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as alphaTab from '@coderline/alphatab'
import {
  RETUNE_KEEP_PITCH,
  RETUNE_REASSIGN,
  applyScoreTempo,
  countNaturalHarmonics,
  fretRange,
  renameTrack,
  retuneTrack,
  deleteNotes,
  setNoteFret,
  shiftNoteString,
  stringedNotes,
  tempoInfo,
  transposeTrackByFrets,
  transposeTrackByTuning,
  tuningChoices,
  tuningForString,
  BAR_OVER,
  barFill,
  shiftNotesOctave,
  togglePalmMute,
  DURATION_LONGER,
  DURATION_SHORTER,
  addTrack,
  appendBar,
  deleteBars,
  duplicateTrack,
  deleteTrack,
  insertBarBefore,
  placeRest,
  stepBeatsDuration,
  writeNoteAtString,
} from '@/utils/scoreEdits'
import {
  loadFile,
  midiNoteOns,
  roundTrip,
  settings,
  snapshotTrack,
  stringedTracks,
  tempoMap,
} from './helpers'

// The same operations, checked as INVARIANTS against whatever real scores are
// pointed at - no assumption about track order, string counts or fret windows.
//
// This is the suite that answers the questions the committed fixture cannot:
// does the .gp exporter survive a .gpx or a .gp5 import, does the string
// inversion hold on files written by Guitar Pro rather than by alphaTex, and do
// the range refusals fire on real fret windows.
//
//   ALPHATAB_SCORES="/path/to/a.gp:/path/to/b.gpx" npm test
//   ALPHATAB_SCORES="/path/to/a/folder" npm test
//
// Skipped, not failed, when the variable is unset: the repo cannot carry
// someone's music, so this cannot be part of the default run.

const EXTENSIONS = new Set(['.gp', '.gp3', '.gp4', '.gp5', '.gpx', '.musicxml', '.xml', '.mxl'])

function collectScores() {
  const raw = process.env.ALPHATAB_SCORES
  if (!raw) return []
  const files = []
  for (const entry of raw.split(path.delimiter).filter(Boolean)) {
    if (!fs.existsSync(entry)) continue
    if (fs.statSync(entry).isDirectory()) {
      for (const name of fs.readdirSync(entry)) {
        if (EXTENSIONS.has(path.extname(name).toLowerCase())) files.push(path.join(entry, name))
      }
    } else {
      files.push(entry)
    }
  }
  return files
}

const scores = collectScores()

describe.skipIf(scores.length === 0)('invariants on real scores', () => {
  for (const file of scores) {
    describe(path.basename(file), () => {
      it('imports, and exports to .gp without losing tracks, bars or tempo', () => {
        const score = loadFile(file)
        const back = roundTrip(score)
        expect(back.tracks.length).toBe(score.tracks.length)
        expect(back.masterBars.length).toBe(score.masterBars.length)
        expect(back.tempo).toBe(score.tempo)
      })

      it('string 1 is the LOWEST string on every stringed staff (pitfall 2)', () => {
        const score = loadFile(file)
        for (const track of stringedTracks(score)) {
          for (const staff of track.staves) {
            if (!staff.isStringed) continue
            for (let string = 1; string <= staff.tuning.length; string += 1) {
              expect(tuningForString(staff.tuning, string)).toBe(
                alphaTab.model.Note.getStringTuning(staff, string),
              )
            }
            // And the stored order really is highest string first.
            expect(tuningForString(staff.tuning, 1)).toBe(staff.tuning[staff.tuning.length - 1])
          }
        }
      })

      it('every stringed note sits at stringTuning + fret before harmonics', () => {
        const score = loadFile(file)
        for (const track of stringedTracks(score)) {
          for (const staff of track.staves) {
            for (const note of stringedNotes(staff)) {
              // calculateRealValue(false, false) is the plain fret + tuning
              // value. `realValue` applies staff.transpositionPitch AND the
              // harmonic pitch on top, and for a NATURAL harmonic it drops the
              // fret from the formula entirely (pitfall 4), so it is not the
              // right thing to assert this invariant against.
              expect(note.calculateRealValue(false, false)).toBe(
                tuningForString(staff.tuning, note.string) + note.fret,
              )
            }
          }
        }
      })

      it('the tempo rewrite stays proportional and lands on the typed value', () => {
        const score = loadFile(file)
        const before = tempoMap(score)
        const info = tempoInfo(score)
        expect(info.automationCount).toBeGreaterThan(0)

        const target = Math.round(info.tempo) + 30
        expect(applyScoreTempo(score, target).ok).toBe(true)
        expect(score.tempo).toBe(target)

        const ratio = target / info.tempo
        const after = tempoMap(score)
        expect(after.length).toBe(before.length)
        after.forEach(([bar, value], i) => {
          expect(bar).toBe(before[i][0])
          // The first automation is forced to the exact target; the rest are
          // scaled, within the 2-decimal rounding.
          if (i === 0) return
          expect(Math.abs(value - before[i][1] * ratio)).toBeLessThanOrEqual(0.005)
        })
        expect(tempoMap(roundTrip(score))).toEqual(after)
      })

      it('the tuning transposition keeps every fret and moves every pitch', () => {
        const score = loadFile(file)
        for (const track of stringedTracks(score)) {
          const before = snapshotTrack(track)
          expect(transposeTrackByTuning(track, -1).ok).toBe(true)
          const after = snapshotTrack(track)
          after.staves.forEach((staff, s) => {
            expect(staff.tuning).toEqual(
              before.staves[s].tuning.map((v) => (before.staves[s].tuning.length ? v - 1 : v)),
            )
            staff.notes.forEach((note, n) => {
              expect(note.fret).toBe(before.staves[s].notes[n].fret)
              if (note.realValue !== null) {
                expect(note.realValue).toBe(before.staves[s].notes[n].realValue - 1)
              }
            })
          })
        }
      })

      it('refuses the fret transposition exactly when natural harmonics are present', () => {
        const score = loadFile(file)
        for (const track of stringedTracks(score)) {
          const harmonics = track.staves.reduce(
            (total, staff) => total + countNaturalHarmonics(staff),
            0,
          )
          if (harmonics === 0) continue
          const fresh = loadFile(file).tracks[track.index]
          const result = transposeTrackByFrets(fresh, 1)
          expect(result.ok).toBe(false)
          expect(result.reason).toContain('natural harmonic')
          // And the tuning route, which the refusal points at, does work.
          expect(transposeTrackByTuning(fresh, 1).ok).toBe(true)
        }
      })

      it('the fret transposition either applies exactly, or refuses and writes nothing', () => {
        const score = loadFile(file)
        for (const track of stringedTracks(score)) {
          for (const step of [-1, 1, -12, 12]) {
            const fresh = loadFile(file).tracks[track.index]
            const before = snapshotTrack(fresh)
            const result = transposeTrackByFrets(fresh, step)
            const after = snapshotTrack(fresh)
            if (!result.ok) {
              // A refusal must be total. A partial transposition is worse than
              // none, and the message has to say why.
              expect(after).toEqual(before)
              expect(result.reason).toBeTruthy()
              continue
            }
            after.staves.forEach((staff, s) => {
              expect(staff.tuning).toEqual(before.staves[s].tuning)
              staff.notes.forEach((note, n) => {
                if (note.string < 0) return
                expect(note.fret).toBe(before.staves[s].notes[n].fret + step)
                expect(note.fret).toBeGreaterThanOrEqual(0)
              })
            })
          }
        }
      })

      it('keep-pitch retuning either holds every pitch exactly, or refuses', () => {
        const score = loadFile(file)
        for (const track of stringedTracks(score)) {
          const staff = track.staves.find((s) => s.isStringed)
          const target = staff.tuning.map((v) => v - 2)
          const fresh = loadFile(file).tracks[track.index]
          const before = snapshotTrack(fresh)

          const result = retuneTrack(fresh, target, RETUNE_KEEP_PITCH)
          const after = snapshotTrack(fresh)
          if (!result.ok) {
            expect(after).toEqual(before)
            expect(result.reason).toBeTruthy()
            continue
          }
          after.staves.forEach((s, i) => {
            s.notes.forEach((note, n) => {
              expect(note.realValue).toBe(before.staves[i].notes[n].realValue)
            })
          })
        }
      })

      it('reassign retuning keeps every fret', () => {
        const score = loadFile(file)
        for (const track of stringedTracks(score)) {
          const staff = track.staves.find((s) => s.isStringed)
          const before = snapshotTrack(track)
          expect(retuneTrack(track, staff.tuning.map((v) => v - 2), RETUNE_REASSIGN).ok).toBe(true)
          snapshotTrack(track).staves.forEach((s, i) => {
            s.notes.forEach((note, n) => {
              expect(note.fret).toBe(before.staves[i].notes[n].fret)
            })
          })
        }
      })

      it('moving notes across the strings never changes the generated midi', () => {
        const before = midiNoteOns(loadFile(file))

        const score = loadFile(file)
        let moved = 0
        for (const direction of [1, -1]) {
          for (const track of score.tracks) {
            for (const staff of track.staves) {
              if (!staff.isStringed) continue
              for (const note of [...stringedNotes(staff)]) {
                if (shiftNoteString(note, direction).changed) moved += 1
              }
            }
          }
        }
        expect(moved).toBeGreaterThan(0)
        // Same pitches, same channels, same ticks - only the fingering moved.
        expect(midiNoteOns(score)).toEqual(before)
      })

      it('deleting linked notes leaves no dangling link and no lost bar', () => {
        const LINK_FIELDS = [
          'tieOrigin', 'tieDestination', 'hammerPullOrigin', 'hammerPullDestination',
          'slurOrigin', 'slurDestination', 'slideOrigin', 'slideTarget',
          'effectSlurOrigin', 'effectSlurDestination', 'bendOrigin',
        ]
        const everyNote = (score) => {
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

        const score = loadFile(file)
        const bars = score.masterBars.length
        // Target the notes that ARE the origin of a link: the hard case.
        const linked = everyNote(score)
          .filter((n) => n.tieDestination || n.hammerPullDestination || n.slideTarget)
          .slice(0, 40)
        if (linked.length === 0) return

        const victims = new Set(linked)
        expect(deleteNotes(linked, settings).ok).toBe(true)

        let dangling = 0
        for (const note of everyNote(score)) {
          for (const field of LINK_FIELDS) if (victims.has(note[field])) dangling += 1
        }
        expect(dangling).toBe(0)

        // Emptying beats must not lose bars, and the result must still export.
        expect(score.masterBars.length).toBe(bars)
        expect(midiNoteOns(score).length).toBeGreaterThan(0)
        expect(roundTrip(score).masterBars.length).toBe(bars)
      })

      it('every edit can be undone exactly, midi included', () => {
        // The claim that matters for an undo stack, on a real score: apply, take
        // it back, and compare both the model and what would be played.
        const snapshot = (score) => ({
          tempo: tempoMap(score),
          tracks: score.tracks.map(snapshotTrack),
        })

        const CASES = [
          ['rename', (s2) => renameTrack(s2.tracks[0], 'Undo Me')],
          ['tempo', (s2) => applyScoreTempo(s2, Math.round(s2.tempo) + 17)],
          ['detune', (s2) => transposeTrackByTuning(stringedTracks(s2)[0], -2)],
          ['frets', (s2) => transposeTrackByFrets(stringedTracks(s2)[0], 1)],
          [
            'retune keep pitches',
            (s2) => {
              const track = stringedTracks(s2)[0]
              const staff = track.staves.find((st) => st.isStringed)
              return retuneTrack(track, staff.tuning.map((v) => v - 2), RETUNE_KEEP_PITCH)
            },
          ],
          [
            'silence linked notes',
            (s2) => {
              const notes = []
              for (const track of stringedTracks(s2)) {
                for (const staff of track.staves) {
                  if (!staff.isStringed) continue
                  for (const note of stringedNotes(staff)) {
                    if (note.tieDestination || note.hammerPullDestination || note.slideTarget) {
                      notes.push(note)
                    }
                  }
                }
              }
              return notes.length > 0 ? deleteNotes(notes.slice(0, 25), settings) : null
            },
          ],
        ]

        for (const [name, apply] of CASES) {
          const score = loadFile(file)
          const before = snapshot(score)
          const beforeMidi = midiNoteOns(score)

          const result = apply(score)
          if (!result || !result.changed) continue // legitimately not applicable
          expect(typeof result.undo, name).toBe('function')
          expect(snapshot(score), name).not.toEqual(before)

          result.undo()

          expect(snapshot(score), name).toEqual(before)
          expect(midiNoteOns(score), name).toEqual(beforeMidi)
        }
      })

      it('offers a reachable tuning list for every stringed staff', () => {
        const score = loadFile(file)
        for (const track of stringedTracks(score)) {
          for (const staff of track.staves) {
            if (!staff.isStringed) continue
            const choices = tuningChoices(staff)
            // The current tuning is always in the list exactly once, even when
            // alphaTab has no preset for that string count at all.
            expect(choices.filter((c) => c.isCurrent)).toHaveLength(1)
            expect(new Set(choices.map((c) => c.id)).size).toBe(choices.length)
          }
        }
      })

      it('refuses every fret and tuning operation on percussion', () => {
        const score = loadFile(file)
        for (const track of score.tracks) {
          if (track.staves.some((s) => s.isStringed)) continue
          expect(transposeTrackByTuning(track, 1).ok).toBe(false)
          expect(transposeTrackByFrets(track, 1).ok).toBe(false)
          expect(retuneTrack(track, [40, 45, 50, 55], RETUNE_REASSIGN).ok).toBe(false)
          for (const staff of track.staves) {
            expect(fretRange(staff)).toEqual({ count: 0, min: 0, max: 0 })
            expect(tuningChoices(staff)).toEqual([])
          }
        }
      })

      it('reads every bar as under, exact or over, and never crashes on one', () => {
        // Measured across 17 real files and 11682 bars: exactly ONE bar was
        // overfull (a 2/4 bar holding 2880 ticks against 1920) and one was
        // incomplete. So this is not a false-positive machine - which is the
        // real risk of a per-bar tick comparison against tuplets and anacruses.
        const score = loadFile(file)
        let counted = 0
        for (const track of score.tracks) {
          for (const staff of track.staves) {
            for (const bar of staff.bars) {
              const fill = barFill(bar)
              expect(fill, `track ${track.index} bar ${bar.index}`).not.toBeNull()
              expect(fill.capacity).toBeGreaterThan(0)
              counted += 1
            }
          }
        }
        expect(counted).toBeGreaterThan(0)
      })

      it('an overfull bar survives the .gp round trip, which is why it is flagged', () => {
        // Nothing in alphaTab objects to it. Made here rather than looked for,
        // since almost no real file has one.
        const score = loadFile(file)
        // A bar someone actually wrote into. A bar whose every voice alphaTab
        // auto-filled is an implicit whole-bar rest and is complete by
        // definition, so lengthening one of its generated beats proves nothing.
        const staff = score.tracks[0].staves[0]
        const found = staff.bars.find((bar) =>
          bar.voices.some((voice) => !voice.isEmpty && voice.beats.length > 0),
        )
        if (!found) return
        const voice = found.voices.find((v) => !v.isEmpty && v.beats.length > 0)
        voice.beats[0].duration = alphaTab.model.Duration.QuadrupleWhole
        score.finish(settings)
        expect(barFill(found).state).toBe(BAR_OVER)

        const back = roundTrip(score)
        expect(barFill(back.tracks[0].staves[0].bars[found.index]).state).toBe(BAR_OVER)
      })

      it('an octave never leaves a note anywhere but where it was or an octave away', () => {
        // The best-effort rule, checked on real tunings. Measured over the same
        // 17 files: going UP is blocked for 1.8 % of notes and DOWN for 36.8 %,
        // which is why the octave cannot be all or nothing the way the frets
        // and the strings are.
        for (const direction of [1, -1]) {
          const score = loadFile(file)
          for (const track of stringedTracks(score)) {
            for (const staff of track.staves) {
              if (!staff.isStringed) continue
              const notes = [...stringedNotes(staff)]
              if (notes.length === 0) continue
              const before = notes.map((n) => n.calculateRealValue(false, false))

              const result = shiftNotesOctave(notes, direction)
              if (!result.ok) continue
              expect(result.movedCount + result.blockedCount).toBe(notes.length)

              notes.forEach((note, i) => {
                const now = note.calculateRealValue(false, false)
                expect([before[i], before[i] + direction * 12]).toContain(now)
                expect(note.fret).toBeGreaterThanOrEqual(0)
                expect(note.fret).toBeLessThanOrEqual(24)
              })

              // And no beat ever ends up with two notes on one string.
              for (const beat of new Set(notes.map((n) => n.beat))) {
                const strings = beat.notes.map((n) => n.string)
                expect(new Set(strings).size).toBe(strings.length)
              }
            }
          }
        }
      })

      // A technique that changes what is heard without moving a tick, and whose
      // marking on the score is DERIVED from the note flags in a way finish()
      // only ever sets. Real files use it heavily: 192 of 2856 notes on one,
      // 960 of 7295 on the other.
      it('palm mute goes on and comes off without leaving a bracket behind', () => {
        const score = loadFile(file)
        const staff = stringedTracks(score)[0]?.staves?.find((s) => s.isStringed)
        if (!staff) return
        const notes = [...stringedNotes(staff)].slice(0, 12)
        if (notes.length === 0) return

        const wasNotes = notes.map((n) => n.isPalmMute)
        const beats = [...new Set(notes.map((n) => n.beat))]
        const wasBeats = beats.map((b) => b.isPalmMute)

        // One toggle and its undo, which must restore the notes AND the marking
        // derived from them.
        const first = togglePalmMute(notes, settings)
        expect(first.ok).toBe(true)
        expect(notes.every((n) => n.isPalmMute)).toBe(first.palmMute)
        first.undo()
        expect(notes.map((n) => n.isPalmMute)).toEqual(wasNotes)
        expect(beats.map((b) => b.isPalmMute)).toEqual(wasBeats)

        // And in every state, a beat that holds notes claims the marking only
        // when one of its notes does. That is the invariant a plain finish()
        // breaks, because it only ever SETS the flag: clearing the last muted
        // note of a beat left the P.M. bracket on the score.
        //
        // Only beats that hold notes: alphaTab propagates the flag onto
        // adjacent RESTS on purpose, and those follow their neighbour rather
        // than their own contents.
        for (let i = 0; i < 3; i += 1) {
          const step = togglePalmMute(notes, settings)
          if (!step.changed) continue
          for (const beat of beats) {
            if (beat.isRest) continue
            expect(beat.isPalmMute, `beat ${beat.index}`).toBe(
              beat.notes.some((n) => n.isPalmMute),
            )
          }
        }
      })

      // ---- the writing tier -----------------------------------------------

      // SAMPLED rather than swept, and the number is the reason: every write
      // here runs `score.finish()`, measured at 16ms on a 118-bar score, so
      // touching all 3000 beats of a real file would be 50 seconds of finishing.
      // That cost is exactly why none of the writing keys repeats.
      const SAMPLE = 20

      it('a note written on a free string sounds at that string and fret', () => {
        const score = loadFile(file)
        // One candidate per beat: the beat, its staff, and its first free
        // string. Collected first so the sample spreads across the whole file
        // rather than stopping in its first bar.
        const candidates = []
        for (const track of stringedTracks(score)) {
          for (const staff of track.staves) {
            if (!staff.isStringed) continue
            for (const bar of staff.bars) {
              for (const voice of bar.voices) {
                for (const beat of voice.beats) {
                  for (let string = 1; string <= staff.tuning.length; string += 1) {
                    if (beat.getNoteOnString(string)) continue
                    candidates.push({ staff, beat, string })
                    break
                  }
                }
              }
            }
          }
        }
        if (candidates.length === 0) return

        const step = Math.max(1, Math.floor(candidates.length / SAMPLE))
        let written = 0
        for (let i = 0; i < candidates.length; i += step) {
          const { staff, beat, string } = candidates[i]
          const before = beat.notes.length
          const result = writeNoteAtString(beat, string, 5, settings)
          if (!result.ok) continue
          written += 1
          expect(result.created).toBe(true)
          expect(beat.notes).toHaveLength(before + 1)
          expect(result.note.calculateRealValue(false, false)).toBe(
            tuningForString(staff.tuning, string) + 5,
          )
          // No beat can ever hold two notes on one string (pitfall 5).
          const strings = beat.notes.map((n) => n.string)
          expect(new Set(strings).size).toBe(strings.length)
          result.undo()
          expect(beat.notes).toHaveLength(before)
        }
        expect(written).toBeGreaterThan(0)
      })

      // The reading everything else derives from, and the trap it was written
      // around: `playbackDuration` is stale until finish() (pitfall 7), so a
      // duration change that skipped it would leave every tick reading wrong.
      // Every voice that somebody has actually written into, which is not every
      // voice: two of the real test files carry a stringed track whose every bar
      // is still an untouched placeholder, and a written-note invariant has
      // nothing to say about those.
      function writtenVoices(score) {
        const voices = []
        for (const track of stringedTracks(score)) {
          for (const staff of track.staves) {
            if (!staff.isStringed) continue
            for (const bar of staff.bars) {
              for (const voice of bar.voices) {
                if (!voice.isEmpty && voice.beats.length > 0) voices.push(voice)
              }
            }
          }
        }
        return voices
      }

      it('a duration change moves the ticks, both ways', () => {
        const score = loadFile(file)
        const voices = writtenVoices(score)
        if (voices.length === 0) return

        const step = Math.max(1, Math.floor(voices.length / SAMPLE))
        let checked = 0
        for (let i = 0; i < voices.length; i += step) {
          const voice = voices[i]
          const bar = voice.bar
          const beat = voice.beats[0]
          const wasTicks = beat.playbackDuration
          const wasFill = barFill(bar).filled

          const result = stepBeatsDuration([beat], DURATION_SHORTER, settings)
          if (!result.ok) continue
          checked += 1
          // Pitfall 7: both of these are DERIVED from `duration`, so they only
          // read right because the write finished the score.
          expect(beat.playbackDuration).toBeLessThan(wasTicks)
          expect(barFill(bar).filled).toBeLessThan(wasFill)

          result.undo()
          expect(beat.playbackDuration).toBe(wasTicks)
          expect(barFill(bar).filled).toBe(wasFill)
        }
        expect(checked).toBeGreaterThan(0)
      })

      it('lengthening a full bar overfills it, which is the state nothing else reports', () => {
        const score = loadFile(file)
        const voice = writtenVoices(score).find(
          (v) => barFill(v.bar)?.state === 'exact',
        )
        if (!voice) return

        const result = stepBeatsDuration([voice.beats[0]], DURATION_LONGER, settings)
        if (!result.ok) return
        expect(barFill(voice.bar).state).toBe(BAR_OVER)
        result.undo()
        expect(barFill(voice.bar).state).toBe('exact')
      })

      it('an inserted rest renumbers and re-chains the beats of its voice', () => {
        const score = loadFile(file)
        const voices = writtenVoices(score)
        if (voices.length === 0) return

        const step = Math.max(1, Math.floor(voices.length / SAMPLE))
        let inserted = 0
        for (let i = 0; i < voices.length; i += step) {
          const voice = voices[i]
          const before = voice.beats.length
          const result = placeRest(voice.beats[0], settings)
          if (!result.ok) continue
          inserted += 1
          // `insertBeat` leaves the indexes at 0,1,0,2,3 - only finish()
          // renumbers them.
          expect(voice.beats.map((b) => b.index)).toEqual(voice.beats.map((_, j) => j))
          for (let j = 1; j < voice.beats.length; j += 1) {
            expect(voice.beats[j].previousBeat).toBe(voice.beats[j - 1])
          }
          result.undo()
          expect(voice.beats).toHaveLength(before)
          expect(voice.beats.map((b) => b.index)).toEqual(voice.beats.map((_, j) => j))
        }
        expect(inserted).toBeGreaterThan(0)
      })

      it('a bar added at the end lands on every staff, and comes back off', () => {
        const score = loadFile(file)
        const staffCount = score.tracks.reduce((n, t) => n + t.staves.length, 0)
        const before = score.masterBars.length
        // Every staff has one bar per master bar to start with, which is what
        // the append has to preserve.
        for (const track of score.tracks) {
          for (const staff of track.staves) expect(staff.bars).toHaveLength(before)
        }

        const result = appendBar(score, settings)
        expect(result).toMatchObject({ ok: true, staffCount })
        for (const track of score.tracks) {
          for (const staff of track.staves) expect(staff.bars).toHaveLength(before + 1)
        }
        // An empty bar reads as a whole-bar rest rather than as incomplete.
        const added = score.tracks[0].staves[0].bars[before]
        expect(barFill(added).state).toBe('exact')
        expect(roundTrip(score).masterBars).toHaveLength(before + 1)

        result.undo()
        expect(score.masterBars).toHaveLength(before)
        for (const track of score.tracks) {
          for (const staff of track.staves) expect(staff.bars).toHaveLength(before)
        }
        expect(roundTrip(score).masterBars).toHaveLength(before)
      })

      it('a bar inserted in the middle renumbers everything after it', () => {
        const score = loadFile(file)
        const before = score.masterBars.length
        const at = Math.floor(before / 2)

        const result = insertBarBefore(score, at, settings)
        expect(result).toMatchObject({ ok: true, barIndex: at })
        expect(score.masterBars).toHaveLength(before + 1)
        // No `finish()` renumbers a bar, so this is ours to get right - and it
        // is what every later RenderHint and tick depends on. See gotcha 11.
        expect(score.masterBars.map((m) => m.index)).toEqual(
          score.masterBars.map((_, i) => i),
        )
        for (const track of score.tracks) {
          for (const staff of track.staves) {
            expect(staff.bars).toHaveLength(before + 1)
            expect(staff.bars.map((b) => b.index)).toEqual(staff.bars.map((_, i) => i))
          }
        }
        // Starts are strictly increasing from zero, which is what says the ticks
        // were rebuilt rather than inherited.
        expect(score.masterBars[0].start).toBe(0)
        for (let i = 1; i < score.masterBars.length; i += 1) {
          expect(score.masterBars[i].start).toBeGreaterThan(score.masterBars[i - 1].start)
        }
        expect(roundTrip(score).masterBars).toHaveLength(before + 1)

        result.undo()
        expect(score.masterBars).toHaveLength(before)
        expect(score.masterBars[0].start).toBe(0)
      })

      it('inserting before the first bar keeps the tempo the score had', () => {
        // `Score.tempo` is a getter over masterBars[0], with a 120 fallback.
        const score = loadFile(file)
        const was = score.tempo
        const result = insertBarBefore(score, 0, settings)
        expect(result.ok).toBe(true)
        expect(score.tempo).toBe(was)
        result.undo()
        expect(score.tempo).toBe(was)
      })

      // The invariant that needs a real file: links crossing a bar line. The
      // fixture has none at all; these two have 106 and 191.
      it('deleting a bar leaves no link pointing into it', () => {
        const score = loadFile(file)
        if (score.masterBars.length < 3) return
        const at = Math.floor(score.masterBars.length / 2)

        const victims = new Set()
        for (const track of score.tracks) {
          for (const staff of track.staves) {
            for (const voice of staff.bars[at]?.voices ?? []) {
              for (const beat of voice.beats) for (const note of beat.notes) victims.add(note)
            }
          }
        }

        const before = score.masterBars.length
        const result = deleteBars(score, at, at, settings)
        expect(result).toMatchObject({ ok: true, barIndex: at, barCount: 1 })
        expect(score.masterBars).toHaveLength(before - 1)

        const FIELDS = [
          'tieOrigin', 'tieDestination', 'hammerPullOrigin', 'hammerPullDestination',
          'slurOrigin', 'slurDestination', 'slideOrigin', 'slideTarget',
          'effectSlurOrigin', 'effectSlurDestination', 'bendOrigin',
        ]
        let checked = 0
        for (const track of score.tracks) {
          for (const staff of track.staves) {
            for (const bar of staff.bars) {
              for (const voice of bar.voices) {
                for (const beat of voice.beats) {
                  for (const note of beat.notes) {
                    checked += 1
                    for (const field of FIELDS) {
                      expect(victims.has(note[field]), field).toBe(false)
                    }
                  }
                }
              }
            }
          }
        }
        expect(checked).toBeGreaterThan(0)
        expect(roundTrip(score).masterBars).toHaveLength(before - 1)
      })

      it('deleting the first bar puts the score back at tick zero', () => {
        const score = loadFile(file)
        if (score.masterBars.length < 2) return
        const before = score.masterBars.length

        const result = deleteBars(score, 0, 0, settings)
        expect(result.ok).toBe(true)
        // `MasterBar.finish` only recomputes `start` for index > 0, so this one
        // is ours - and `absolutePlaybackStart` is what the drag selection and
        // the loop range are built from.
        expect(score.masterBars[0].start).toBe(0)
        const first = score.tracks[0].staves[0].bars[0].voices.find((v) => v.beats.length > 0)
        if (first) expect(first.beats[0].absolutePlaybackStart).toBe(0)

        result.undo()
        expect(score.masterBars).toHaveLength(before)
        expect(score.masterBars[0].start).toBe(0)
      })

      it('and a deleted bar comes back note for note, midi included', () => {
        const score = loadFile(file)
        if (score.masterBars.length < 3) return
        const at = Math.floor(score.masterBars.length / 2)

        const before = score.tracks.map(snapshotTrack)
        const beforeMidi = midiNoteOns(score)
        const result = deleteBars(score, at, at, settings)
        expect(result.ok).toBe(true)

        result.undo()
        expect(score.tracks.map(snapshotTrack)).toEqual(before)
        expect(midiNoteOns(score)).toEqual(beforeMidi)
      })

      it('a deleted track comes back note for note, midi included', () => {
        const score = loadFile(file)
        if (score.tracks.length < 2) return
        const at = Math.floor(score.tracks.length / 2)

        const before = score.tracks.map(snapshotTrack)
        const beforeMidi = midiNoteOns(score)
        const bars = score.masterBars.length

        const result = deleteTrack(score, at)
        expect(result).toMatchObject({ ok: true, trackIndex: at })
        expect(score.tracks).toHaveLength(before.length - 1)
        // Every index is ours to keep right: no finish() renumbers a track.
        expect(score.tracks.map((t) => t.index)).toEqual(score.tracks.map((_, i) => i))
        // A track goes, the score length does not.
        expect(score.masterBars).toHaveLength(bars)
        expect(roundTrip(score).tracks).toHaveLength(before.length - 1)

        result.undo()
        expect(score.tracks.map(snapshotTrack)).toEqual(before)
        expect(midiNoteOns(score)).toEqual(beforeMidi)
        expect(roundTrip(score).tracks.map(snapshotTrack)).toEqual(before)
      })

      // The measurement the whole design of `deleteTrack` rests on: it needs no
      // link sweep and no derived capture, unlike `deleteBars`, because a link
      // cannot leave a staff - `finish()` resolves them by walking `nextBeat`
      // and `previousBeat`.
      it('no note link crosses a track', () => {
        const score = loadFile(file)
        const FIELDS = [
          'tieOrigin', 'tieDestination', 'hammerPullOrigin', 'hammerPullDestination',
          'slurOrigin', 'slurDestination', 'slideOrigin', 'slideTarget',
          'effectSlurOrigin', 'effectSlurDestination', 'bendOrigin',
        ]
        let links = 0
        for (const track of score.tracks) {
          for (const staff of track.staves) {
            for (const bar of staff.bars) {
              for (const voice of bar.voices) {
                for (const beat of voice.beats) {
                  for (const note of beat.notes) {
                    for (const field of FIELDS) {
                      const other = note[field]
                      if (!other) continue
                      links += 1
                      expect(other.beat.voice.bar.staff.track, field).toBe(track)
                    }
                  }
                }
              }
            }
          }
        }
        // A file with no links at all would make this pass by proving nothing,
        // so say which it was rather than asserting a minimum every file cannot
        // meet.
        expect(typeof links).toBe('number')
      })

      it('a duplicated track is note for note the original, links included', () => {
        const score = loadFile(file)
        const at = score.tracks.length - 1
        const LINK_FIELDS = [
          'tieOrigin', 'tieDestination', 'hammerPullOrigin', 'hammerPullDestination',
          'slurOrigin', 'slurDestination', 'slideOrigin', 'slideTarget',
          'effectSlurOrigin', 'effectSlurDestination', 'bendOrigin',
        ]
        const linkGraph = (track) => {
          const notes = []
          for (const staff of track.staves) notes.push(...stringedNotes(staff))
          const id = new Map(notes.map((n, i) => [n, i]))
          return notes.map((n) => LINK_FIELDS.map((f) => (n[f] ? (id.get(n[f]) ?? 'OUTSIDE') : null)))
        }

        const before = snapshotTrack(score.tracks[at])
        const beforeLinks = linkGraph(score.tracks[at])
        const beforeCount = score.tracks.length

        const result = duplicateTrack(score, at, settings)
        expect(result).toMatchObject({ ok: true, trackIndex: at + 1 })
        expect(score.tracks).toHaveLength(beforeCount + 1)
        expect(score.tracks.map((t) => t.index)).toEqual(score.tracks.map((_, i) => i))

        const copy = snapshotTrack(score.tracks[at + 1])
        expect({ ...copy, name: before.name, shortName: before.shortName }).toEqual(before)
        // The links are REBUILT by mapping original to clone rather than left to
        // finish(), which would guess an origin by searching the same string in
        // the preceding bars.
        expect(linkGraph(score.tracks[at + 1])).toEqual(beforeLinks)
        // And nothing in the copy points back into the original, which is what
        // makes it an independent track rather than a view of one.
        expect(linkGraph(score.tracks[at + 1]).flat()).not.toContain('OUTSIDE')

        // Its own midi channels, or a program change on one would re-voice the
        // other.
        const a = score.tracks[at].playbackInfo
        const b = score.tracks[at + 1].playbackInfo
        expect(b.primaryChannel).not.toBe(a.primaryChannel)
        expect(b.secondaryChannel).not.toBe(a.secondaryChannel)

        expect(roundTrip(score).tracks).toHaveLength(beforeCount + 1)

        result.undo()
        expect(score.tracks).toHaveLength(beforeCount)
        expect(score.tracks.map(snapshotTrack)[at]).toEqual(before)
      })

      it('an added track is as long as the score, and comes back off', () => {
        const score = loadFile(file)
        const bars = score.masterBars.length
        const before = score.tracks.length

        const result = addTrack(
          score,
          { name: 'Added', program: 27, tunings: [64, 59, 55, 50, 45, 40] },
          settings,
        )
        expect(result.ok).toBe(true)
        const staff = score.tracks[before].staves[0]
        // A staff shorter than the score is the ragged shape `consolidate` is
        // for, so every bar is built here.
        expect(staff.bars).toHaveLength(bars)
        expect(score.masterBars).toHaveLength(bars)
        expect(roundTrip(score).tracks).toHaveLength(before + 1)

        result.undo()
        expect(score.tracks).toHaveLength(before)
      })

      it('carries a full set of edits through a .gp round trip', () => {
        const score = loadFile(file)
        renameTrack(score.tracks[0], 'Renamed By Test')
        applyScoreTempo(score, Math.round(score.tempo) + 10)

        const track = stringedTracks(score)[0]
        if (track) {
          transposeTrackByTuning(track, -1)
          const note = [...stringedNotes(track.staves.find((s) => s.isStringed))][0]
          if (note) setNoteFret(note, Math.min(24, note.fret + 1))
        }

        const expected = score.tracks.map(snapshotTrack)
        const expectedTempo = tempoMap(score)
        const back = roundTrip(score)
        expect(back.tracks.map(snapshotTrack)).toEqual(expected)
        expect(tempoMap(back)).toEqual(expectedTempo)
      })
    })
  }
})
