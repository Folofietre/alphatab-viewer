import * as alphaTab from '@coderline/alphatab'

// Track mixer values that live in the DATA MODEL rather than in the synth.
//
// alphaTab exposes live setters for volume, mute, solo and transposition
// (`changeTrackVolume` and friends), but NOT for the midi program or the
// balance. Those two are only read while the midi is generated from the score,
// so changing them means editing the model and then calling
// `api.loadMidiForScore()`.
//
// And editing `track.playbackInfo` alone is not enough. Guitar Pro files carry
// a mixer snapshot as automations on the first beat of each track, and
// alphaTab's generator emits those automations as a second event at tick 0,
// right after the one derived from playbackInfo, so the file's value wins.
// Verified on a real .gp: setting program 73 with the automation untouched
// produced `ch=2 prog=73` immediately followed by `ch=2 prog=27`.
//
// So every writer here does both: playbackInfo, and every matching automation.
// Automations placed mid-song (a genuine change written into the score) are
// overwritten too. That is intentional, the user picked one value for the whole
// track.
function overwriteAutomations(track, type, value) {
  for (const staff of track.staves ?? []) {
    for (const bar of staff.bars ?? []) {
      for (const voice of bar.voices ?? []) {
        for (const beat of voice.beats ?? []) {
          for (const automation of beat.automations ?? []) {
            if (automation.type === type) automation.value = value
          }
        }
      }
    }
  }
}

// MIDI program, 0-127. Percussion is driven by the drum channel rather than a
// program number, so it is rejected.
export function applyTrackProgram(track, program) {
  if (!track || track.isPercussion) return false
  track.playbackInfo.program = program
  overwriteAutomations(track, alphaTab.model.AutomationType.Instrument, program)
  return true
}

// Stereo balance, 0-16 with 8 = centre, as stored by the model. alphaTab turns
// it into a MIDI PanCoarse controller value of `balance * 8`, clamped to 127
// (verified: balance 16 emits pan 127, not 128).
//
// Percussion pans like anything else, so it is allowed here.
//
// The Balance automation is rewritten defensively: no .gp tested so far carries
// one, but Instrument automations do exist and behave exactly this way, and the
// cost of covering it is one argument.
export function applyTrackBalance(track, balance) {
  if (!track) return false
  track.playbackInfo.balance = balance
  overwriteAutomations(track, alphaTab.model.AutomationType.Balance, balance)
  return true
}
