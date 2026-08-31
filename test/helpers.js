import * as alphaTab from '@coderline/alphatab'
import fs from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

// Everything the edit tests need to touch a real score in Node: no browser, no
// AlphaTabApi, just the importer, the model and the exporter.
//
// A FRESH score per test, always. These tests mutate the model in place, so a
// shared instance would make them order-dependent - and the point of the
// round-trip assertions is that each one starts from a known state.

export const settings = new alphaTab.Settings()

export const fixturePath = fileURLToPath(new URL('./fixtures/sample.gp', import.meta.url))

// The committed fixture, whose contents scoreEdits.test.js asserts against by
// name and by index. See fixtures/make-sample.mjs for what is in it and why.
export function loadFixture() {
  return loadFile(fixturePath)
}

export function loadFile(path) {
  return loadBytes(fs.readFileSync(path))
}

export function loadBytes(bytes) {
  return alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(bytes), settings)
}

// Export to .gp and read it straight back. This is the assertion that actually
// matters for an editor: an edit that does not survive a save is not an edit.
export function roundTrip(score) {
  return loadBytes(new alphaTab.exporter.Gp7Exporter().export(score, settings))
}

// A flat snapshot of everything the edits can touch, so a round trip can be
// checked with one deepEqual instead of a walk per property.
export function snapshotTrack(track) {
  const staves = track.staves.map((staff) => ({
    tuning: [...staff.tuning],
    notes: [...notesOf(staff)].map((note) => ({
      string: note.string,
      fret: note.fret,
      // The sounding pitch, which is what a transposition or a retuning is
      // really about. `realValue` is a getter over `stringTuning + fret`.
      realValue: note.isStringed ? note.realValue : null,
    })),
  }))
  return {
    name: track.name,
    shortName: track.shortName,
    program: track.playbackInfo.program,
    isPercussion: track.isPercussion,
    staves,
  }
}

export function* notesOf(staff) {
  for (const bar of staff.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        for (const note of beat.notes) yield note
      }
    }
  }
}

export function tempoMap(score) {
  const map = []
  score.masterBars.forEach((masterBar, index) => {
    for (const automation of masterBar.tempoAutomations) map.push([index, automation.value])
  })
  return map
}

// Every note-on in the midi alphaTab would generate from this score, as
// [tick, channel, key], sorted so two runs are comparable.
//
// This is the only way to check a claim like "moving a note to another string
// does not change what is played": the pitch lives in the model as
// string + fret, and only the generator turns it into a midi key.
export function midiNoteOns(score) {
  const file = new alphaTab.midi.MidiFile()
  const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(file)
  new alphaTab.midi.MidiFileGenerator(score, settings, handler).generate()

  const events = []
  for (const track of file.tracks ?? []) {
    for (const event of track.events ?? []) {
      if (event instanceof alphaTab.midi.NoteOnEvent) {
        events.push([event.tick, event.channel, event.noteKey])
      }
    }
  }
  return events.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
}

// The tracks the fret and tuning operations are allowed to act on.
export function stringedTracks(score) {
  return score.tracks.filter((track) => track.staves.some((staff) => staff.isStringed))
}
