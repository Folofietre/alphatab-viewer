import * as alphaTab from '@coderline/alphatab'

// Every model write behind the editing features, as pure named functions.
//
// The rule this file exists to enforce: no component ever writes into the
// alphaTab model. A component calls one of these, gets a result back, and lets
// `useScoreEdit` decide what has to be re-rendered or re-generated. That is
// also what keeps an undo stack possible later without touching the UI: each
// function here is already a command, it would only need its inverse. A stack
// of score snapshots is not an option - `JsonConverter` on an 85-bar score
// costs 108ms and 4.4MB, so 100 undo levels would be ~433MB.
//
// Three pitfalls, all verified in Node against alphaTab 1.8.4 rather than read
// from the docs. They are the reason this module exists at all.
//
// 1. `score.tempo` is READ-ONLY. Assigning to it throws
//    `TypeError: Cannot set property tempo of #<Score> which has only a getter`.
//    The getter returns `masterBars[0].tempoAutomations[0].value`, falling back
//    to 120. The tempo really lives in `masterBar.tempoAutomations`, and a
//    score can carry many: a .gpx test file held five, two of them in the same
//    bar. See `applyScoreTempo`.
//
// 2. String numbering is INVERTED relative to storage. `staff.tuning` is stored
//    highest string first (`[62,57,53,48,43,38]`) while `note.string` counts
//    from the LOWEST string, so string 1 is `tuning[length - 1]`. Verified on a
//    real file: string 1 -> 38, string 7 -> 62. This is exactly the kind of
//    inversion that silently corrupts a retuning, so every read goes through
//    `tuningForString()`, whose agreement with alphaTab's own
//    `Note.getStringTuning()` is pinned by a test.
//
// 3. Tempo is NOT subject to the automation-overwrite gotcha that
//    `trackSound.js` documents for the midi program. `Beat.finish()` strips
//    Tempo automations out of `beat.automations` altogether, and the midi
//    generator reads the tempo only from `masterBar.tempoAutomations`. So
//    unlike the program, the tempo has exactly one write site.
//
// 4. A NATURAL HARMONIC's pitch does not come from its fret. `realValue` is
//    normally `fret + stringTuning - transpositionPitch`, but for
//    `HarmonicType.Natural` alphaTab computes
//    `harmonicPitch + stringTuning - transpositionPitch` - the fret is absent
//    from the formula. Verified on a real file: `fret += 2` left the note at
//    midi 55, while shifting the tuning by 2 moved it to 57.
//
//    So moving frets would leave natural harmonics sitting on their original
//    pitch while every other note moved, and compensating a retuning with
//    frets cannot hold their pitch either. Both fret-based operations count
//    them and refuse. Shifting the TUNING is correct for them, which is why
//    every one of those refusals points there.
//
//    Artificial, pinch, tap and semi harmonics are fine: `harmonicPitch` is
//    simply added, so a fret shift moves them by the same amount. On a .gpx
//    test file, all 37 harmonic notes were artificial and behaved correctly.
//    `staff.transpositionPitch` is likewise harmless - it is subtracted from
//    every note on the staff, so it cancels out of every delta computed here.
//
// 5. `note.string` has a CACHED INDEX beside it. `Beat` keeps a
//    `noteStringLookup` Map of string -> note, filled by `addNote()` and only
//    rebuilt by `finish()`. Assigning `note.string` in place leaves that Map
//    pointing at the old string, and it is not decorative: `MidiFileGenerator`
//    reads `beat.hasNoteOnString()` to decide where a let-ring stops, and tie,
//    hammer-on and slide resolution all go through `getNoteOnString()`. So the
//    Map is updated alongside every string write, in `writeNoteString()`.
//
//    Remove-and-re-add is NOT the fix: `addNote()` sets
//    `note.index = notes.length` and pushes, while `removeNote()` does not
//    renumber what is left, so a round trip through them would corrupt
//    `note.index` and reorder the chord.
//
//    The sibling `noteValueLookup` (keyed on `realValue`) does go stale on a
//    fret change, but it is only consulted by `findTieOrigin` for notes that are
//    NOT stringed, and every operation here is on stringed notes.
//
// And one thing deliberately NOT done: nothing here calls `score.finish()`.
// finish() is idempotent (measured on a 118-bar score: 16ms, then 9.5ms, then
// 6.2ms, with beat and note counts unchanged), but all it recomputes is
// structure and durations, and no operation in this file changes either -
// frets, tunings, tempo values and track names are read straight from the model
// at render time. Adding or removing beats or bars WOULD need it.

// Fret bounds. A UI guard rail, not an alphaTab limit: the model holds any
// number. 24 covers every instrument this viewer is likely to open, and a real
// .gpx test file does use fret 24.
export const MIN_FRET = 0
export const MAX_FRET = 24

// Same kind of guard rail for the BPM field.
export const MIN_TEMPO = 10
export const MAX_TEMPO = 400

// The two retuning modes asked for. Keep the sounding pitches, and let the
// frets move to compensate; or keep the fingering, and let the pitches move.
export const RETUNE_KEEP_PITCH = 'keep-pitch'
export const RETUNE_REASSIGN = 'reassign'

// Every edit returns this one shape.
//
// `reason` is a message meant to be shown to the user verbatim, and it is
// always filled on a refusal: an operation that cannot be applied says why,
// with numbers, instead of clamping the offending notes. A transposition that
// clamps is no longer a transposition of the original.
//
// `changed` separates "applied" from "asked for what was already true", so the
// caller does not mark the score dirty for a no-op.
function applied(extra) {
  return { ok: true, changed: true, reason: null, ...extra }
}
function noop(extra) {
  return { ok: true, changed: false, reason: null, ...extra }
}
function refused(reason, extra) {
  return { ok: false, changed: false, reason, ...extra }
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value)
}

// ---------------------------------------------------------------------------
// Model reads
// ---------------------------------------------------------------------------

// Pitfall 2, in one place. `tunings` is highest string first; `string` is
// 1-based counting up from the lowest string. Mirrors alphaTab's
// `Note.getStringTuning(staff, string)`, and a test asserts the two agree so
// this stays true if alphaTab ever changes the convention.
export function tuningForString(tunings, string) {
  if (!tunings?.length) return 0
  return tunings[tunings.length - (string - 1) - 1] ?? 0
}

// Notes that carry a string and a fret. Percussion notes report `string: -1`
// and `fret: -1` (verified), so `isStringed` is what keeps every fret and
// tuning operation off them.
export function* stringedNotes(staff) {
  for (const bar of staff?.bars ?? []) {
    for (const voice of bar.voices ?? []) {
      for (const beat of voice.beats ?? []) {
        for (const note of beat.notes ?? []) {
          if (note.isStringed) yield note
        }
      }
    }
  }
}

// Staves that have a tablature at all. `Staff.isStringed` is
// `stringTuning.tunings.length > 0`, so a percussion staff is excluded.
function stringedStaves(track) {
  return (track?.staves ?? []).filter((staff) => staff.isStringed)
}

// Notes whose pitch is NOT derived from their fret (pitfall 4), so that any
// operation moving frets can refuse instead of leaving them behind.
export function countNaturalHarmonics(staff) {
  let count = 0
  for (const note of stringedNotes(staff)) {
    if (note.harmonicType === alphaTab.model.HarmonicType.Natural) count += 1
  }
  return count
}

// The reason text shared by both fret-based operations, since they fail on
// natural harmonics for exactly the same reason and have the same way out.
function naturalHarmonicRefusal(count, what) {
  const notes = count === 1 ? 'note is a natural harmonic' : 'notes are natural harmonics'
  return (
    `${count} ${notes}, and a natural harmonic sounds at its harmonic node rather than at its fret, ` +
    `so ${what} would leave ${count === 1 ? 'it' : 'them'} behind. ` +
    'Transpose the tuning instead: that moves harmonics correctly.'
  )
}

// Lowest and highest fret in use across a staff, with how many notes there are.
// `count: 0` means there is nothing to move.
export function fretRange(staff) {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let count = 0
  for (const note of stringedNotes(staff)) {
    count += 1
    if (note.fret < min) min = note.fret
    if (note.fret > max) max = note.fret
  }
  return count === 0 ? { count: 0, min: 0, max: 0 } : { count, min, max }
}

// Flat, plain-object description of a note, for the reactive UI.
//
// The Note itself is never handed to Vue: like Score and Track it sits in a
// cyclic graph (note -> beat -> voice -> bar -> staff -> track -> score, all
// with back-references), and deep-proxying it would be slow and would risk
// breaking alphaTab internals. Same rule as the `tracks` descriptors in
// usePlayer.
export function describeNote(note) {
  if (!note) return null
  const bar = note.beat?.voice?.bar ?? null
  return {
    trackIndex: bar?.staff?.track?.index ?? null,
    staffIndex: bar?.staff?.index ?? null,
    // The MASTER bar index, which is what `RenderHints.firstChangedMasterBar`
    // wants. It matches `bar.index` for a single-staff track but is the correct
    // one to use in general.
    barIndex: bar?.masterBar?.index ?? null,
    string: note.string,
    fret: note.fret,
    // How many strings the staff has, so the panel can tell whether there is a
    // string above or below to move to.
    stringCount: bar?.staff?.tuning?.length ?? 0,
    // `getTextForTuning` turns a midi key into a note name: 40 -> "E2",
    // 64 -> "E4" (verified).
    noteName: alphaTab.model.Tuning.getTextForTuning(note.realValue, true),
    midiKey: note.realValue,
  }
}

// The tuning choices to offer for a staff: alphaTab's presets for that string
// count, plus the staff's own tuning when it matches none of them.
//
// That last part is not an edge case. Neither test file's guitar tuning matched
// a preset (`Tuning.findTuning()` returned null for both), and the preset lists
// thin out fast: 31 presets for 6 strings, 11 for 4, 6 for 5, exactly ONE for
// 7 and NONE for 8. Without the current tuning in the list, a 7-string track
// would show a dropdown the user cannot return to.
export function tuningChoices(staff) {
  const current = staff?.tuning ?? []
  if (current.length === 0) return []

  const choices = alphaTab.model.Tuning.getPresetsFor(current.length).map((preset) => ({
    name: preset.name,
    tunings: [...preset.tunings],
  }))
  if (!choices.some((choice) => sameTuning(choice.tunings, current))) {
    choices.unshift({
      name: staff.tuningName || `Custom (${describeTuning(current)})`,
      tunings: [...current],
    })
  }
  return choices.map((choice) => ({
    ...choice,
    // A stable key for :key and for matching the <select> value back to a
    // tuning: the midi keys themselves, which are what actually identifies it.
    id: choice.tunings.join('-'),
    isCurrent: sameTuning(choice.tunings, current),
    label: `${choice.name || 'Custom'} - ${describeTuning(choice.tunings)}`,
  }))
}

// A tuning written the way a tab header writes it, lowest string first, because
// that is the order a player reads their strings in - the opposite of storage.
export function describeTuning(tunings) {
  return [...(tunings ?? [])]
    .reverse()
    .map((value) => alphaTab.model.Tuning.getTextForTuning(value, false))
    .join(' ')
}

function sameTuning(a, b) {
  if (a?.length !== b?.length) return false
  return a.every((value, i) => value === b[i])
}

// What the tempo field should display, and whether the score carries a tempo
// MAP rather than a single value. The count matters to the user: above 1 they
// are moving a whole curve, not a number.
//
// No type filter on `tempoAutomations`: alphaTab sets `type = Tempo` at every
// site that pushes into that list, so anything in it is a tempo.
export function tempoInfo(score) {
  let automationCount = 0
  for (const masterBar of score?.masterBars ?? []) {
    automationCount += masterBar.tempoAutomations?.length ?? 0
  }
  return { tempo: score?.tempo ?? null, automationCount }
}

// ---------------------------------------------------------------------------
// Model writes
// ---------------------------------------------------------------------------

// Always a FRESH Tuning object, never a mutation of the one already on the
// staff.
//
// Why it matters: `Tuning.getPresetsFor()` hands out shared static instances
// from alphaTab's own preset table, so writing into `staff.stringTuning.tunings`
// could corrupt that table for the rest of the session. No test file was found
// doing it - one 9-track .gp held 9 distinct Tuning objects, none of them a
// preset instance - but the cost of being safe is a single allocation.
//
// `finish()` on the new tuning is what fills in `name` and `isStandard` from
// alphaTab's known-tuning list, so the stave label reads "Guitar Tune down 1
// step" rather than nothing. Verified: it names that tuning exactly, and leaves
// the name empty for one it does not know.
function writeTuning(staff, tunings) {
  const tuning = new alphaTab.model.Tuning('', [...tunings], false)
  tuning.finish()
  staff.stringTuning = tuning
}

// 1. Rename a track. Both names, because `shortName` is what the stave label
// falls back to and leaving it behind would show the old name on the staff.
export function renameTrack(track, name) {
  if (!track) return refused('No track selected.')
  const value = String(name ?? '').trim()
  if (!value) return refused('A track name cannot be empty.')
  if (track.name === value && track.shortName === value) return noop()
  track.name = value
  track.shortName = value
  return applied()
}

// 2. Tempo, rewritten PROPORTIONALLY: every tempo automation is multiplied by
// the ratio the user asked for on the initial tempo, so an author's tempo map
// survives instead of being flattened to one value. Measured on a real map:
// 118 / 119.97 / 119 with a 1.5 ratio became 177 / 179.96 / 178.5.
//
// The first automation is then forced to the exact target rather than left at
// `round(value * ratio)`: `score.tempo` reads that one automation, so anything
// else would show the user a number they did not type.
//
// Values are rounded to 2 decimals, not to integers. Files really do carry
// fractional tempi (119.97 in one test file) and the multiplication produces
// float noise like 179.94899999999998; rounding to integers would quietly
// rewrite the author's map on every edit.
//
// Not to be confused with `playbackSpeed` in usePlayer, which is a listening
// preference and is never written to the score.
export function applyScoreTempo(score, bpm) {
  if (!score) return refused('No score loaded.')

  const target = Number(bpm)
  if (!Number.isFinite(target)) return refused('Enter a tempo in BPM.')
  if (target < MIN_TEMPO || target > MAX_TEMPO) {
    return refused(`Tempo must be between ${MIN_TEMPO} and ${MAX_TEMPO} BPM.`)
  }

  const current = score.tempo
  if (!Number.isFinite(current) || current <= 0) {
    return refused('This score has no readable tempo.')
  }
  if (roundTempo(current) === roundTempo(target)) return noop()

  // The getter reads `masterBars[0].tempoAutomations[0]` and nothing else, so
  // that is the automation that has to land on the typed value exactly.
  const anchor = score.masterBars[0]?.tempoAutomations?.[0] ?? null
  if (!anchor) return refused('This score carries no tempo automation to change.')

  const ratio = target / current
  let count = 0
  for (const masterBar of score.masterBars) {
    for (const automation of masterBar.tempoAutomations ?? []) {
      automation.value = roundTempo(automation.value * ratio)
      count += 1
    }
  }
  anchor.value = roundTempo(target)

  return applied({ automationCount: count })
}

// 2 decimals: enough to keep a fractional tempo that came from a file, tight
// enough to kill the float noise that multiplying introduces.
function roundTempo(value) {
  return Math.round(value * 100) / 100
}

// 4a. Transpose while KEEPING THE FINGERING: shift every string of the tuning
// and leave the frets alone. This is what a guitarist does by detuning. It is
// always playable, and it is one write per staff rather than one per note.
export function transposeTrackByTuning(track, semitones) {
  const step = Math.round(Number(semitones))
  if (!Number.isFinite(step)) return refused('Enter a number of semitones.')
  if (step === 0) return noop()

  const staves = stringedStaves(track)
  if (staves.length === 0) return refused('This track has no tablature to transpose.')

  // A tuning value is a midi key, so it has to stay in range. The frets do not
  // move here, so there is nothing else that can go out of bounds.
  for (const staff of staves) {
    for (const value of staff.tuning) {
      const moved = value + step
      if (moved < 0 || moved > 127) {
        return refused(
          `Detuning by ${signed(step)} semitones would put a string on midi key ${moved}, outside the 0-127 range.`,
        )
      }
    }
  }

  for (const staff of staves) {
    writeTuning(
      staff,
      staff.tuning.map((value) => value + step),
    )
  }
  return applied({ staffCount: staves.length })
}

// 4b. Transpose while KEEPING THE TUNING: every fret moves by `semitones`.
//
// Unlike the tuning shift this can be IMPOSSIBLE, and often is. Measured on a
// test track: 771 notes with frets from 0 to 9, so a single semitone down
// already asks for fret -1.
//
// So the whole track's range is checked BEFORE anything is written, and the
// refusal carries the numbers. Clamping the offending notes would leave a score
// that is no longer a transposition of the original.
export function transposeTrackByFrets(track, semitones) {
  const step = Math.round(Number(semitones))
  if (!Number.isFinite(step)) return refused('Enter a number of semitones.')
  if (step === 0) return noop()

  const staves = stringedStaves(track)
  if (staves.length === 0) return refused('This track has no tablature to transpose.')

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let count = 0
  for (const staff of staves) {
    const range = fretRange(staff)
    if (range.count === 0) continue
    count += range.count
    min = Math.min(min, range.min)
    max = Math.max(max, range.max)
  }
  if (count === 0) return refused('This track has no fretted notes to transpose.')

  // Pitfall 4: these notes would not follow the frets.
  const harmonics = staves.reduce((total, staff) => total + countNaturalHarmonics(staff), 0)
  if (harmonics > 0) {
    return refused(naturalHarmonicRefusal(harmonics, 'moving the frets'))
  }

  const low = min + step
  const high = max + step
  if (low < MIN_FRET) {
    return refused(
      `Cannot move ${count} notes by ${signed(step)} semitones: the lowest one sits on fret ${min} and would land on fret ${low}. Frets stay between ${MIN_FRET} and ${MAX_FRET}. Transpose the tuning instead to keep the fingering.`,
    )
  }
  if (high > MAX_FRET) {
    return refused(
      `Cannot move ${count} notes by ${signed(step)} semitones: the highest one sits on fret ${max} and would land on fret ${high}. Frets stay between ${MIN_FRET} and ${MAX_FRET}. Transpose the tuning instead to keep the fingering.`,
    )
  }

  for (const staff of staves) {
    for (const note of stringedNotes(staff)) note.fret += step
  }
  return applied({ noteCount: count })
}

// 4c. Retune a track to an explicit set of midi keys, in either mode.
//
// Changing the NUMBER of strings is out of scope and refused: notes carry a
// string number, and shrinking the tuning would leave them pointing at a string
// that no longer exists.
export function retuneTrack(track, tunings, mode) {
  const staves = stringedStaves(track)
  if (staves.length === 0) return refused('This track has no tablature to retune.')

  const next = [...(tunings ?? [])].map((value) => Math.round(Number(value)))
  if (next.length === 0 || next.some((value) => !Number.isFinite(value) || value < 0 || value > 127)) {
    return refused('That tuning is not a valid list of midi keys.')
  }

  const mismatched = staves.find((staff) => staff.tuning.length !== next.length)
  if (mismatched) {
    return refused(
      `That tuning has ${next.length} strings and this track has ${mismatched.tuning.length}. Changing the number of strings is not supported.`,
    )
  }
  if (staves.every((staff) => sameTuning(staff.tuning, next))) return noop()

  if (mode === RETUNE_REASSIGN) {
    // Frets unchanged, so the pitches move. Nothing can go out of range.
    for (const staff of staves) writeTuning(staff, next)
    return applied({ staffCount: staves.length })
  }
  if (mode !== RETUNE_KEEP_PITCH) return refused(`Unknown retune mode "${mode}".`)

  // Pitfall 4 again: a natural harmonic's pitch follows the TUNING, so no fret
  // compensation can hold it. This mode's whole promise is that the score
  // sounds identical, and it cannot keep it here.
  const harmonics = staves.reduce((total, staff) => total + countNaturalHarmonics(staff), 0)
  if (harmonics > 0) {
    return refused(naturalHarmonicRefusal(harmonics, 'compensating with the frets'))
  }

  // Keep the sounding pitch. `realValue` is `stringTuning + fret`, so holding
  // it constant means `newFret = fret + (oldTuning - newTuning)` for that
  // string. Both tuning reads go through `tuningForString` because of pitfall
  // 2: indexing `tuning` by hand here is how this silently produces a score
  // that is a semitone-scrambled version of the original.
  let count = 0
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  for (const staff of staves) {
    for (const note of stringedNotes(staff)) {
      const moved =
        note.fret +
        tuningForString(staff.tuning, note.string) -
        tuningForString(next, note.string)
      count += 1
      if (moved < low) low = moved
      if (moved > high) high = moved
    }
  }
  if (count > 0 && (low < MIN_FRET || high > MAX_FRET)) {
    return refused(
      `Keeping the pitches would need frets from ${low} to ${high} on ${count} notes, outside the ${MIN_FRET}-${MAX_FRET} range. Reassign the frets instead, and let the pitches move.`,
    )
  }

  for (const staff of staves) {
    // Captured before the write, so the loop order below cannot matter.
    const before = [...staff.tuning]
    for (const note of stringedNotes(staff)) {
      note.fret += tuningForString(before, note.string) - tuningForString(next, note.string)
    }
    writeTuning(staff, next)
  }
  return applied({ noteCount: count, staffCount: staves.length })
}

// Write `note.string`, keeping `Beat.noteStringLookup` in step. See pitfall 5:
// this Map is read by the midi generator and by tie resolution, and nothing but
// `finish()` would otherwise rebuild it.
function writeNoteString(note, string) {
  const lookup = note.beat?.noteStringLookup
  if (lookup) lookup.delete(note.string)
  note.string = string
  if (lookup) lookup.set(string, note)
}

// 7a. Move one note to the ADJACENT STRING, keeping the pitch it sounds.
//
// This is the "same note, different place on the neck" move: the fret changes to
// compensate for the new string's tuning, so the score sounds identical and only
// the fingering moves.
//
// Direction: `delta` of +1 goes to the next string UP, meaning both higher in
// pitch and higher on the tablature, since `staff.tuning` is stored with the
// top tab line first and `note.string` counts up from the lowest string
// (pitfall 2). A higher-pitched string needs a LOWER fret for the same note, so
// moving up moves the fret number down. That is what Guitar Pro does, and it
// keeps the note moving the way the key points on screen.
export function shiftNoteString(note, delta) {
  if (!note) return refused('No note selected.')
  if (!note.isStringed) {
    return refused('That note has no string: it is written as percussion or without tablature.')
  }
  const step = Math.round(Number(delta))
  if (!Number.isFinite(step) || step === 0) return noop()

  const staff = note.beat?.voice?.bar?.staff ?? null
  const strings = staff?.tuning?.length ?? 0
  if (!staff || strings === 0) return refused('That note is not on a tablature staff.')

  const target = note.string + step
  if (target < 1 || target > strings) {
    return refused(
      `There is no string ${target}: this staff has ${strings}. The note is already on the ${step > 0 ? 'highest' : 'lowest'} string.`,
    )
  }

  // Pitfall 4: a natural harmonic sounds at `harmonicPitch + stringTuning`, so
  // changing its string changes its pitch and no fret can compensate.
  if (note.harmonicType === alphaTab.model.HarmonicType.Natural) {
    return refused(
      'That note is a natural harmonic: its pitch comes from the harmonic node, so it cannot be moved to another string without changing what it sounds.',
    )
  }

  // A beat holds at most one note per string, and `noteStringLookup` is keyed on
  // exactly that. Moving onto an occupied string would make two notes claim one
  // key and silently drop one of them from the Map.
  const occupant = note.beat.getNoteOnString(target)
  if (occupant && occupant !== note) {
    return refused(
      `String ${target} is already played by another note in this chord (fret ${occupant.fret}).`,
    )
  }

  // Keep the pitch: newFret = fret + oldStringTuning - newStringTuning. Both
  // reads go through tuningForString because of pitfall 2.
  const newFret =
    note.fret + tuningForString(staff.tuning, note.string) - tuningForString(staff.tuning, target)
  if (newFret < MIN_FRET || newFret > MAX_FRET) {
    return refused(
      `Keeping this note on string ${target} would need fret ${newFret}, outside the ${MIN_FRET}-${MAX_FRET} range.`,
    )
  }

  writeNoteString(note, target)
  note.fret = newFret
  return applied({ string: target, fret: newFret })
}

// 7b. One note's fret, which DOES change the pitch by that many semitones.
// `realValue` is a getter over `stringTuning + fret`, so it follows this
// immediately, with no finish() and no render (verified).
export function setNoteFret(note, fret) {
  if (!note) return refused('No note selected.')
  if (!note.isStringed) {
    return refused('That note has no fret: it is written as percussion or without tablature.')
  }
  // Pitfall 4: the fret would move on the tab while the note kept sounding at
  // its old pitch, because that pitch comes from `harmonicValue`. Writing
  // `harmonicValue` too is not a fix: alphaTab maps it through a table of real
  // node positions, so fret 8 would resolve to the harmonic of fret 8.5.
  if (note.harmonicType === alphaTab.model.HarmonicType.Natural) {
    return refused('That note is a natural harmonic: its pitch comes from the harmonic node, not from the fret.')
  }
  const value = Math.round(Number(fret))
  if (!Number.isFinite(value)) return refused('Enter a fret number.')
  if (value < MIN_FRET || value > MAX_FRET) {
    return refused(`Fret ${value} is outside the ${MIN_FRET}-${MAX_FRET} range.`)
  }
  if (note.fret === value) return noop()
  note.fret = value
  return applied()
}
