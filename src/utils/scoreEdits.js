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
// `score.finish()` is called by exactly ONE operation, `deleteNotes`, and by no
// other. finish() is idempotent (measured on a 118-bar score: 16ms, then 9.5ms,
// then 6.2ms, with beat and note counts unchanged), but all it recomputes is
// structure, durations and cross-note links - and every other operation here
// changes none of those. Frets, tunings, tempo values and track names are read
// straight from the model at render time.
//
// Deleting is the exception because it is the only STRUCTURAL edit: it changes
// which notes exist, which invalidates the tie and slide resolution and the
// per-beat `noteValueLookup`. See `deleteNotes`.

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
//
// Every result with `changed: true` also carries an `undo` function that puts the
// model back exactly. It is produced HERE, by the operation itself, because this
// is the only place that knows what was touched - and keeping the capture next to
// the write is what stops the two drifting apart. See scoreHistory.js for why
// these are field-level captures rather than snapshots.
//
// `undo` IS A SWAP, not a one-way restore. Calling it exchanges the saved state
// with the live one, so calling it a second time re-applies the edit. That is the
// whole of redo: the history moves a record between two stacks and calls the same
// function, with no second closure per operation and - crucially - no dependency
// on the selection, which an undo has already cleared by the time a redo runs.
//
// Several operations need no captured state at all: the inverse of "every fret
// +2" is "every fret -2", so their swap is a closure over a step it negates each
// time. Note also that neither direction ever re-validates. Both restore a state
// the model was already in, so running them through the forward checks could only
// refuse something that is by definition legal.
function applied(extra) {
  return { ok: true, changed: true, reason: null, ...extra }
}
function noop(extra) {
  return { ok: true, changed: false, reason: null, ...extra }
}
function refused(reason, extra) {
  return { ok: false, changed: false, reason, ...extra }
}

// The swap behind most undo records: exchange each saved value with the live one.
//
// `{ target, key, value }` covers every value-based edit here - a track's name, a
// tempo automation's value, a staff's Tuning object, a note's fret - and because
// it writes the live value back into `value`, the same closure runs in both
// directions.
function makeSwap(entries) {
  return () => {
    for (const entry of entries) {
      const live = entry.target[entry.key]
      entry.target[entry.key] = entry.value
      entry.value = live
    }
  }
}

// The swap for a CONSTANT shift. No captured state at all: the inverse of
// "+2 on every fret" is "-2", and the inverse of that is "+2" again, so the
// closure just negates its own step each time.
function makeShiftSwap(notes, step) {
  let delta = -step
  return () => {
    for (const note of notes) note.fret += delta
    delta = -delta
  }
}

// The same, followed by a re-derivation.
//
// `finish()` is not optional and not a precaution: several fields are DERIVED
// from the ones these swaps write - `playbackDuration` from `duration` and
// `dots` (pitfall 7), `Beat.isPalmMute` from its notes' flags - and nothing
// recomputes them on assignment. A swap that skipped it would put the field back
// and leave the score reading the old value, the bar-fill counter included.
function makeFinishingSwap(entries, score, settings) {
  const swap = makeSwap(entries)
  return () => {
    swap()
    score?.finish(settings ?? null)
  }
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

// What a fret shift of `step` would need, measured over any set of notes.
//
// Shared by the whole-track transposition and the range batch so the two cannot
// disagree about what is possible. It only MEASURES; each caller words its own
// refusal, because "this track" and "these 12 notes" need different messages.
export function measureFretShift(notes, step) {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let count = 0
  let harmonics = 0
  for (const note of notes) {
    if (!note.isStringed) continue
    count += 1
    if (note.fret < min) min = note.fret
    if (note.fret > max) max = note.fret
    if (note.harmonicType === alphaTab.model.HarmonicType.Natural) harmonics += 1
  }
  if (count === 0) return { count: 0, min: 0, max: 0, harmonics: 0, low: 0, high: 0 }
  return { count, min, max, harmonics, low: min + step, high: max + step }
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

// The stringed notes of a track whose BEAT STARTS inside a tick window.
//
// `absolutePlaybackStart` is model-absolute: it ignores repeats, and it is
// comparable across staves and across voices, which the per-voice `beat.index`
// is not. So it is the right key for "what did the user drag over".
//
// A beat that starts just before the window is excluded even if it still sounds
// inside it. "Beats that START in the selection" is a rule a user can predict;
// "beats that overlap it" would silently pull in a note they did not drag over.
export function notesInTickRange(track, startTick, endTick) {
  const notes = []
  for (const staff of track?.staves ?? []) {
    if (!staff.isStringed) continue
    for (const bar of staff.bars ?? []) {
      for (const voice of bar.voices ?? []) {
        for (const beat of voice.beats ?? []) {
          const start = beat.absolutePlaybackStart
          if (start < startTick || start >= endTick) continue
          for (const note of beat.notes ?? []) {
            if (note.isStringed) notes.push(note)
          }
        }
      }
    }
  }
  return notes
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
    isPalmMute: !!note.isPalmMute,
    // The plain fretted pitch, with no harmonic applied. `midiKey` above is
    // `realValue`, which for a harmonic is already raised - so anything that
    // needs to ADD an interval has to start from this one instead. Same reason
    // the octave planner works from `fret + tuning` rather than `realValue`.
    frettedMidiKey: note.isStringed ? note.calculateRealValue(false, false) : null,
    // Which harmonic, if any, and where its node is. `harmonicValue` is a fret
    // position for a natural one and a distance in frets for the others.
    harmonicType: note.harmonicType,
    harmonicValue: note.harmonicValue,
    isNaturalHarmonic: note.harmonicType === alphaTab.model.HarmonicType.Natural,
    isArtificialHarmonic:
      note.harmonicType !== alphaTab.model.HarmonicType.None &&
      note.harmonicType !== alphaTab.model.HarmonicType.Natural,
  }
}

// A midi key as a note name: 40 -> "E2", 64 -> "E4" (verified).
//
// Exported so a component can label a pitch without importing alphaTab, which
// is the rule this module exists to keep: nothing outside it touches the
// library's model.
export function noteNameForMidi(key) {
  if (!Number.isFinite(key)) return ''
  return alphaTab.model.Tuning.getTextForTuning(Math.round(key), true)
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

  const undo = makeSwap([
    { target: track, key: 'name', value: track.name },
    { target: track, key: 'shortName', value: track.shortName },
  ])
  track.name = value
  track.shortName = value
  return applied({ undo })
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
  // One entry per automation. Captured rather than inverted by dividing: the
  // rounding is lossy, so multiplying back by 1/ratio would drift.
  const entries = []
  for (const masterBar of score.masterBars) {
    for (const automation of masterBar.tempoAutomations ?? []) {
      entries.push({ target: automation, key: 'value', value: automation.value })
      automation.value = roundTempo(automation.value * ratio)
    }
  }
  anchor.value = roundTempo(target)

  return applied({ automationCount: entries.length, undo: makeSwap(entries) })
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

  // The original Tuning OBJECTS, not copies of their values: putting the object
  // back restores its `name` and `isStandard` too, which a fresh Tuning would
  // have to re-derive.
  const undo = makeSwap(
    staves.map((staff) => ({ target: staff, key: 'stringTuning', value: staff.stringTuning })),
  )
  for (const staff of staves) {
    writeTuning(
      staff,
      staff.tuning.map((value) => value + step),
    )
  }
  return applied({ staffCount: staves.length, undo })
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

  const all = staves.flatMap((staff) => [...stringedNotes(staff)])
  const { count, min, max, low, high, harmonics } = measureFretShift(all, step)
  if (count === 0) return refused('This track has no fretted notes to transpose.')

  // Pitfall 4: these notes would not follow the frets.
  if (harmonics > 0) {
    return refused(naturalHarmonicRefusal(harmonics, 'moving the frets'))
  }

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

  for (const note of all) note.fret += step
  return applied({ noteCount: count, undo: makeShiftSwap(all, step) })
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
    // Frets unchanged, so the pitches move. Nothing can go out of range, and the
    // undo is just the original Tuning objects back.
    const undo = makeSwap(
      staves.map((staff) => ({ target: staff, key: 'stringTuning', value: staff.stringTuning })),
    )
    for (const staff of staves) writeTuning(staff, next)
    return applied({ staffCount: staves.length, undo })
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

  // Every fret moves by its own string's delta, so the undo needs the frets
  // themselves: one number per note. Plus the original Tuning objects.
  const entries = staves.map((staff) => ({
    target: staff,
    key: 'stringTuning',
    value: staff.stringTuning,
  }))

  for (const staff of staves) {
    // Captured before the write, so the loop order below cannot matter.
    const before = [...staff.tuning]
    for (const note of stringedNotes(staff)) {
      entries.push({ target: note, key: 'fret', value: note.fret })
      note.fret += tuningForString(before, note.string) - tuningForString(next, note.string)
    }
    writeTuning(staff, next)
  }
  return applied({ noteCount: count, staffCount: staves.length, undo: makeSwap(entries) })
}

// Apply a set of `{ note, string, fret }` moves, keeping every
// `Beat.noteStringLookup` in step. See pitfall 5: that Map is read by the midi
// generator and by tie resolution, and nothing but `finish()` rebuilds it.
//
// TWO PHASES, and that is the whole point. Moving a chord up one string means
// the note leaving string 4 and the note arriving on string 4 are both in the
// batch; writing them one at a time would let the departing note's `delete`
// erase the arriving note's entry, or vice versa, depending on order. Dropping
// every mover from its lookup first makes the result independent of order.
function applyNoteStringMoves(moves) {
  for (const { note } of moves) note.beat?.noteStringLookup?.delete(note.string)
  for (const { note, string, fret } of moves) {
    note.string = string
    note.fret = fret
    note.beat?.noteStringLookup?.set(string, note)
  }
}

// 7a. Move notes to the ADJACENT STRING, keeping the pitch each one sounds.
//
// This is the "same notes, different place on the neck" move: each fret changes
// to compensate for the new string's tuning, so the passage sounds identical and
// only the fingering moves.
//
// Direction: `delta` of +1 goes to the next string UP, meaning both higher in
// pitch and higher on the tablature, since `staff.tuning` is stored with the top
// tab line first and `note.string` counts up from the lowest string (pitfall 2).
// A higher-pitched string needs a LOWER fret for the same note, so moving up
// moves the fret number down. That is what Guitar Pro does, and it keeps the
// note moving the way the key points on screen.
//
// ALL OR NOTHING. Every note is checked before any is written, so a selection of
// twelve notes never ends up with nine moved and three left behind - which would
// not be a re-fingering of the passage at all.
export function shiftNotesString(notes, delta) {
  const list = [...(notes ?? [])]
  if (list.length === 0) return refused('No notes selected.')

  const step = Math.round(Number(delta))
  if (!Number.isFinite(step)) return refused('Enter a number of strings.')
  if (step === 0) return noop()

  const moves = []
  const movers = new Set(list)
  let harmonics = 0

  for (const note of list) {
    if (!note.isStringed) {
      return refused('That selection includes notes with no string: percussion, or a staff without tablature.')
    }
    // Pitfall 4: a natural harmonic sounds at `harmonicPitch + stringTuning`, so
    // changing its string changes its pitch and no fret can compensate.
    if (note.harmonicType === alphaTab.model.HarmonicType.Natural) harmonics += 1

    const staff = note.beat?.voice?.bar?.staff ?? null
    const strings = staff?.tuning?.length ?? 0
    if (!staff || strings === 0) return refused('That selection is not on a tablature staff.')

    const target = note.string + step
    if (target < 1 || target > strings) {
      return refused(
        list.length === 1
          ? `There is no string ${target}: this staff has ${strings}. The note is already on the ${step > 0 ? 'highest' : 'lowest'} string.`
          : `${countNotes(list.length)} cannot move ${step > 0 ? 'up' : 'down'} a string: at least one is already on the ${step > 0 ? 'highest' : 'lowest'} string.`,
      )
    }

    // A beat holds at most one note per string, and `noteStringLookup` is keyed
    // on exactly that. Landing on a string held by a note that is NOT moving
    // would make two notes claim one key and silently drop one of them.
    const occupant = note.beat.getNoteOnString(target)
    if (occupant && occupant !== note && !movers.has(occupant)) {
      return refused(
        `String ${target} is already played by another note in that chord (fret ${occupant.fret}).`,
      )
    }

    // Keep the pitch: newFret = fret + oldStringTuning - newStringTuning. Both
    // reads go through tuningForString because of pitfall 2.
    const newFret =
      note.fret + tuningForString(staff.tuning, note.string) - tuningForString(staff.tuning, target)
    if (newFret < MIN_FRET || newFret > MAX_FRET) {
      return refused(
        list.length === 1
          ? `Keeping this note on string ${target} would need fret ${newFret}, outside the ${MIN_FRET}-${MAX_FRET} range.`
          : `Keeping the pitches would need fret ${newFret} on at least one note, outside the ${MIN_FRET}-${MAX_FRET} range.`,
      )
    }

    moves.push({ note, string: target, fret: newFret })
  }

  if (harmonics > 0) {
    return refused(naturalHarmonicRefusal(harmonics, 'moving to another string'))
  }

  // Two numbers per note in each direction, and the same two-phase writer both
  // ways: undoing a chord move has exactly the same ordering hazard as the move.
  //
  // Two arrays and a pointer rather than a re-capture on every call, so the swap
  // allocates nothing after the edit itself.
  const from = moves.map(({ note }) => ({ note, string: note.string, fret: note.fret }))
  const to = moves.map(({ note, string, fret }) => ({ note, string, fret }))
  applyNoteStringMoves(moves)

  let next = from
  return applied({
    noteCount: moves.length,
    undo: () => {
      applyNoteStringMoves(next)
      next = next === from ? to : from
    },
  })
}

// One note, which is the keyboard's case. A wrapper rather than a second
// implementation: the ordering and occupancy logic above is exactly the part
// that must not exist twice.
export function shiftNoteString(note, delta) {
  if (!note) return refused('No note selected.')
  return shiftNotesString([note], delta)
}

function countNotes(n) {
  return n === 1 ? '1 note' : `${n} notes`
}

// 7b. Shift the fret of several notes by the same number of semitones, which
// DOES change what they sound.
//
// ALL OR NOTHING, like the string move: a selection where some notes moved and
// others hit the end of the neck is not a transposition of the passage.
export function shiftNotesFret(notes, delta) {
  const list = [...(notes ?? [])]
  if (list.length === 0) return refused('No notes selected.')

  const step = Math.round(Number(delta))
  if (!Number.isFinite(step)) return refused('Enter a number of semitones.')
  if (step === 0) return noop()

  const { count, min, max, low, high, harmonics } = measureFretShift(list, step)
  if (count === 0) return refused('That selection has no fretted notes.')
  if (count !== list.length) {
    return refused('That selection includes notes with no fret: percussion, or a staff without tablature.')
  }
  if (harmonics > 0) {
    return refused(naturalHarmonicRefusal(harmonics, 'moving the frets'))
  }
  if (low < MIN_FRET) {
    return refused(
      `Cannot move ${countNotes(count)} by ${signed(step)} semitones: the lowest sits on fret ${min} and would land on fret ${low}. Frets stay between ${MIN_FRET} and ${MAX_FRET}.`,
    )
  }
  if (high > MAX_FRET) {
    return refused(
      `Cannot move ${countNotes(count)} by ${signed(step)} semitones: the highest sits on fret ${max} and would land on fret ${high}. Frets stay between ${MIN_FRET} and ${MAX_FRET}.`,
    )
  }

  for (const note of list) note.fret += step
  return applied({ noteCount: count, undo: makeShiftSwap(list, step) })
}

// Every field on `Note` that points at another Note.
//
// Listed once and swept as a group, because the failure mode of missing one is
// invisible: a link to a deleted note SURVIVES finish(). `Note.finish()` heals a
// tie whose origin is null (`if (!tieOrigin) this.isTieDestination = false`) but
// its `this.tieOrigin ?? findTieOrigin(this)` short-circuits on a stale
// reference, so the deleted note stays the origin.
//
// Measured on a real .gpx: deleting 20 linked notes without this sweep left 34
// dangling references alive after finish(), and the generated midi differed
// (7184 note-ons against 7186) because a tie to a deleted note kept extending a
// duration. Nothing crashed - which is exactly why it needs a test rather than
// trust.
// Everything on a Note that `finish()` DERIVES rather than reads.
//
// Capturing the links alone is not enough for an undo, and the test that found
// this is worth keeping in mind: `finish()` does not only clear links that lost
// their target, it also CREATES them - `findTieOrigin` will happily resolve a tie
// to an earlier note on the same string once the original origin is gone - and it
// copies a tie destination's `fret`, `octave` and `tone` from its origin
// (`this.fret = tieOrigin.fret`). So a delete's finish() leaves the link graph in
// a state that restoring only the cuts cannot undo.
const NOTE_DERIVED_FIELDS = [
  'isTieDestination',
  'fret',
  'octave',
  'tone',
]

const NOTE_LINK_FIELDS = [
  'tieOrigin',
  'tieDestination',
  'hammerPullOrigin',
  'hammerPullDestination',
  'slurOrigin',
  'slurDestination',
  'slideOrigin',
  'slideTarget',
  'effectSlurOrigin',
  'effectSlurDestination',
  'bendOrigin',
]

function* everyNote(score) {
  for (const track of score?.tracks ?? []) {
    for (const staff of track.staves ?? []) {
      for (const bar of staff.bars ?? []) {
        for (const voice of bar.voices ?? []) {
          for (const beat of voice.beats ?? []) {
            for (const note of beat.notes ?? []) yield note
          }
        }
      }
    }
  }
}

// 7d. Replace notes with silence.
//
// A note becomes silence by being REMOVED from its beat, and the duration takes
// care of itself: `Beat.isRest` is a getter over
// `isEmpty || !deadSlapped && notes.length === 0`, and `beat.duration` is
// independent of its notes. So emptying a beat turns it into a rest of exactly
// the same length, with no duration arithmetic and no re-layout of the bar.
//
// A beat that still holds other notes keeps sounding them: deleting one note of
// a chord silences that note, not the chord.
//
// This is the only operation here that is not reversible by doing the opposite:
// a transposition can be transposed back, but a deleted note has to be put back.
// Its `undo` therefore rebuilds structure rather than restoring values, and it is
// the reason NOTE_DERIVED_FIELDS exists.
//
// Three things have to happen beyond the removal itself, and all three are
// silent corruption if skipped:
//
//  1. `note.index` must be RENUMBERED. `addNote` sets it to `notes.length` and
//     `removeNote` does not renumber, so deleting note 0 of three leaves the
//     survivors at index 1 and 2. `MidiFileGenerator` reads `note.index === 0`
//     to decide where to generate a beat's whammy bar, so a beat could lose its
//     whammy entirely.
//  2. Every cross-note link to a removed note must be NULLED. See
//     NOTE_LINK_FIELDS.
//  3. `score.finish()` must run, to rebuild the per-beat `noteValueLookup` and
//     to re-resolve or clear the links that just lost their target.
export function deleteNotes(notes, settings) {
  const list = [...(notes ?? [])]
  if (list.length === 0) return refused('Nothing selected to delete.')

  const score = list[0].beat?.voice?.bar?.staff?.track?.score ?? null
  if (!score) return refused('Those notes are not attached to a score.')

  const victims = new Set(list)
  const beats = new Set(list.map((note) => note.beat))

  // Where each victim sat, so the undo can put it back in the same slot rather
  // than appending. `note.index` and the order of `beat.notes` are not
  // interchangeable: the whammy generator reads `index === 0`.
  const removed = list
    .map((note) => ({ note, beat: note.beat, at: note.beat?.notes.indexOf(note) ?? -1 }))
    .sort((a, b) => a.at - b.at)

  // Everything finish() may re-derive, for every note of every AFFECTED STAFF.
  //
  // The staff is the right unit and needs no magic constant: finish()'s link
  // resolution walks `nextBeat` / `previousBeat`, which stay inside one staff, so
  // capturing the staff entirely is provably enough. Bounded too - the largest
  // single staff in the test files is 3622 notes, so about 0.4MB for the record.
  const staves = new Set(
    list.map((note) => note.beat?.voice?.bar?.staff).filter((staff) => staff),
  )
  const derived = []
  for (const staff of staves) {
    for (const bar of staff.bars ?? []) {
      for (const voice of bar.voices ?? []) {
        for (const beat of voice.beats ?? []) {
          for (const note of beat.notes ?? []) {
            const state = {}
            for (const field of NOTE_LINK_FIELDS) state[field] = note[field]
            for (const field of NOTE_DERIVED_FIELDS) state[field] = note[field]
            derived.push({ note, state })
          }
        }
      }
    }
  }

  function renumber() {
    for (const beat of beats) {
      beat.notes.forEach((note, index) => {
        note.index = index
      })
    }
  }

  // Remove, renumber, cut the dangling links, rebuild. Named because the swap
  // below runs it again for a redo, and a second copy of these three steps is
  // exactly what would drift.
  //
  // The link sweep walks the whole score rather than following the victims' own
  // back-references: several of those fields have no inverse (`bendOrigin` for
  // one), so only walking everything is provably complete. Measured at 12ms over
  // 7295 notes, which is nothing for a deliberate action.
  function detach() {
    for (const note of list) note.beat?.removeNote(note)
    renumber()
    for (const note of everyNote(score)) {
      for (const field of NOTE_LINK_FIELDS) {
        if (victims.has(note[field])) note[field] = null
      }
    }
    score.finish(settings ?? null)
  }

  // The way back. The Note objects are still alive - only detached - so this is a
  // re-attach, not a reconstruction. Ascending original index, so each splice
  // lands in a slot the earlier ones have already made room for.
  //
  // The derived state goes back BEFORE finishing, not after: finish() would
  // overwrite it, and its own caches (`noteValueLookup` is keyed on `realValue`,
  // so on `fret`) have to be built from the restored values. Restoring the
  // pre-delete state and finishing reproduces exactly the derivation the importer
  // had already settled on.
  function reattach() {
    for (const entry of removed) {
      const { note, beat, at } = entry
      if (!beat) continue
      const index = at >= 0 && at <= beat.notes.length ? at : beat.notes.length
      beat.notes.splice(index, 0, note)
      note.beat = beat
      if (note.isStringed) beat.noteStringLookup.set(note.string, note)
    }
    renumber()
    for (const entry of derived) Object.assign(entry.note, entry.state)
    score.finish(settings ?? null)
  }

  detach()

  let restBeats = 0
  for (const beat of beats) if (beat.isRest) restBeats += 1

  // The only swap that moves STRUCTURE rather than values, so it toggles between
  // two named halves instead of exchanging fields.
  let isDetached = true
  return applied({
    noteCount: list.length,
    beatCount: beats.size,
    restBeats,
    undo: () => {
      if (isDetached) reattach()
      else detach()
      isDetached = !isDetached
    },
  })
}

// 7c. One note's fret, which DOES change the pitch by that many semitones.
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
  const undo = makeSwap([{ target: note, key: 'fret', value: note.fret }])
  note.fret = value
  return applied({ undo })
}

// 7f. Palm mute, which is a property of the NOTE and a marking on the BEAT.
//
// `note.isPalmMute` is a plain field, and `Beat.finish` derives the beat's own
// flag from its notes (`if (note.isPalmMute) this.isPalmMute = true`). Measured:
// the beat reads false after setting the note and true after finishing, so the
// finish is what puts the P.M. bracket on the score rather than a nicety.
//
// It changes what is HEARD without moving the tick grid, which is why it takes
// the `onPlay` flavour like the frets. Measured on the whole midi event stream:
// 417 events before and after, one pair different - the note-off moves from tick
// 960 to 160, so the note is cut short where it starts at the same instant.
//
// A TOGGLE, and mixed selections resolve towards ON for the same reason the dot
// does: the first press should do what was asked rather than undo work already
// on screen.
//
// Refused on a note with no string, where the technique has no meaning. alphaTab
// would let it be set - measured, a drum note takes the flag without complaint -
// so this refusal is ours to make, and it is the same one the frets and the
// strings already make.
export function togglePalmMute(notes, settings) {
  const list = [...new Set(notes ?? [])]
  if (list.length === 0) return refused('No notes selected.')

  const score = list[0]?.beat?.voice?.bar?.staff?.track?.score ?? null
  if (!score) return refused('Those notes are not attached to a score.')

  const unstringed = list.filter((note) => !note.isStringed)
  if (unstringed.length > 0) {
    return refused(
      list.length === 1
        ? 'That note has no string: percussion cannot be palm muted.'
        : `${unstringed.length} of these ${list.length} notes have no string: percussion cannot be palm muted.`,
    )
  }

  const palmMute = !list.every((note) => note.isPalmMute)
  const moves = list.filter((note) => note.isPalmMute !== palmMute)
  if (moves.length === 0) return noop({ noteCount: 0, palmMute })

  // Two fields are DERIVED from the flag, and `finish()` only ever SETS them -
  // it never clears either - so a plain finish leaves the score claiming a palm
  // mute that no note has any more:
  //
  //   Beat.finish  : `if (note.isPalmMute) this.isPalmMute = true`, plus a
  //                  propagation onto adjacent RESTS in both directions
  //   Note.finish  : `palmMuteDestination`, set only when the flag is true
  //
  // Caught by a test: unmuting the last muted note of a beat left
  // `beat.isPalmMute` true, which is what draws the P.M. bracket.
  //
  // So both are reset across the AFFECTED STAVES and rebuilt from the note
  // flags. The staff is the right unit and needs no magic constant, for the
  // reason it is the right unit in `deleteNotes`: the propagation walks
  // `previousBeat` / `nextBeat`, which never leave a staff. Resetting and
  // finishing reproduces exactly the derivation the importer settles on, so
  // nothing has to be captured - the value follows the flags, which the swap
  // restores.
  const staves = new Set(
    list.map((note) => note.beat?.voice?.bar?.staff).filter((staff) => staff),
  )

  function rederive() {
    for (const staff of staves) {
      for (const bar of staff.bars ?? []) {
        for (const voice of bar.voices ?? []) {
          for (const beat of voice.beats ?? []) {
            beat.isPalmMute = false
            for (const note of beat.notes ?? []) note.palmMuteDestination = null
          }
        }
      }
    }
    score.finish(settings ?? null)
  }

  const swap = makeSwap(
    moves.map((note) => ({ target: note, key: 'isPalmMute', value: note.isPalmMute })),
  )
  for (const note of moves) note.isPalmMute = palmMute
  rederive()

  return applied({
    noteCount: moves.length,
    palmMute,
    undo: () => {
      swap()
      rederive()
    },
  })
}

// ---------------------------------------------------------------------------
// 7g. Harmonics
// ---------------------------------------------------------------------------
//
// Two operations on one field pair, and the pair is the whole subject:
// `note.harmonicType` says which kind, `note.harmonicValue` says WHERE on the
// string the node is - as a fret position, which alphaTab turns into a number of
// semitones through a table (`Note.harmonicPitch`).
//
// The two kinds compute their pitch differently, and that difference is pitfall
// 4 seen from the inside:
//
//   Natural : realValue = harmonicPitch + stringTuning   <- THE FRET IS IGNORED
//   anything else : realValue = fret + stringTuning + harmonicPitch
//
// So a natural harmonic sounds the open string's node whatever fret is written,
// which is why every fret operation in this file refuses one. An artificial
// harmonic sounds the fretted note raised by the node's interval, which is what
// makes "sounding note" a meaningful choice for it and not for the other.

// Every node alphaTab knows, and the semitone offset it gives each one - read
// off `Note.harmonicPitch` rather than transcribed from theory.
//
// SEVENTEEN nodes over seven intervals, not one node per interval, and that
// distinction is the whole point of the table. A node is a POSITION as well as a
// pitch: the same interval is available at several places along the string, the
// player's right hand goes to one of them, and which one is what the file
// records. Offering the lowest node of each interval hid the useful half of the
// list - a note fretted at 4 has its octave+fifth at node 19, so under the right
// hand at fret 23, and only node 7 was on offer, at fret 11.
//
// The values are the ones real files carry where a real file carries one: 2.4,
// 3.2, 4, 5, 7 and 12 all appear in the two measured scores, so 3.2 rather than
// the 3 that also works. Elsewhere it is the node's own position, rounded the way
// alphaTab's ranges are cut.
//
// A test re-derives every offset from alphaTab itself, so an upstream change to
// that table fails rather than drifting silently past us.
const HARMONIC_OFFSETS = new Map([
  [12, 12], // the twelfth fret, and the only node of the octave
  [7, 19], // an octave and a fifth, low node
  [19, 19], // and high
  [5, 24], // two octaves, low node
  [24, 24], // and high
  [4, 28], // two octaves and a major third, three nodes
  [9, 28],
  [16, 28],
  [3.2, 31], // two octaves and a fifth, one node
  [2.7, 34], // two octaves and a minor seventh, four nodes
  [6, 34],
  [10, 34],
  [15, 34],
  [2.4, 36], // three octaves, four nodes
  [8, 36],
  [17, 36],
  [22, 36],
])

// What each offset is called, once, so seventeen nodes do not carry seven
// spellings of the same seven names.
const HARMONIC_INTERVALS = new Map([
  [12, 'Octave'],
  [19, 'Octave + fifth'],
  [24, 'Two octaves'],
  [28, 'Two octaves + major third'],
  [31, 'Two octaves + fifth'],
  [34, 'Two octaves + minor seventh'],
  [36, 'Three octaves'],
])

// Which whole frets have a node at all, computed from the same table.
//
// Nothing below the third fret, and nothing at 11, 13, 18, 20 or 21: alphaTab
// answers 0 semitones there, which for a NATURAL harmonic would sound the open
// string. That is a wrong value rather than a missing one, so it is refused.
export const HARMONIC_FRETS = [3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15, 16, 17, 19, 22, 23, 24]

// Every node an artificial harmonic can be written on, for the dialog.
//
// Ordered by the pitch it sounds and then by position, which is the order the
// dialog groups them in: one group per interval, the nodes inside it in reach
// order. `frets` is the node as a DISTANCE, which is what Guitar Pro's
// "right hand fret" is once the note's own fret is added.
//
// Not filtered by neck length, and that is a decision rather than an omission:
// the model has no fret count - `staff` carries a capo and a tuning and nothing
// else - so a filter would be a guess, and a node past the last fret is a real
// technique anyway rather than an error.
export function harmonicSoundingChoices() {
  return [...HARMONIC_OFFSETS.entries()]
    .map(([harmonicValue, semitones]) => ({
      harmonicValue,
      frets: harmonicValue,
      semitones,
      label: HARMONIC_INTERVALS.get(semitones) ?? `+${semitones} semitones`,
    }))
    .sort((a, b) => a.semitones - b.semitones || a.harmonicValue - b.harmonicValue)
}

// The node this editor offers for whatever node a note actually carries.
//
// Needed because the two do not always match: alphaTab accepts a RANGE of values
// per interval - 3 and 3.2 both give two octaves and a fifth - and a real file
// carries whichever its writer chose. Opening the dialog on such a note has to
// land on the offered node with the same interval, not fall back to the octave
// and quietly retune the note when the user presses Apply.
//
// Answers null for a value with no interval at all, which is what an unwritten
// `harmonicValue` of 0 is.
export function offeredHarmonicNode(value) {
  const node = Number(value)
  if (!Number.isFinite(node) || node <= 0) return null
  if (HARMONIC_OFFSETS.has(node)) return node

  // Through alphaTab rather than through our own table, so a value we have never
  // seen still resolves by what it SOUNDS.
  const probe = new alphaTab.model.Note()
  probe.harmonicType = alphaTab.model.HarmonicType.Pinch
  // `harmonicPitch` answers 0 for a note that is not stringed, and `isStringed`
  // is `string >= 0` - a fresh Note starts at -1, so without this the probe
  // reports no interval for every node there is.
  probe.string = 1
  probe.harmonicValue = node
  const semitones = probe.harmonicPitch
  if (!semitones) return null

  // The NEAREST node of that interval, not the first: an interval has up to four
  // of them spread along the string, and 8.2 is the three-octave node at 8, not
  // the one at 2.4. Nearest lands inside the right one because each offered node
  // sits inside its own run of accepted values.
  let best = null
  for (const [offered, offeredSemitones] of HARMONIC_OFFSETS) {
    if (offeredSemitones !== semitones) continue
    if (best === null || Math.abs(offered - node) < Math.abs(best - node)) best = offered
  }
  return best
}

// Every note of the batch that has no node at its fret, for the refusal.
function withoutHarmonicNode(notes) {
  return notes.filter((note) => !HARMONIC_FRETS.includes(note.fret))
}

// 7g-1. The natural harmonic, which is the fret's own node.
//
// `harmonicValue` is set to the note's FRET, and that is not a formality: left
// at 0 the offset is 0 and the note would sound the open string. The fixture's
// imported harmonics all carry `harmonicValue === fret`, which is what this
// reproduces.
//
// All or nothing, like the frets and unlike the octave. The octave's best-effort
// exception rests on "not moving keeps a right value", and that holds here too -
// but an octave is meant as a passage operation while a harmonic is a marking on
// a note, so a partial answer would be a different thing from what was asked.
// The refusal says which notes block and where the nodes are.
export function toggleNaturalHarmonic(notes, settings) {
  const list = [...new Set(notes ?? [])]
  if (list.length === 0) return refused('No notes selected.')

  const unstringed = list.filter((note) => !note.isStringed)
  if (unstringed.length > 0) {
    return refused(
      list.length === 1
        ? 'That note has no string: percussion cannot carry a harmonic.'
        : `${unstringed.length} of these ${list.length} notes have no string.`,
    )
  }

  const natural = alphaTab.model.HarmonicType.Natural
  const on = !list.every((note) => note.harmonicType === natural)

  if (on) {
    const blocked = withoutHarmonicNode(list)
    if (blocked.length > 0) {
      const frets = HARMONIC_FRETS.join(', ')
      return refused(
        list.length === 1
          ? `Fret ${blocked[0].fret} has no harmonic node. The frets that do: ${frets}.`
          : `${blocked.length} of these ${list.length} notes are on a fret with no harmonic node. The frets that do: ${frets}.`,
      )
    }
  }

  const entries = []
  for (const note of list) {
    entries.push({ target: note, key: 'harmonicType', value: note.harmonicType })
    entries.push({ target: note, key: 'harmonicValue', value: note.harmonicValue })
  }
  const undo = makeSwap(entries)
  for (const note of list) {
    note.harmonicType = on ? natural : alphaTab.model.HarmonicType.None
    note.harmonicValue = on ? note.fret : 0
  }

  return applied({ noteCount: list.length, harmonic: on, undo })
}

// 7g-2. The artificial harmonic, which is the fretted note raised by a node.
//
// Always PINCH, which is a decision rather than a limitation: Guitar Pro's
// dialog offers tap, pinch, semi and feedback under one heading, and the only one
// wanted here is the pinch. `harmonicPitch` treats every non-natural type the
// same, so the choice changes the marking on the score and not the pitch.
//
// `value` is the node as a distance in frets - Guitar Pro's "right hand fret"
// minus the note's own - and it is the same number as the sounding interval
// expressed the other way round. See `harmonicSoundingChoices`.
export function setArtificialHarmonic(notes, value, settings) {
  const list = [...new Set(notes ?? [])]
  if (list.length === 0) return refused('No notes selected.')

  const unstringed = list.filter((note) => !note.isStringed)
  if (unstringed.length > 0) {
    return refused(
      list.length === 1
        ? 'That note has no string: percussion cannot carry a harmonic.'
        : `${unstringed.length} of these ${list.length} notes have no string.`,
    )
  }

  // `null` removes it, which is what the dialog's own way out writes.
  if (value === null) {
    const entries = []
    for (const note of list) {
      entries.push({ target: note, key: 'harmonicType', value: note.harmonicType })
      entries.push({ target: note, key: 'harmonicValue', value: note.harmonicValue })
    }
    if (list.every((note) => note.harmonicType === alphaTab.model.HarmonicType.None)) {
      return noop({ noteCount: 0, harmonic: false })
    }
    const undo = makeSwap(entries)
    for (const note of list) {
      note.harmonicType = alphaTab.model.HarmonicType.None
      note.harmonicValue = 0
    }
    return applied({ noteCount: list.length, harmonic: false, undo })
  }

  const node = Number(value)
  if (!HARMONIC_OFFSETS.has(node)) {
    return refused('That is not a harmonic node this editor writes.')
  }

  const entries = []
  for (const note of list) {
    entries.push({ target: note, key: 'harmonicType', value: note.harmonicType })
    entries.push({ target: note, key: 'harmonicValue', value: note.harmonicValue })
  }
  const undo = makeSwap(entries)
  for (const note of list) {
    note.harmonicType = alphaTab.model.HarmonicType.Pinch
    note.harmonicValue = node
  }

  return applied({
    noteCount: list.length,
    harmonic: true,
    harmonicValue: node,
    semitones: HARMONIC_OFFSETS.get(node),
    undo,
  })
}

// ---------------------------------------------------------------------------
// Bar filling
// ---------------------------------------------------------------------------

// The three states a bar can be in, and there really are three rather than two.
//
// `under` is NORMAL: a bar being written into is incomplete for most of its
// life, and painting that red would paint the whole score red. `over` is the
// one that matters, because it is the one nothing else catches - see pitfall 8
// in the gotchas: alphaTab's model, its midi generator and its .gp exporter all
// accept a bar holding more than its time signature allows, in silence, and
// write it straight to the file.
export const BAR_UNDER = 'under'
export const BAR_EXACT = 'exact'
export const BAR_OVER = 'over'

// How full one bar is, in midi ticks, against what its time signature allows.
//
// Three things about this are not obvious, all verified against alphaTab 1.8.4:
//
//  1. `masterBar.calculateDuration()` is the CAPACITY, and it already handles
//     the anacrusis: for a normal bar it returns
//     `numerator * valueToTicks(denominator)` (3840 for 4/4), and for a pickup
//     bar it returns the longest bar actually written at that index, which is
//     the only sane capacity for a bar that is deliberately short.
//  2. `voice.calculateDuration()` returns 0 for a voice alphaTab marked EMPTY.
//     `finish()` fills unwritten voices with auto-generated rests and leaves
//     `isEmpty` true, so counting them would report every multi-voice bar as
//     empty. They are skipped, and a bar whose every voice is empty is an
//     implicit whole-bar rest rather than an incomplete bar.
//  3. Tick arithmetic DRIFTS on tuplets, downwards. A bar of seven
//     sixteenth-septuplets plus three quarters measures 3839 against a capacity
//     of 3840 (137 x 7 = 959, not 960) because each beat's tick count is
//     truncated. So the comparison carries a tolerance of one tick per beat,
//     which is the exact bound on that truncation, rather than being an
//     arbitrary fudge factor.
//
// The bar is judged by its FULLEST voice: one voice overflowing is enough to
// make the bar invalid, whatever the others do.
export function barFill(bar) {
  const masterBar = bar?.masterBar ?? null
  if (!masterBar) return null

  const capacity = masterBar.calculateDuration()

  let filled = -1
  let tolerance = 0
  let voiceCount = 0
  for (const voice of bar.voices ?? []) {
    if (voice.isEmpty) continue
    voiceCount += 1
    const duration = voice.calculateDuration()
    if (duration <= filled) continue
    filled = duration
    tolerance = voice.beats?.length ?? 0
  }

  // Every voice auto-filled: a whole-bar rest, which is complete by definition.
  if (voiceCount === 0) return { capacity, filled: capacity, tolerance: 0, state: BAR_EXACT }

  let state = BAR_EXACT
  if (filled > capacity + tolerance) state = BAR_OVER
  else if (filled < capacity - tolerance) state = BAR_UNDER
  return { capacity, filled, tolerance, state }
}

// The same reading, flattened for the UI and expressed in BEATS rather than in
// ticks: `3 / 4` says something to a musician where `2880 / 3840` does not.
//
// The beat unit is the time signature's denominator, taken from the NOMINAL
// duration (`calculateDuration(false)`) so that a pickup bar is measured in the
// same beats as the bars around it and simply reports fewer of them.
export function describeBarFill(bar) {
  const fill = barFill(bar)
  const masterBar = bar?.masterBar ?? null
  if (!fill || !masterBar) return null

  const numerator = masterBar.timeSignatureNumerator
  const nominal = masterBar.calculateDuration(false)
  const unit = numerator > 0 ? nominal / numerator : 0

  return {
    barIndex: masterBar.index,
    state: fill.state,
    filledTicks: fill.filled,
    capacityTicks: fill.capacity,
    // Rounded to two decimals: a tuplet does not land on a whole beat, and
    // `2.67 / 4` is still readable while the raw float is not.
    beats: unit > 0 ? Math.round((fill.filled / unit) * 100) / 100 : null,
    beatCapacity: unit > 0 ? Math.round((fill.capacity / unit) * 100) / 100 : null,
    numerator,
    denominator: masterBar.timeSignatureDenominator,
  }
}

// ---------------------------------------------------------------------------
// 7e. The octave
// ---------------------------------------------------------------------------

export const OCTAVE_SEMITONES = 12

// Why this cannot be "add or subtract 12 frets", measured on two real files:
//
//   | file                | +12 same string | -12 same string | -12 IMPOSSIBLE |
//   | Le Chant des Forges |            99 % |             2 % |           22 % |
//   | Morbid Angel (.gpx) |            95 % |             7 % |           85 % |
//
// Going up an octave almost always stays on the same string. Going DOWN one is
// physically impossible for most notes - the instrument does not reach that
// low - and on a detuned seven-string it is impossible for 85 % of them. So an
// octave is a change of PITCH with a re-fingering, not a fret arithmetic: aim
// at the same note twelve semitones away, try the current string, then the
// others.
//
// Strings are tried in the direction of travel first, nearest to farthest, then
// back the other way: going up an octave when the fret would run off the neck
// means moving to a HIGHER string, which needs a lower fret for the same pitch.
function stringPreference(current, strings, step) {
  const order = []
  const forward = step > 0 ? 1 : -1
  for (let s = current + forward; s >= 1 && s <= strings; s += forward) order.push(s)
  for (let s = current - forward; s >= 1 && s <= strings; s -= forward) order.push(s)
  return order
}

// Where one note would go, or null when nowhere on this neck can hold it.
//
// The pitch target is computed from `fret + tuningForString(...)` rather than
// from `note.realValue`: both sides of the subtraction then use the same
// convention, so any capo or track transposition cancels out instead of
// having to be reasoned about.
//
// Landing on another string is allowed only onto a string that is EMPTY in this
// beat, even when the note currently there is also part of the batch. That is
// deliberately conservative: it refuses a few placements that a solver could
// find by moving two notes at once, and in exchange no note can ever be dropped
// by two notes claiming one entry of `beat.noteStringLookup` (pitfall 5).
//
// "Empty" has to mean empty AFTER the moves already planned, not just in the
// model as it stands. `claimed` carries those: without it two notes of one chord
// both find the same free string and the second silently erases the first, which
// is exactly what the real-score invariant caught.
function planOctaveMove(note, semitones, claimed) {
  if (!note?.isStringed) return null
  // Pitfall 4: a natural harmonic sounds at its node, not at its fret, so no
  // fret can express a transposition of it.
  if (note.harmonicType === alphaTab.model.HarmonicType.Natural) return null

  const staff = note.beat?.voice?.bar?.staff ?? null
  const strings = staff?.tuning?.length ?? 0
  if (!staff || strings === 0) return null

  // The same string, which is the 95-99 % case going up and needs no lookup.
  const sameString = note.fret + semitones
  if (sameString >= MIN_FRET && sameString <= MAX_FRET) {
    return { note, string: note.string, fret: sameString }
  }

  const target = note.fret + tuningForString(staff.tuning, note.string) + semitones
  for (const string of stringPreference(note.string, strings, semitones)) {
    if (note.beat.getNoteOnString(string) || claimed?.has(string)) continue
    const fret = target - tuningForString(staff.tuning, string)
    if (fret < MIN_FRET || fret > MAX_FRET) continue
    return { note, string, fret }
  }
  return null
}

// Move notes by a whole octave, up or down.
//
// AT ITS BEST, not all or nothing - and this is the ONE exception to the rule
// that holds everywhere else in this file. The reason it is tenable, and the
// reason it does not spread:
//
//   Clipping produces a WRONG value. Not moving keeps a RIGHT one.
//
// A fret transposition that clips leaves a note at fret 0 where it needed -2:
// that note now sounds wrong, and it has lost its interval with its neighbours,
// which is the whole content of a transposition. A note that could not drop an
// octave keeps the pitch it always had. The passage is no longer the passage an
// octave down, but no note carries an incorrect value. So the frets and the
// strings stay all or nothing, and only this is best effort.
//
// `movedCount` and `blockedCount` are facts about what happened, of the same
// kind as the `noteCount` the other operations return - not a fourth result
// state. The score is on screen: a note that did not move is visible, with its
// fret number unchanged, which is a better channel than any flag.
export function shiftNotesOctave(notes, direction) {
  const list = [...(notes ?? [])]
  if (list.length === 0) return refused('No notes selected.')

  const step = Math.sign(Math.round(Number(direction)))
  if (!Number.isFinite(step) || step === 0) return noop({ movedCount: 0, blockedCount: 0 })
  const semitones = step * OCTAVE_SEMITONES

  // One claim set per beat, so two notes of a chord cannot both be sent to the
  // same free string. Notes are visited in the order they were given, so the
  // result is at least deterministic where it cannot be order-independent.
  const claimedByBeat = new Map()
  const moves = []
  for (const note of list) {
    let claimed = claimedByBeat.get(note.beat)
    if (!claimed) {
      claimed = new Set()
      claimedByBeat.set(note.beat, claimed)
    }
    const move = planOctaveMove(note, semitones, claimed)
    if (!move) continue
    claimed.add(move.string)
    moves.push(move)
  }

  const blockedCount = list.length - moves.length
  if (moves.length === 0) {
    return refused(octaveRefusal(list, step), { movedCount: 0, blockedCount })
  }

  // The same two-phase writer the string move uses, in both directions: an undo
  // that puts a chord back has exactly the ordering hazard the move had.
  const from = moves.map(({ note }) => ({ note, string: note.string, fret: note.fret }))
  const to = moves.map(({ note, string, fret }) => ({ note, string, fret }))
  applyNoteStringMoves(moves)

  let next = from
  return applied({
    noteCount: moves.length,
    movedCount: moves.length,
    blockedCount,
    undo: () => {
      applyNoteStringMoves(next)
      next = next === from ? to : from
    },
  })
}

// Why nothing moved. Worded per case, because "one note is too low" and "none of
// these forty notes can move" need different sentences - and because a single
// note is the keyboard's case, where the message is the only feedback.
function octaveRefusal(list, step) {
  const way = step > 0 ? 'up' : 'down'
  if (list.length > 1) {
    return `None of these ${list.length} notes can move ${way} an octave: on this tuning there is no string and fret that reaches ${way === 'up' ? 'that high' : 'that low'}.`
  }

  const note = list[0]
  if (!note?.isStringed) {
    return 'That note has no string: percussion, or a staff without tablature.'
  }
  if (note.harmonicType === alphaTab.model.HarmonicType.Natural) {
    return naturalHarmonicRefusal(1, 'moving by an octave')
  }
  const target = alphaTab.model.Tuning.getTextForTuning(note.realValue + step * OCTAVE_SEMITONES, true)
  const current = alphaTab.model.Tuning.getTextForTuning(note.realValue, true)
  return `${current} cannot move ${way} an octave: ${target} is ${way === 'up' ? 'above' : 'below'} anything this tuning reaches within frets ${MIN_FRET}-${MAX_FRET}.`
}

// One note, which is the keyboard's case. A wrapper for the same reason
// `shiftNoteString` is one: the placement logic must not exist twice.
export function shiftNoteOctave(note, direction) {
  if (!note) return refused('No note selected.')
  return shiftNotesOctave([note], direction)
}

// ---------------------------------------------------------------------------
// 8. Writing: notes, rests, durations and bars
// ---------------------------------------------------------------------------
//
// The line the previous tier held and this one crosses: nothing above this point
// creates or destroys structure, and nothing above it changes a duration. Every
// function below does one or the other, which is why they all end in
// `score.finish()` and why their undo records rebuild rather than restore.

// The duration ladder, longest first.
//
// Duration is a DENOMINATOR, not a length: `Whole` is 1, `Quarter` is 4,
// `Sixteenth` is 16, and the two longer-than-a-bar values are NEGATIVE
// (`DoubleWhole` is -2, `QuadrupleWhole` is -4). So lengthening or shortening a
// note is a step along this ordered list, never arithmetic on the value - which
// is the mistake the ladder exists to make impossible.
export const DURATION_LADDER = [
  alphaTab.model.Duration.QuadrupleWhole,
  alphaTab.model.Duration.DoubleWhole,
  alphaTab.model.Duration.Whole,
  alphaTab.model.Duration.Half,
  alphaTab.model.Duration.Quarter,
  alphaTab.model.Duration.Eighth,
  alphaTab.model.Duration.Sixteenth,
  alphaTab.model.Duration.ThirtySecond,
  alphaTab.model.Duration.SixtyFourth,
  alphaTab.model.Duration.OneHundredTwentyEighth,
  alphaTab.model.Duration.TwoHundredFiftySixth,
]

// Named rather than signed, and that is deliberate.
//
// A number would have to mean either "one step down the ladder" or "twice as
// long", and those are opposite directions: a shorter note has a BIGGER value.
// Every call site would then need the comment this pair of constants makes
// unnecessary.
export const DURATION_SHORTER = 'shorter'
export const DURATION_LONGER = 'longer'

// What a duration is called, for the panel and for a refusal message.
const DURATION_NAMES = new Map([
  [alphaTab.model.Duration.QuadrupleWhole, 'quadruple whole'],
  [alphaTab.model.Duration.DoubleWhole, 'double whole'],
  [alphaTab.model.Duration.Whole, 'whole'],
  [alphaTab.model.Duration.Half, 'half'],
  [alphaTab.model.Duration.Quarter, 'quarter'],
  [alphaTab.model.Duration.Eighth, 'eighth'],
  [alphaTab.model.Duration.Sixteenth, '16th'],
  [alphaTab.model.Duration.ThirtySecond, '32nd'],
  [alphaTab.model.Duration.SixtyFourth, '64th'],
  [alphaTab.model.Duration.OneHundredTwentyEighth, '128th'],
  [alphaTab.model.Duration.TwoHundredFiftySixth, '256th'],
])

export function describeDuration(duration) {
  return DURATION_NAMES.get(duration) ?? String(duration)
}

// The next duration along the ladder, or null at either end.
function nextDuration(duration, direction) {
  const at = DURATION_LADDER.indexOf(duration)
  if (at < 0) return null
  const to = at + (direction === DURATION_SHORTER ? 1 : -1)
  return to >= 0 && to < DURATION_LADDER.length ? DURATION_LADDER[to] : null
}

function scoreOf(node) {
  return node?.voice?.bar?.staff?.track?.score ?? node?.bar?.staff?.track?.score ?? null
}

// 8a. Write a fret at a position: the keyboard's digits.
//
// Two cases, and only the second is structural. A string that already carries a
// note in this beat is a `setNoteFret`, which needs no finish() and no undo
// record of its own; a free string means a new `Note`, which does.
//
// The empty-bar case is the one worth knowing about. alphaTab pads every unwritten
// voice with a placeholder beat carrying `isEmpty = true`
// (`ModelUtils.consolidate`), which is what a whole-bar rest is made of. Writing
// into that beat has to CLEAR the flag, or the note is in the model and nothing
// draws it: `Voice.finish` only ever sets `isEmpty`, never unsets it, and an
// empty voice is skipped by the renderer and by the bar-fill arithmetic alike.
export function writeNoteAtString(beat, string, fret, settings) {
  if (!beat) return refused('No position to write at.')
  if (string == null) {
    return refused('That position has no string: percussion, or a staff without tablature.')
  }

  const staff = beat.voice?.bar?.staff ?? null
  const strings = staff?.tuning?.length ?? 0
  if (strings === 0) return refused('That staff has no strings to write on.')
  if (string < 1 || string > strings) return refused(`There is no string ${string}.`)

  const value = Math.round(Number(fret))
  if (!Number.isFinite(value)) return refused('Enter a fret number.')
  if (value < MIN_FRET || value > MAX_FRET) {
    return refused(`Fret ${value} is outside the ${MIN_FRET}-${MAX_FRET} range.`)
  }

  // The string is taken, so this is a pitch change on a note that already
  // exists. Delegated rather than reimplemented: `setNoteFret` carries the
  // natural-harmonic refusal and the no-op case, and both apply here unchanged.
  const existing = beat.getNoteOnString(string)
  if (existing) {
    const result = setNoteFret(existing, value)
    return result.ok ? { ...result, note: existing, created: false } : result
  }

  const score = scoreOf(beat)
  if (!score) return refused('That position is not attached to a score.')

  const note = new alphaTab.model.Note()
  note.string = string
  note.fret = value

  const wasEmpty = beat.isEmpty

  function attach() {
    beat.addNote(note)
    beat.isEmpty = false
    score.finish(settings ?? null)
  }

  // The way back. `removeNote` deletes the `noteStringLookup` entry and splices
  // the array but does NOT renumber (pitfall in `deleteNotes`), and here the new
  // note is always last, so the survivors keep their indexes and there is
  // nothing to renumber.
  //
  // No whole-staff capture of the state finish() derives, unlike the delete, and
  // the reason is that an ADD cannot disturb it: `Note.finish` only re-resolves a
  // tie whose `tieOrigin` is already null, and every imported tie destination
  // carries one. A test pins the whole link graph of the fixture's Ties track
  // across an add and its undo rather than trusting that argument.
  function detach() {
    beat.removeNote(note)
    beat.isEmpty = wasEmpty
    score.finish(settings ?? null)
  }

  attach()

  let isAttached = true
  return applied({
    note,
    created: true,
    string,
    fret: value,
    undo: () => {
      if (isAttached) detach()
      else attach()
      isAttached = !isAttached
    },
  })
}

// 8b. Longer or shorter, one step along the ladder.
//
// THE DURATION BELONGS TO THE BEAT, not to the note. `duration` is a field of
// `Beat`, so changing "how long this note is" changes the whole chord it sits
// in. That is the musical model rather than a limitation to work around, and it
// is why this function takes beats and never notes.
//
// All or nothing, like every other batch operation here except the octave. A
// beat that could not move while its neighbours did would not leave a wrong
// value behind - so the octave's argument does not apply - but it would leave a
// wrong RHYTHM, which is the whole content of the operation. Same reasoning as
// the fret transposition.
export function stepBeatsDuration(beats, direction, settings) {
  const list = [...new Set(beats ?? [])]
  if (list.length === 0) return refused('No beat selected.')
  if (direction !== DURATION_SHORTER && direction !== DURATION_LONGER) {
    return noop({ beatCount: 0 })
  }

  const score = scoreOf(list[0])
  if (!score) return refused('Those beats are not attached to a score.')

  const moves = []
  const blocked = []
  for (const beat of list) {
    const to = nextDuration(beat.duration, direction)
    if (to === null) blocked.push(beat)
    else moves.push({ target: beat, key: 'duration', value: to })
  }

  if (blocked.length > 0) {
    const edge = direction === DURATION_SHORTER ? 'shortest' : 'longest'
    const name = describeDuration(blocked[0].duration)
    if (list.length === 1) {
      return refused(`A ${name} note is the ${edge} this editor writes.`)
    }
    return refused(
      `${blocked.length} of these ${list.length} beats are already ${name} notes, the ${edge} this editor writes.`,
    )
  }

  // Captured before the write, so the swap has the values to put back.
  const undo = makeFinishingSwap(
    moves.map(({ target, key }) => ({ target, key, value: target[key] })),
    score,
    settings,
  )
  for (const move of moves) move.target[move.key] = move.value
  score.finish(settings ?? null)

  return applied({
    beatCount: moves.length,
    duration: moves[0].value,
    durationName: describeDuration(moves[0].value),
    undo,
  })
}

// 8b bis. The dot, which is the other half of a duration.
//
// A dot is not a separate mark on a note: `beat.dots` is part of how long the
// BEAT lasts, so it belongs beside `stepBeatsDuration` and carries the same two
// consequences. `playbackDuration` is derived from `duration` AND `dots` and is
// stale until `finish()` (pitfall 7) - measured: a quarter reads 960, still 960
// after `dots = 1`, and 1440 after finishing.
//
// A TOGGLE rather than a count, and the choice is measured rather than a guess:
// across the two large real files, 76 of 11738 beats carry a dot and **none**
// carries two. So the key that reaches for a double dot would be spending itself
// on something real music here does not use; `dots` still takes any number, and
// an imported double dot is cleared in one press rather than being stepped
// through.
//
// Mixed selections resolve towards ON: a passage where only some beats are
// dotted becomes uniformly dotted, and the second press clears it. The
// alternative - clearing whenever anything is dotted - makes the first press
// undo work the user can see rather than doing what they asked for.
export function toggleBeatsDot(beats, settings) {
  const list = [...new Set(beats ?? [])]
  if (list.length === 0) return refused('No beat selected.')

  const score = scoreOf(list[0])
  if (!score) return refused('Those beats are not attached to a score.')

  const dots = list.every((beat) => beat.dots > 0) ? 0 : 1
  const moves = list.filter((beat) => beat.dots !== dots)
  if (moves.length === 0) return noop({ beatCount: 0, dots })

  const undo = makeFinishingSwap(
    moves.map((beat) => ({ target: beat, key: 'dots', value: beat.dots })),
    score,
    settings,
  )
  for (const beat of moves) beat.dots = dots
  score.finish(settings ?? null)

  return applied({ beatCount: moves.length, dots, undo })
}

// 8c. A rest, which needs no rest object.
//
// `Beat.isRest` is a getter over `isEmpty || !deadSlapped && notes.length === 0`,
// so a beat with no notes IS a rest of its own duration - the same fact the
// delete already relies on from the other side. Placing one is therefore either
// clearing a flag or inserting a bare `Beat`, and never building anything.
//
// Which of the two depends on what is already there, and the distinction is
// alphaTab's own: a beat carrying `isEmpty` is the placeholder its importer pads
// unwritten voices with, not a rest somebody wrote. Turning that into a real rest
// in place is what "there is nothing here yet" means, and inserting beside it
// would leave the placeholder behind to be counted twice.
export function placeRest(beat, settings) {
  if (!beat) return refused('No position to write at.')
  const voice = beat.voice ?? null
  const score = scoreOf(beat)
  if (!voice || !score) return refused('That position is not attached to a score.')

  // The placeholder case: no insertion, just the flag.
  if (beat.isEmpty) {
    const undo = makeFinishingSwap([{ target: beat, key: 'isEmpty', value: true }], score, settings)
    beat.isEmpty = false
    score.finish(settings ?? null)
    return applied({ beat, inserted: false, duration: beat.duration, undo })
  }

  // A new beat takes the duration of the one it follows, which is what makes a
  // run of them come out even - and it is also where "a quarter by default"
  // comes from with no default anywhere in the code: `new Beat()` is born a
  // quarter, and so are the placeholders alphaTab writes.
  const rest = new alphaTab.model.Beat()
  rest.duration = beat.duration
  rest.dots = beat.dots

  // `insertBeat` links the chain and splices the array but does NOT set
  // `index` - it leaves the list numbered 0,1,0,2,3 - and `Voice.finish` is what
  // renumbers it. Verified in Node against 1.8.4, and it is the reason the
  // finish below is load-bearing rather than tidy.
  function attach() {
    voice.insertBeat(beat, rest)
    score.finish(settings ?? null)
  }

  // No `removeBeat` exists on `Voice`, so the way back is the splice alphaTab
  // would have done, plus the two chain links `insertBeat` wrote.
  function detach() {
    const at = voice.beats.indexOf(rest)
    if (at >= 0) voice.beats.splice(at, 1)
    const previous = rest.previousBeat ?? null
    const next = rest.nextBeat ?? null
    if (previous) previous.nextBeat = next
    if (next) next.previousBeat = previous
    score.finish(settings ?? null)
  }

  attach()

  let isAttached = true
  return applied({
    beat: rest,
    inserted: true,
    duration: rest.duration,
    undo: () => {
      if (isAttached) detach()
      else attach()
      isAttached = !isAttached
    },
  })
}

// Renumber and re-chain every bar of the score, and reset where it starts.
//
// The pass that makes an insertion or a deletion anywhere but the end possible
// at all. `addBar` and `addMasterBar` set `index` from the current length and no
// `finish()` ever renumbers either of them - only `Voice.finish` renumbers, and
// only beats - so a splice in the middle leaves every later bar claiming the
// index it used to have. See gotcha 11.
//
// `masterBars[0].start = 0` is the third thing here and the least obvious.
// `MasterBar.finish` recomputes `start` from the previous bar only `if
// (this.index > 0)`, so a new first bar keeps whatever start it had: measured,
// deleting bar 0 of the fixture left the bars starting at 3840, 7680, 11520 and
// the first beat's `absolutePlaybackStart` at 3840. That field is what the drag
// selection and the loop range are built from, so a stale one breaks selecting a
// passage after the first bar of a score is deleted.
//
// It runs BEFORE `finish()`, which is what makes one finish enough.
function renumberBars(score) {
  score.masterBars.forEach((masterBar, index) => {
    masterBar.index = index
    masterBar.previousMasterBar = score.masterBars[index - 1] ?? null
    masterBar.nextMasterBar = score.masterBars[index + 1] ?? null
  })
  if (score.masterBars.length > 0) score.masterBars[0].start = 0

  for (const track of score.tracks ?? []) {
    for (const staff of track.staves ?? []) {
      staff.bars.forEach((bar, index) => {
        bar.index = index
        bar.previousBar = staff.bars[index - 1] ?? null
        bar.nextBar = staff.bars[index + 1] ?? null
      })
    }
  }

  // The groups are built by appending, so a bar leaving or joining the middle of
  // one has no inverse. Rebuilding them from what is there does.
  score.rebuildRepeatGroups()
}

// One empty `Bar` per staff of every track, shaped like the bar at `reference`.
//
// A bar is not one object: it is a `MasterBar` - the metre, the key, the repeats,
// shared by the whole score - plus a `Bar` on every staff of every track. Adding
// one to a single track desynchronises the score.
//
// Each voice gets the placeholder beat alphaTab's own `ModelUtils.consolidate`
// gives an unwritten voice. `isEmpty` is what makes it a whole-bar rest rather
// than a beat somebody wrote.
function makeBarsLike(score, reference) {
  const made = []
  for (const track of score.tracks ?? []) {
    for (const staff of track.staves ?? []) {
      const bar = new alphaTab.model.Bar()
      // By hand, because these bars are SPLICED in rather than appended, so
      // `Staff.addBar` - which is what normally sets this - never runs. Without
      // it `Beat.finish` throws on `this.voice.bar.staff.index`, which is the
      // first thing that ever reads it.
      bar.staff = staff
      const like = staff.bars?.[reference] ?? null
      if (like) {
        bar.clef = like.clef
        bar.clefOttava = like.clefOttava
        bar.keySignature = like.keySignature
        bar.keySignatureType = like.keySignatureType
      }
      const voiceCount = Math.max(1, like?.voices?.length ?? 1)
      for (let i = 0; i < voiceCount; i += 1) {
        const voice = new alphaTab.model.Voice()
        bar.addVoice(voice)
        const beat = new alphaTab.model.Beat()
        beat.isEmpty = true
        voice.addBeat(beat)
      }
      made.push({ staff, bar })
    }
  }
  return made
}

// 8d. One more bar, at the end of the score.
//
// The cheap case, and the reason it is kept separate from the insertion below:
// `addMasterBar` and `addBar` set `index` from the current length, compute
// `start` from the previous bar and file the new bar into the open repeat group,
// so at the END of the score alphaTab's own methods do everything and no
// renumbering pass is needed.
export function appendBar(score, settings) {
  const masterBars = score?.masterBars ?? []
  if (masterBars.length === 0) return refused('This score has no bars to add one after.')

  const previous = masterBars[masterBars.length - 1]

  const masterBar = new alphaTab.model.MasterBar()
  // The time signature carries over: a new bar at the end of a piece is in the
  // metre the piece is in, and `new MasterBar()` would silently assume 4/4.
  masterBar.timeSignatureNumerator = previous.timeSignatureNumerator
  masterBar.timeSignatureDenominator = previous.timeSignatureDenominator
  masterBar.timeSignatureCommon = previous.timeSignatureCommon
  masterBar.tripletFeel = previous.tripletFeel

  // The bars themselves, one per staff, built once here and re-attached by the
  // undo rather than rebuilt.
  //
  // `voices` matches the staff's previous bar: a two-voice piece stays a
  // two-voice piece, and every voice gets the placeholder beat alphaTab's own
  // `consolidate` gives an unwritten voice. `isEmpty` is what makes it a
  // whole-bar rest rather than a beat somebody wrote.
  const staffBars = []
  for (const track of score.tracks ?? []) {
    for (const staff of track.staves ?? []) {
      const bar = new alphaTab.model.Bar()
      const last = staff.bars?.[staff.bars.length - 1] ?? null
      if (last) {
        bar.clef = last.clef
        bar.clefOttava = last.clefOttava
        bar.keySignature = last.keySignature
        bar.keySignatureType = last.keySignatureType
      }
      const voiceCount = Math.max(1, last?.voices?.length ?? 1)
      for (let i = 0; i < voiceCount; i += 1) {
        const voice = new alphaTab.model.Voice()
        bar.addVoice(voice)
        const beat = new alphaTab.model.Beat()
        beat.isEmpty = true
        voice.addBeat(beat)
      }
      staffBars.push({ staff, bar })
    }
  }

  function attach() {
    // `addMasterBar` also computes `start` from the previous bar and files the
    // bar into the repeat groups, so re-running it on the same object is the
    // correct re-attach and not a shortcut.
    score.addMasterBar(masterBar)
    for (const { staff, bar } of staffBars) staff.addBar(bar)
    score.finish(settings ?? null)
  }

  // No `removeMasterBar` and no `removeBar` exist, so the way back pops both
  // lists and cuts the forward links `add*` wrote. The indexes need no repair
  // because only the last element ever goes.
  //
  // `rebuildRepeatGroups()` is the one part that is not a mirror image: the
  // groups are built by appending, so removing a bar from the middle of a group
  // has no inverse - rebuilding them from what is left does.
  function detach() {
    if (score.masterBars[score.masterBars.length - 1] === masterBar) score.masterBars.pop()
    if (masterBar.previousMasterBar) masterBar.previousMasterBar.nextMasterBar = null
    score.rebuildRepeatGroups()
    for (const { staff, bar } of staffBars) {
      if (staff.bars[staff.bars.length - 1] === bar) staff.bars.pop()
      if (bar.previousBar) bar.previousBar.nextBar = null
    }
    score.finish(settings ?? null)
  }

  attach()

  let isAttached = true
  return applied({
    barIndex: masterBar.index,
    barCount: score.masterBars.length,
    staffCount: staffBars.length,
    numerator: masterBar.timeSignatureNumerator,
    denominator: masterBar.timeSignatureDenominator,
    undo: () => {
      if (isAttached) detach()
      else attach()
      isAttached = !isAttached
    },
  })
}

// ---------------------------------------------------------------------------
// 9. Whole tracks: adding one, and duplicating one
// ---------------------------------------------------------------------------

// Every field each level of the model carries, taken from alphaTab's OWN
// cloners and serialisers rather than written from memory.
//
// The cloners exist in the bundle and are unreachable: `NoteCloner`,
// `BeatCloner` and the leaf ones are absent from the `.d.ts` and from every
// public namespace (`model.NoteCloner` is `undefined`, and a sweep of the
// namespaces finds none). So a duplicate has to clone by hand, and the lists
// below are transcribed from their source - which is the authority, since the
// `@clone_ignore` annotations are exactly what they encode.
//
// For the levels that have no cloner at all - Voice, Bar, Staff, Track - the
// list comes from alphaTab's SERIALIZERS, which are what `JsonConverter` writes
// and therefore alphaTab's own answer to "what on this class is data".
//
// Guessing is not an option: a plausible-looking field list threw
// `TypeError: Cannot set property isTieOrigin of #<Note> which has only a
// getter`, because `isTieOrigin` is a getter and `NoteCloner` deliberately skips
// it. None of the 34 it does copy is read-only.
const NOTE_CLONE_FIELDS = [
  'index', 'accentuated', 'bendType', 'bendStyle', 'isContinuedBend', 'fret',
  'string', 'showStringNumber', 'octave', 'tone', 'percussionArticulation',
  'isVisible', 'isLeftHandTapped', 'isHammerPullOrigin', 'isSlurDestination',
  'harmonicType', 'harmonicValue', 'isGhost', 'isLetRing', 'isPalmMute',
  'isDead', 'isStaccato', 'slideInType', 'slideOutType', 'vibrato',
  'isTieDestination', 'leftHandFinger', 'rightHandFinger', 'trillValue',
  'trillSpeed', 'durationPercent', 'accidentalMode', 'dynamics', 'ornament',
]

const BEAT_CLONE_FIELDS = [
  'index', 'isEmpty', 'whammyStyle', 'ottava', 'isLegatoOrigin', 'duration',
  'isLetRing', 'isPalmMute', 'dots', 'fade', 'pop', 'slap', 'tap', 'text',
  'slashed', 'deadSlapped', 'brushType', 'brushDuration', 'tupletDenominator',
  'tupletNumerator', 'isContinuedWhammy', 'whammyBarType', 'vibrato', 'chordId',
  'graceType', 'pickStroke', 'crescendo', 'displayStart', 'playbackStart',
  'displayDuration', 'playbackDuration', 'overrideDisplayDuration', 'golpe',
  'dynamics', 'invertBeamDirection', 'preferredBeamDirection',
  'isEffectSlurOrigin', 'beamingMode', 'wahPedal', 'barreFret', 'barreShape',
  'rasgueado', 'showTimer', 'timer',
]

const BAR_CLONE_FIELDS = [
  'clef', 'clefOttava', 'simileMark', 'displayScale', 'displayWidth',
  'barLineLeft', 'barLineRight', 'keySignature', 'keySignatureType',
  'barNumberDisplay',
]

const STAFF_CLONE_FIELDS = [
  'capo', 'transpositionPitch', 'displayTranspositionPitch', 'showSlash',
  'showNumbered', 'showTablature', 'showStandardNotation', 'isPercussion',
  'standardNotationLineCount',
]

const TRACK_CLONE_FIELDS = [
  'name', 'shortName', 'isVisibleOnMultiTrack', 'defaultSystemsLayout',
  'systemsLayout',
]

// The channels are deliberately NOT here: a duplicate needs its own pair, or the
// two tracks share a midi channel and a program change on one silently
// re-voices the other - which is the mixer gotcha this file already documents
// from the other side.
const PLAYBACK_CLONE_FIELDS = [
  'volume', 'balance', 'port', 'program', 'bank', 'isMute', 'isSolo',
]

function copyFields(from, to, fields) {
  for (const field of fields) to[field] = from[field]
  return to
}

function cloneBendPoint(point) {
  const clone = new alphaTab.model.BendPoint()
  clone.offset = point.offset
  clone.value = point.value
  return clone
}

function cloneAutomation(automation) {
  const clone = new alphaTab.model.Automation()
  copyFields(automation, clone, ['isLinear', 'type', 'value', 'ratioPosition', 'text', 'isVisible'])
  return clone
}

function cloneNote(note) {
  const clone = copyFields(note, new alphaTab.model.Note(), NOTE_CLONE_FIELDS)
  // A plain assignment would SHARE the array: measured, `clone.bendPoints ===
  // original.bendPoints`, so editing one note's bend would edit the other's.
  if (note.bendPoints) {
    clone.bendPoints = []
    for (const point of note.bendPoints) clone.addBendPoint(cloneBendPoint(point))
  }
  return clone
}

function cloneBeat(beat) {
  const clone = copyFields(beat, new alphaTab.model.Beat(), BEAT_CLONE_FIELDS)
  clone.notes = []
  for (const note of beat.notes) clone.addNote(cloneNote(note))
  clone.automations = []
  for (const automation of beat.automations) clone.automations.push(cloneAutomation(automation))
  clone.lyrics = beat.lyrics ? beat.lyrics.slice() : null
  clone.whammyBarPoints = []
  for (const point of beat.whammyBarPoints ?? []) clone.addWhammyBarPoint(cloneBendPoint(point))
  if (beat.tremoloPicking) {
    const tremolo = new alphaTab.model.TremoloPickingEffect()
    tremolo.marks = beat.tremoloPicking.marks
    tremolo.style = beat.tremoloPicking.style
    clone.tremoloPicking = tremolo
  }
  return clone
}

function cloneBar(bar) {
  const clone = copyFields(bar, new alphaTab.model.Bar(), BAR_CLONE_FIELDS)
  for (const voice of bar.voices) {
    const voiceClone = new alphaTab.model.Voice()
    clone.addVoice(voiceClone)
    for (const beat of voice.beats) voiceClone.addBeat(cloneBeat(beat))
  }
  return clone
}

function cloneStaff(staff) {
  const clone = copyFields(staff, new alphaTab.model.Staff(), STAFF_CLONE_FIELDS)
  clone.stringTuning.tunings = [...(staff.stringTuning?.tunings ?? [])]
  clone.stringTuning.name = staff.stringTuning?.name ?? ''
  // Chord definitions are keyed by an id the beats refer to through `chordId`,
  // so they have to come along or every chord diagram in the copy points at
  // nothing.
  if (staff.chords) {
    for (const [id, chord] of staff.chords) clone.addChord(id, chord)
  }
  for (const bar of staff.bars) clone.addBar(cloneBar(bar))
  return clone
}

// 8e. A whole track.
//
// The cheapest structural delete in this file, and the measurement is the reason:
// **no note link crosses a track**. Counted on the fixture and the two large
// real files - 0 of them, out of the 106 and 191 that cross a bar line - which
// follows from how `finish()` resolves links at all, by walking `nextBeat` and
// `previousBeat`, neither of which ever leaves a staff.
//
// So there is no link sweep and no derived capture here, unlike `deleteBars`
// which needs both. A splice and a renumber is exact, and the .gp round trip
// after an undo is what says so.
//
// `track.index` has to be renumbered for the same reason a bar's does: `addTrack`
// sets it from the current length and no `finish()` ever touches it again, while
// every descriptor in the UI, every `trackAt` lookup and every `RenderHint` is
// keyed on it.
//
// One consequence worth knowing rather than guarding: `MasterBar.keySignature`
// is a getter over `score.tracks[0].staves[0].bars[index]`, so deleting the
// FIRST track makes the score report the key signature of whatever track is
// first afterwards. That is alphaTab's own definition of a score's key rather
// than something to work around.
export function deleteTrack(score, index) {
  const tracks = score?.tracks ?? []
  if (tracks.length === 0) return refused('This score has no tracks.')

  const at = Math.round(Number(index))
  if (!Number.isFinite(at) || at < 0 || at >= tracks.length) {
    return refused('That is not a track of this score.')
  }
  if (tracks.length === 1) {
    return refused('This is the only track left: a score cannot have none.')
  }

  const track = tracks[at]
  const name = track.name?.trim() || `Track ${at + 1}`
  let noteCount = 0
  for (const staff of track.staves ?? []) {
    for (const bar of staff.bars ?? []) {
      for (const voice of bar.voices ?? []) {
        for (const beat of voice.beats ?? []) noteCount += beat.notes?.length ?? 0
      }
    }
  }

  function renumber() {
    score.tracks.forEach((t, i) => {
      t.index = i
    })
  }

  function detach() {
    const where = score.tracks.indexOf(track)
    if (where >= 0) score.tracks.splice(where, 1)
    renumber()
  }

  // The Track object is still alive and still points at its score, so this is a
  // re-attach rather than a reconstruction - the same as every other structural
  // undo here.
  function attach() {
    score.tracks.splice(Math.min(at, score.tracks.length), 0, track)
    track.score = score
    renumber()
  }

  detach()

  let isDetached = true
  return applied({
    trackIndex: at,
    trackName: name,
    noteCount,
    staffCount: track.staves?.length ?? 0,
    trackCount: score.tracks.length,
    undo: () => {
      if (isDetached) attach()
      else detach()
      isDetached = !isDetached
    },
  })
}

// The next midi channel pair nothing is using.
//
// Sharing a channel is not cosmetic: the program change one track writes would
// re-voice the other, which is the same collision `trackSound.js` documents from
// the other side. Channel 9 is the percussion channel and is never handed out.
function freeChannelPair(score) {
  const used = new Set([alphaTab.model.SynthConstants?.PercussionChannel ?? 9])
  for (const track of score.tracks ?? []) {
    used.add(track.playbackInfo.primaryChannel)
    used.add(track.playbackInfo.secondaryChannel)
  }
  let primary = 0
  while (used.has(primary)) primary += 1
  used.add(primary)
  let secondary = primary + 1
  while (used.has(secondary)) secondary += 1
  return { primary, secondary }
}

// One empty Bar per master bar, for a staff that has none yet.
function fillStaffWithEmptyBars(score, staff) {
  for (let i = 0; i < (score.masterBars?.length ?? 0); i += 1) {
    const bar = new alphaTab.model.Bar()
    staff.addBar(bar)
    const previous = bar.previousBar
    if (previous) {
      bar.clef = previous.clef
      bar.clefOttava = previous.clefOttava
      bar.keySignature = previous.keySignature
      bar.keySignatureType = previous.keySignatureType
    }
    const voice = new alphaTab.model.Voice()
    bar.addVoice(voice)
    const beat = new alphaTab.model.Beat()
    beat.isEmpty = true
    voice.addBeat(beat)
  }
}

// The tunings a NEW track can be given, which is not the same question
// `tuningChoices` answers.
//
// That one takes an existing staff and offers the presets for ITS string count,
// plus its own tuning when it matches none. A track that does not exist yet has
// no string count, so the choice of tuning IS the choice of how many strings it
// has - and the list is every preset alphaTab knows, in string-count order.
//
// Counted: 11 presets for 4 strings, 6 for 5, 31 for 6, 1 for 7 and none for 8.
// So eight strings is not offered, because alphaTab has nothing to offer for it.
export function newTrackTunings() {
  const choices = []
  for (const count of [4, 5, 6, 7]) {
    for (const preset of alphaTab.model.Tuning.getPresetsFor(count)) {
      choices.push({ name: preset.name, tunings: [...preset.tunings], stringCount: count })
    }
  }
  return choices
}

// 9a. A new, empty track.
//
// A track is not one object either: it needs a `Staff`, and that staff needs one
// `Bar` per master bar of the score - otherwise it is short and the score is
// ragged, which is the shape `ModelUtils.consolidate` exists to repair.
//
// `displayTranspositionPitch` defaults to -12 because every tuning offered is a
// fretted instrument, and Guitar Pro writes those an octave above where they
// sound: measured on the real files, every guitar and bass staff carries -12 and
// only the flute, choir and violin staves carry 0. Prefilling from an existing
// track copies its value instead, so a non-fretted source stays right.
export function addTrack(score, spec, settings) {
  if (!score?.tracks) return refused('No score to add a track to.')
  if (!score.masterBars?.length) return refused('This score has no bars.')

  const name = String(spec?.name ?? '').trim() || `Track ${score.tracks.length + 1}`
  const tunings = [...(spec?.tunings ?? [])]
  if (tunings.length === 0) return refused('Choose a tuning for the new track.')

  const program = Math.round(Number(spec?.program ?? 25))
  if (!Number.isFinite(program) || program < 0 || program > 127) {
    return refused('That is not a General MIDI program number.')
  }

  const track = new alphaTab.model.Track()
  track.name = name
  track.shortName = name.slice(0, 10)
  track.playbackInfo.program = program
  const channels = freeChannelPair(score)
  track.playbackInfo.primaryChannel = channels.primary
  track.playbackInfo.secondaryChannel = channels.secondary

  const staff = new alphaTab.model.Staff()
  staff.showStandardNotation = true
  staff.showTablature = true
  staff.stringTuning.tunings = tunings
  staff.displayTranspositionPitch = spec?.displayTranspositionPitch ?? -12
  track.addStaff(staff)

  function attach() {
    score.addTrack(track)
    fillStaffWithEmptyBars(score, staff)
    score.finish(settings ?? null)
  }

  function detach() {
    const at = score.tracks.indexOf(track)
    if (at >= 0) score.tracks.splice(at, 1)
    // The bars go with it, so a re-attach starts from an empty staff rather
    // than doubling them.
    staff.bars = []
    score.tracks.forEach((t, i) => {
      t.index = i
    })
    score.finish(settings ?? null)
  }

  attach()

  let isAttached = true
  return applied({
    track,
    trackIndex: track.index,
    trackName: name,
    trackCount: score.tracks.length,
    stringCount: tunings.length,
    undo: () => {
      if (isAttached) detach()
      else attach()
      isAttached = !isAttached
    },
  })
}

// 9b. A copy of a track, notes and all, placed straight after it.
//
// The clone is built from alphaTab's own field lists (see NOTE_CLONE_FIELDS) and
// carries no reference into the original, which is what `@clone_ignore` means on
// the eleven cross-note links: they are rebuilt rather than copied.
//
// REBUILT EXPLICITLY, not left to `finish()`. `Note.finish` re-resolves a tie
// whose origin is null by looking for a note on the same string in the preceding
// bars, and that is a guess: on a duplicate it would usually find the right note
// and sometimes not. Every link's other end is inside the copy, so mapping
// original to clone and remapping the eleven fields is exact - and a test
// compares the copy's whole link graph against the original's.
export function duplicateTrack(score, index, settings) {
  const tracks = score?.tracks ?? []
  const at = Math.round(Number(index))
  if (!Number.isFinite(at) || at < 0 || at >= tracks.length) {
    return refused('That is not a track of this score.')
  }

  const source = tracks[at]
  const track = copyFields(source, new alphaTab.model.Track(), TRACK_CLONE_FIELDS)
  track.name = `${source.name} copy`
  track.shortName = track.name.slice(0, 10)
  copyFields(source.playbackInfo, track.playbackInfo, PLAYBACK_CLONE_FIELDS)
  const channels = freeChannelPair(score)
  track.playbackInfo.primaryChannel = channels.primary
  track.playbackInfo.secondaryChannel = channels.secondary
  if (source.color) track.color = source.color
  if (source.percussionArticulations?.length) {
    track.percussionArticulations = [...source.percussionArticulations]
  }

  for (const staff of source.staves) track.addStaff(cloneStaff(staff))

  // original -> clone, note by note and beat by beat, in the order both trees
  // are walked. The trees are congruent by construction, so a single walk of
  // each in step is enough and needs no keys.
  const noteMap = new Map()
  const beatMap = new Map()
  source.staves.forEach((staff, si) => {
    staff.bars.forEach((bar, bi) => {
      bar.voices.forEach((voice, vi) => {
        voice.beats.forEach((beat, bti) => {
          const copy = track.staves[si]?.bars[bi]?.voices[vi]?.beats[bti]
          if (!copy) return
          beatMap.set(beat, copy)
          beat.notes.forEach((note, ni) => {
            const noteCopy = copy.notes[ni]
            if (noteCopy) noteMap.set(note, noteCopy)
          })
        })
      })
    })
  })

  // The eleven links, remapped. A link whose other end is somehow outside the
  // track is dropped rather than left pointing into the original - that is what
  // an autonomous copy means, and no such link exists in practice: measured,
  // zero note links cross a track on the fixture or on either large real file.
  for (const [note, copy] of noteMap) {
    for (const field of NOTE_LINK_FIELDS) {
      const other = note[field]
      copy[field] = other ? (noteMap.get(other) ?? null) : null
    }
  }
  for (const [beat, copy] of beatMap) {
    copy.effectSlurOrigin = beat.effectSlurOrigin
      ? (beatMap.get(beat.effectSlurOrigin) ?? null)
      : null
    copy.effectSlurDestination = beat.effectSlurDestination
      ? (beatMap.get(beat.effectSlurDestination) ?? null)
      : null
  }

  let noteCount = 0
  for (const staff of track.staves) {
    for (const bar of staff.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) noteCount += beat.notes.length
      }
    }
  }

  // Straight after the original, which is where a copy belongs - and the reason
  // this needs the renumbering pass that appending would not.
  const to = at + 1

  function attach() {
    score.tracks.splice(to, 0, track)
    track.score = score
    score.tracks.forEach((t, i) => {
      t.index = i
    })
    score.finish(settings ?? null)
  }

  function detach() {
    const where = score.tracks.indexOf(track)
    if (where >= 0) score.tracks.splice(where, 1)
    score.tracks.forEach((t, i) => {
      t.index = i
    })
    score.finish(settings ?? null)
  }

  attach()

  let isAttached = true
  return applied({
    track,
    trackIndex: to,
    trackName: track.name,
    sourceName: source.name,
    noteCount,
    trackCount: score.tracks.length,
    undo: () => {
      if (isAttached) detach()
      else attach()
      isAttached = !isAttached
    },
  })
}

// 8f. A bar in the MIDDLE of the score.
//
// Everything the append does, plus the renumbering pass - see `renumberBars`,
// and gotcha 11 for why alphaTab cannot do it for us.
//
// The new bar is shaped like the bar BEFORE the insertion point rather than like
// the one it displaces, which is the conservative choice at a metre or key
// change: copying the displaced bar's signature would move where that change is
// drawn one bar earlier. Inserting before bar 0 has no previous bar, so there it
// is the displaced one.
//
// THE TEMPO IS THE TRAP AT INDEX 0. `Score.tempo` is a getter over
// `masterBars[0].tempoAutomations[0].value`, falling back to 120 - so a new first
// bar with no automation silently drops the whole score to 120. Measured: a
// score at 168 read back 168 before and 120 after. The automations therefore
// MOVE onto the new first bar, which also keeps the tempo marking drawn at the
// start of the piece where it belongs.
export function insertBarBefore(score, index, settings) {
  const masterBars = score?.masterBars ?? []
  if (masterBars.length === 0) return refused('This score has no bars.')
  const at = Math.round(Number(index))
  if (!Number.isFinite(at) || at < 0 || at >= masterBars.length) {
    return refused(`There is no bar ${at + 1} to insert before.`)
  }

  const like = masterBars[at - 1] ?? masterBars[at]
  const masterBar = new alphaTab.model.MasterBar()
  masterBar.score = score
  masterBar.timeSignatureNumerator = like.timeSignatureNumerator
  masterBar.timeSignatureDenominator = like.timeSignatureDenominator
  masterBar.timeSignatureCommon = like.timeSignatureCommon
  masterBar.tripletFeel = like.tripletFeel

  const staffBars = makeBarsLike(score, at > 0 ? at - 1 : at)

  // Only when the new bar becomes the first one. `tempoAutomations` is a plain
  // array, so this is a move of the array itself and its undo is the move back.
  const displacedFirst = at === 0 ? masterBars[0] : null
  const movedTempo = displacedFirst?.tempoAutomations ?? null

  function attach() {
    score.masterBars.splice(at, 0, masterBar)
    for (const { staff, bar } of staffBars) staff.bars.splice(at, 0, bar)
    if (displacedFirst) {
      masterBar.tempoAutomations = movedTempo
      displacedFirst.tempoAutomations = []
    }
    renumberBars(score)
    score.finish(settings ?? null)
  }

  function detach() {
    const where = score.masterBars.indexOf(masterBar)
    if (where >= 0) score.masterBars.splice(where, 1)
    for (const { staff, bar } of staffBars) {
      const at2 = staff.bars.indexOf(bar)
      if (at2 >= 0) staff.bars.splice(at2, 1)
    }
    if (displacedFirst) {
      displacedFirst.tempoAutomations = movedTempo
      masterBar.tempoAutomations = []
    }
    renumberBars(score)
    score.finish(settings ?? null)
  }

  attach()

  let isAttached = true
  return applied({
    barIndex: at,
    barCount: score.masterBars.length,
    staffCount: staffBars.length,
    numerator: masterBar.timeSignatureNumerator,
    denominator: masterBar.timeSignatureDenominator,
    undo: () => {
      if (isAttached) detach()
      else attach()
      isAttached = !isAttached
    },
  })
}

// 8g. Take bars out.
//
// The most destructive operation here, and the one that needed the most care,
// because it is `deleteNotes` and `insertBarBefore` at the same time:
//
//  1. Every note in the removed bars goes, so every cross-note link POINTING AT
//     one of them has to be nulled - a link to a deleted note survives
//     `finish()` (gotcha 6). Not hypothetical across a bar line: measured, two
//     of the real test files carry 106 and 191 links that cross one, mostly ties
//     and bend origins.
//  2. Everything `finish()` derives has to be captured, for the same reason the
//     note delete captures it: `finish()` CREATES links as well as clearing
//     them, so restoring only the cuts leaves a note carrying a tie it never
//     had. Every staff loses a bar here, so the capture is the whole score -
//     about 0.9MB on the largest test file, against 18.6MB for a snapshot of it.
//  3. The renumbering pass, plus the tempo move when the first bar goes.
//
// A score must keep at least one bar: alphaTab renders `masterBars.length` bars
// and `ModelUtils.consolidate` exists to put one back, so an empty score is a
// state to refuse rather than to produce.
export function deleteBars(score, from, to, settings) {
  const masterBars = score?.masterBars ?? []
  if (masterBars.length === 0) return refused('This score has no bars.')

  const first = Math.round(Number(from))
  const last = Math.round(Number(to ?? from))
  if (!Number.isFinite(first) || !Number.isFinite(last) || first < 0 || last >= masterBars.length) {
    return refused('That is not a range of bars in this score.')
  }
  const start = Math.min(first, last)
  const end = Math.max(first, last)
  const count = end - start + 1
  if (count >= masterBars.length) {
    return refused(
      count === 1
        ? 'This is the only bar left: a score cannot have none.'
        : `Those are all ${count} bars of the score, and a score cannot have none.`,
    )
  }

  const removedMasters = masterBars.slice(start, end + 1)
  const removedBars = []
  const victims = new Set()
  let noteCount = 0
  for (const track of score.tracks ?? []) {
    for (const staff of track.staves ?? []) {
      for (const bar of staff.bars.slice(start, end + 1)) {
        removedBars.push({ staff, bar })
        for (const voice of bar.voices ?? []) {
          for (const beat of voice.beats ?? []) {
            for (const note of beat.notes ?? []) {
              victims.add(note)
              noteCount += 1
            }
          }
        }
      }
    }
  }

  // Everything finish() may re-derive, for every note that SURVIVES. Captured
  // before the write, restored before the finish that follows a re-attach.
  const derived = []
  for (const note of everyNote(score)) {
    if (victims.has(note)) continue
    const state = {}
    for (const field of NOTE_LINK_FIELDS) state[field] = note[field]
    for (const field of NOTE_DERIVED_FIELDS) state[field] = note[field]
    derived.push({ note, state })
  }

  // The tempo, when the first bar of the score is one of the ones going. The
  // survivor keeps its own automations if it has any - it really is a tempo
  // change at that point - and inherits otherwise, so the piece goes on sounding
  // at the tempo that was in force where it now starts.
  const survivor = masterBars[end + 1] ?? null
  const inheritsTempo =
    start === 0 && survivor && (survivor.tempoAutomations?.length ?? 0) === 0
      ? { survivor, automations: removedMasters[0].tempoAutomations }
      : null

  function detach() {
    score.masterBars.splice(start, count)
    for (const { staff, bar } of removedBars) {
      const at = staff.bars.indexOf(bar)
      if (at >= 0) staff.bars.splice(at, 1)
    }
    // The link sweep walks what is LEFT, which is what makes it provably
    // complete: several of these fields have no inverse to follow back.
    for (const note of everyNote(score)) {
      for (const field of NOTE_LINK_FIELDS) {
        if (victims.has(note[field])) note[field] = null
      }
    }
    if (inheritsTempo) {
      inheritsTempo.survivor.tempoAutomations = inheritsTempo.automations
      removedMasters[0].tempoAutomations = []
    }
    renumberBars(score)
    score.finish(settings ?? null)
  }

  function attach() {
    score.masterBars.splice(start, 0, ...removedMasters)
    // Ascending original index per staff, so each splice lands in a slot the
    // earlier ones have already made room for.
    const byStaff = new Map()
    for (const entry of removedBars) {
      if (!byStaff.has(entry.staff)) byStaff.set(entry.staff, [])
      byStaff.get(entry.staff).push(entry.bar)
    }
    for (const [staff, bars] of byStaff) staff.bars.splice(start, 0, ...bars)
    if (inheritsTempo) {
      removedMasters[0].tempoAutomations = inheritsTempo.automations
      inheritsTempo.survivor.tempoAutomations = []
    }
    // Before the finish, not after: finish() would overwrite it, and its own
    // caches have to be built from the restored values.
    for (const entry of derived) Object.assign(entry.note, entry.state)
    renumberBars(score)
    score.finish(settings ?? null)
  }

  detach()

  let isDetached = true
  return applied({
    barIndex: start,
    barCount: count,
    noteCount,
    staffCount: removedBars.length,
    undo: () => {
      if (isDetached) attach()
      else detach()
      isDetached = !isDetached
    },
  })
}
