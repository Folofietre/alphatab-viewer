import * as alphaTab from '@coderline/alphatab'

// Change the MIDI program (the "sound") of a track in the data model.
//
// Setting `track.playbackInfo.program` alone is NOT enough. Guitar Pro files
// carry a mixer snapshot as an `AutomationType.Instrument` automation on the
// first beat of each track, and alphaTab's midi generator emits that automation
// as a second ProgramChange at tick 0, right after the one derived from
// playbackInfo. The automation therefore wins and the original sound comes
// back. Verified against a real .gp file: with the automation left untouched,
// the generated midi contains `ch=2 prog=73` immediately followed by
// `ch=2 prog=27`.
//
// So: write playbackInfo AND rewrite every Instrument automation on the track.
// Automations placed mid-song (a genuine instrument change written into the
// score) are overwritten too — that is intentional, the user picked one sound
// for the whole track.
//
// The caller must still call `api.loadMidiForScore()` afterwards; the midi is
// only generated from the model on demand.
export function applyTrackProgram(track, program) {
  if (!track || track.isPercussion) return false

  track.playbackInfo.program = program

  for (const staff of track.staves ?? []) {
    for (const bar of staff.bars ?? []) {
      for (const voice of bar.voices ?? []) {
        for (const beat of voice.beats ?? []) {
          for (const automation of beat.automations ?? []) {
            if (automation.type === alphaTab.model.AutomationType.Instrument) {
              automation.value = program
            }
          }
        }
      }
    }
  }
  return true
}
