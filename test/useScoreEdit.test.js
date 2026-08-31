import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, shallowRef, nextTick } from 'vue'

// A recording stand-in for usePlayer.
//
// This suite is about the PROPAGATION MATRIX - which edits re-render, which
// regenerate the midi, which do both, and with what RenderHints - and about the
// selection. That is the part of the design most likely to be got quietly wrong
// (too little propagation shows a stale score, too much re-lays out the whole
// thing on every keystroke) and the part a Node test can actually pin down.
//
// What is NOT covered here, and needs a browser: whether the incremental render
// is visibly faster, and how a held arrow key feels.

function emitter() {
  const handlers = []
  return {
    on: (fn) => handlers.push(fn),
    emit: (value) => handlers.forEach((fn) => fn(value)),
    get count() {
      return handlers.length
    },
  }
}

const host = {
  api: null,
  score: null,
  renders: [],
  midiReloads: 0,
  syncedTracks: [],
  syncedScoreInfo: 0,
  dirty: false,
  tracksById: new Map(),

  trackAt(index) {
    return host.tracksById.get(index) ?? null
  },
  syncTrack(index) {
    host.syncedTracks.push(index)
  },
  syncScoreInfo() {
    host.syncedScoreInfo += 1
    // Mirror the real one: it replaces scoreInfo, which is what re-triggers the
    // `tempo` computed.
    player.scoreInfo.value = { tempo: host.score?.tempo ?? null }
  },
  reloadMidi() {
    host.midiReloads += 1
  },
  onScoreCleared: null,
  midiStale: false,
  previews: [],
  beatPreviews: [],
  markMidiStale() {
    host.midiStale = true
  },
  previewNote(note) {
    host.previews.push(note)
    return true
  },
  previewBeat(beat) {
    host.beatPreviews.push(beat)
    return true
  },
  markDirty() {
    host.dirty = true
  },
  clearDirty() {
    host.dirty = false
  },
}

const player = {
  isScoreLoaded: ref(true),
  isPlaying: ref(false),
  setTrackProgram: vi.fn(),
  tracks: ref([]),
  scoreInfo: shallowRef(null),
  fileName: ref('fixture.gp'),
  isDirty: ref(false),
  revertToOriginal: vi.fn(() => true),
  // A ref, like the real one, so the Revert control can react to it.
  canRevert: ref(true),
}

vi.mock('@/composables/usePlayer', () => ({
  usePlayer: () => player,
  scoreEditHost: host,
}))

const download = vi.fn(() => ({ fileName: 'Edit Fixture (edited).gp', byteLength: 42 }))
vi.mock('@/utils/exportScore', () => ({
  downloadScoreAsGp: (...args) => download(...args),
}))

const alphaTab = await import('@coderline/alphatab')
// A REAL Settings object, not a stub: `deleteNotes` calls `score.finish(settings)`
// and finish() reads `settings.notation.notationMode`, so a plain object throws.
// Fresh rather than the shared one from helpers, because noteSelection.test.js
// asserts that one still has alphaTab's `includeNoteBounds` default.
const apiSettings = new alphaTab.Settings()
apiSettings.core.includeNoteBounds = true

const { useScoreEdit } = await import('@/composables/useScoreEdit')
const { loadFixture } = await import('./helpers')
const { stringedNotes, MAX_FRET, RETUNE_KEEP_PITCH, RETUNE_REASSIGN } =
  await import('@/utils/scoreEdits')

const LEAD = 0
const RHYTHM = 1
const BASS = 2
const HARM = 3
const DRUMS = 4

let edit
let score

// A stand-in bounds lookup shaped like alphaTab's: `findBeats` returns one
// BeatBounds per staff (standard notation and tablature), each carrying a
// NoteBounds per note. The x offset per staff makes the two rectangles
// distinguishable.
function fakeBoundsLookup() {
  return {
    findBeats(beat) {
      if (!beat) return null
      return [0, 1].map((staff) => ({
        notes: beat.notes.map((note, i) => ({
          note,
          noteHeadBounds: { x: 100 + staff * 1000 + i, y: 50 + staff * 40, w: 11, h: 9 },
        })),
      }))
    },
  }
}

function fakeApi() {
  return {
    noteMouseDown: emitter(),
    beatMouseDown: emitter(),
    playbackRangeHighlightChanged: emitter(),
    scoreLoaded: emitter(),
    postRenderFinished: emitter(),
    settings: apiSettings,
    boundsLookup: fakeBoundsLookup(),
    render: (hints) => host.renders.push(hints ?? null),
  }
}

// Reproduce alphaTab's click sequence: beatMouseDown, then noteMouseDown in the
// SAME synchronous handler if the hit-test found a note head. `hitNote` of null
// is a click that landed on a beat but between the note heads.
function clickAt(hitNote) {
  host.api.beatMouseDown.emit(null)
  if (hitNote) host.api.noteMouseDown.emit(hitNote)
}

// Reproduce a click-and-drag range. alphaTab normalises the order itself and
// fires EMPTY args for a plain click, which is what `dragOver(null)` stands for.
function dragOver(startBeat, endBeat) {
  if (!startBeat || !endBeat) {
    host.api.playbackRangeHighlightChanged.emit({})
    return
  }
  host.api.playbackRangeHighlightChanged.emit({ startBeat, endBeat })
}

// The beats of a track, in model order.
function beatsOf(trackIndex) {
  const beats = []
  for (const staff of score.tracks[trackIndex].staves) {
    for (const bar of staff.bars) {
      for (const voice of bar.voices) beats.push(...voice.beats)
    }
  }
  return beats
}

beforeEach(async () => {
  score = loadFixture()
  host.api = fakeApi()
  host.score = score
  host.renders = []
  host.midiReloads = 0
  host.syncedTracks = []
  host.syncedScoreInfo = 0
  host.dirty = false
  host.tracksById = new Map(score.tracks.map((track) => [track.index, track]))

  // The flat descriptors the panel reads, in the shape usePlayer builds.
  host.midiStale = false
  host.previews = []
  host.beatPreviews = []
  player.isPlaying.value = false
  player.isScoreLoaded.value = true
  player.tracks.value = score.tracks.map((track) => ({
    index: track.index,
    name: track.name,
    isStringed: track.staves.some((s) => s.isStringed),
    isPercussion: track.isPercussion,
    program: track.playbackInfo.program,
  }))
  player.scoreInfo.value = { tempo: score.tempo }
  player.isDirty.value = false
  player.revertToOriginal.mockClear()
  player.setTrackProgram.mockClear()
  download.mockClear()

  edit = useScoreEdit()
  // The api only exists from beforeEach onwards, so binding happens here.
  edit.bindSelection()
  edit.selectTrack(LEAD)
  edit.clearSelection()
  await nextTick()
})

describe('the propagation matrix', () => {
  it('rename: renders, does NOT touch the midi', () => {
    expect(edit.rename('New Name').ok).toBe(true)
    expect(host.renders).toEqual([{ reuseViewport: true }])
    expect(host.midiReloads).toBe(0)
    expect(host.syncedTracks).toEqual([LEAD])
    expect(host.dirty).toBe(true)
  })

  it('tempo: renders AND rebuilds the midi NOW, because it changes timing', () => {
    expect(edit.setTempo(200).ok).toBe(true)
    expect(host.renders).toEqual([{ reuseViewport: true }])
    // Immediate, not deferred: the loaded midi is what maps a scrub position to
    // a tick, so a stale one would make the transport disagree with the score.
    expect(host.midiReloads).toBe(1)
    expect(host.midiStale).toBe(false)
    expect(host.syncedScoreInfo).toBe(1)
  })

  it('transpose by tuning: renders and marks the midi stale for the next play', () => {
    expect(edit.transposeByTuning(-2).ok).toBe(true)
    expect(host.renders).toEqual([{ reuseViewport: true }])
    expect(host.midiReloads).toBe(0)
    expect(host.midiStale).toBe(true)
    expect(host.syncedTracks).toEqual([LEAD])
  })

  it('transpose by frets: renders and marks the midi stale for the next play', () => {
    expect(edit.transposeByFrets(2).ok).toBe(true)
    expect(host.renders).toEqual([{ reuseViewport: true }])
    expect(host.midiReloads).toBe(0)
    expect(host.midiStale).toBe(true)
  })

  it('retune: renders and marks the midi stale', () => {
    const target = score.tracks[LEAD].staves[0].tuning.map((v) => v - 2)
    expect(edit.retune(target, RETUNE_REASSIGN).ok).toBe(true)
    expect(host.renders.length).toBe(1)
    expect(host.midiReloads).toBe(0)
    expect(host.midiStale).toBe(true)
  })

  it('a refused edit propagates NOTHING and surfaces the reason', () => {
    edit.selectTrack(RHYTHM) // frets already at 0 and 24
    const result = edit.transposeByFrets(1)
    expect(result.ok).toBe(false)
    expect(host.renders).toEqual([])
    expect(host.midiReloads).toBe(0)
    expect(host.midiStale).toBe(false)
    expect(host.dirty).toBe(false)
    expect(edit.editMessage.value).toMatchObject({ kind: 'error' })
    expect(edit.editMessage.value.text).toContain('fret 24')
  })

  it('a no-op edit propagates nothing and does not mark the score dirty', () => {
    expect(edit.rename(score.tracks[LEAD].name)).toMatchObject({ ok: true, changed: false })
    expect(host.renders).toEqual([])
    expect(host.midiReloads).toBe(0)
    expect(host.dirty).toBe(false)
  })

  it('clears a previous error once an edit succeeds', () => {
    edit.selectTrack(RHYTHM)
    edit.transposeByFrets(1)
    expect(edit.editMessage.value.kind).toBe('error')
    expect(edit.transposeByTuning(1).ok).toBe(true)
    expect(edit.editMessage.value).toBeNull()
  })
})

describe('selection', () => {
  it('a note click stores a flat descriptor and follows the track', () => {
    const note = [...stringedNotes(score.tracks[HARM].staves[0])][0]
    host.api.noteMouseDown.emit(note)

    expect(edit.selectedNote.value).toMatchObject({
      trackIndex: HARM,
      string: note.string,
      fret: note.fret,
    })
    // Clicking a note is also how the user says which track they are editing.
    expect(edit.selectedTrackIndex.value).toBe(HARM)
    // Nothing that would drag the cyclic model graph into a reactive ref.
    expect(JSON.parse(JSON.stringify(edit.selectedNote.value))).toEqual(edit.selectedNote.value)
  })

  it('a new score clears the selection, since the old Note points at a dead graph', () => {
    host.api.noteMouseDown.emit([...stringedNotes(score.tracks[LEAD].staves[0])][0])
    expect(edit.selectedNote.value).not.toBeNull()

    host.api.scoreLoaded.emit(score)
    expect(edit.selectedNote.value).toBeNull()
    expect(edit.selectedTrackIndex.value).toBe(0)
  })

  it('a click that misses every note head DESELECTS, silently', async () => {
    // Clicking a bar is a normal seek, not a mistake: the ring vanishing is the
    // feedback, and a message on every seek would be noise.
    clickAt([...stringedNotes(score.tracks[LEAD].staves[0])][0])
    await Promise.resolve()
    expect(edit.selectedNote.value).not.toBeNull()
    expect(edit.selectedNoteRects.value.length).toBeGreaterThan(0)

    clickAt(null)
    await Promise.resolve()
    expect(edit.selectedNote.value).toBeNull()
    expect(edit.selectedNoteRects.value).toEqual([])
    expect(edit.editMessage.value).toBeNull()
  })

  it('a click that hits a note head keeps the selection it just made', async () => {
    const note = [...stringedNotes(score.tracks[LEAD].staves[0])][0]
    clickAt(note)
    await Promise.resolve()
    expect(edit.selectedNote.value).toMatchObject({ string: note.string, fret: note.fret })
    expect(edit.editMessage.value).toBeNull()
  })

  it('a miss clears a refusal message too, rather than leaving a stale one', async () => {
    edit.selectTrack(RHYTHM)
    edit.transposeByFrets(1) // refused: frets already at 0 and 24
    expect(edit.editMessage.value?.kind).toBe('error')

    clickAt(null)
    await Promise.resolve()
    expect(edit.editMessage.value).toBeNull()
  })

  it('closing the score drops the selection, so its graph can be collected', () => {
    // A held Note reaches the whole score through its back-references, and
    // clearScore() has no alphaTab event to hang off, so usePlayer calls the
    // hook below directly.
    host.api.noteMouseDown.emit([...stringedNotes(score.tracks[LEAD].staves[0])][0])
    expect(edit.selectedNote.value).not.toBeNull()

    expect(typeof host.onScoreCleared).toBe('function')
    host.onScoreCleared()

    expect(edit.selectedNote.value).toBeNull()
    expect(edit.selectedNoteRects.value).toEqual([])
  })

  it('binds its handlers exactly once, however many times it is used', () => {
    const before = host.api.noteMouseDown.count
    useScoreEdit()
    edit.bindSelection()
    useScoreEdit().bindSelection()
    expect(host.api.noteMouseDown.count).toBe(before)
  })
})

describe('the selected note fret', () => {
  function selectFirstNote(trackIndex = LEAD) {
    const note = [...stringedNotes(score.tracks[trackIndex].staves[0])][0]
    host.api.noteMouseDown.emit(note)
    return note
  }

  it('renders incrementally from the bar that changed', () => {
    const note = selectFirstNote()
    const bar = note.beat.voice.bar.masterBar.index
    expect(edit.setSelectedFret(note.fret + 1).ok).toBe(true)
    expect(host.renders).toEqual([{ reuseViewport: true, firstChangedMasterBar: bar }])
  })

  it('never rebuilds the midi while editing: it is left for the next play', () => {
    const note = selectFirstNote()
    for (let i = 1; i <= 5; i += 1) edit.nudgeSelectedFret(1)

    // Five renders, so the notation followed every press...
    expect(host.renders.length).toBe(5)
    // ...and no rebuild at all. usePlayer pays for it when playback starts,
    // which is also what stops loadMidiForScore()'s internal stop() from
    // cutting the preview note short.
    expect(host.midiReloads).toBe(0)
    expect(host.midiStale).toBe(true)
    expect(note.fret).toBe(3 + 5)
  })

  it('SOUNDS the new pitch, once per press', () => {
    const note = selectFirstNote()
    expect(host.previews).toEqual([])

    edit.nudgeSelectedFret(1)
    expect(host.previews).toEqual([note])

    edit.nudgeSelectedFret(1)
    expect(host.previews).toEqual([note, note])
  })

  it('does not sound anything when the edit was refused or changed nothing', () => {
    const note = selectFirstNote()
    note.fret = 0
    edit.nudgeSelectedFret(-1) // out of range
    expect(host.previews).toEqual([])

    edit.setSelectedFret(note.fret) // already that fret
    expect(host.previews).toEqual([])
  })

  it('updates the flat descriptor so the inspector shows the new fret', () => {
    const note = selectFirstNote()
    const before = edit.selectedNote.value.fret
    edit.setSelectedFret(before + 1)
    expect(edit.selectedNote.value.fret).toBe(before + 1)
    expect(edit.selectedNote.value.midiKey).toBe(note.realValue)
  })

  it('refuses SILENTLY at the bounds: a repeatable key must not shout', () => {
    const note = selectFirstNote()
    note.fret = 0
    const result = edit.nudgeSelectedFret(-1)
    expect(result.ok).toBe(false)
    expect(edit.editMessage.value).toBeNull()
    expect(host.renders).toEqual([])
    expect(note.fret).toBe(0)
  })

  it('still explains a refusal that is NOT about the bounds', () => {
    const natural = [...stringedNotes(score.tracks[HARM].staves[0])].find(
      (note) => note.harmonicType === 1,
    )
    host.api.noteMouseDown.emit(natural)
    const result = edit.nudgeSelectedFret(1)
    expect(result.ok).toBe(false)
    expect(edit.editMessage.value?.text).toMatch(/natural harmonic/)
  })

  it('asks for a selection rather than acting on nothing', () => {
    edit.clearSelection()
    expect(edit.setSelectedFret(5).ok).toBe(false)
    expect(edit.editMessage.value?.text).toMatch(/Click a note/)
    expect(edit.nudgeSelectedFret(1).ok).toBe(false)
    expect(host.renders).toEqual([])
  })
})

describe('setInstrument', () => {
  it('delegates the write to usePlayer, which owns the automation rewrite', () => {
    expect(edit.setInstrument(42).ok).toBe(true)
    expect(player.setTrackProgram).toHaveBeenCalledWith(LEAD, 42)
  })

  it('acts on the track being EDITED, not on the first one', () => {
    edit.selectTrack(BASS)
    expect(edit.setInstrument(33).ok).toBe(true)
    expect(player.setTrackProgram).toHaveBeenCalledWith(BASS, 33)
  })

  it('refuses a percussion track, which has no program number', () => {
    edit.selectTrack(DRUMS)
    const result = edit.setInstrument(42)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/drum channel/)
    expect(player.setTrackProgram).not.toHaveBeenCalled()
  })
})

describe('the selection marker', () => {
  it('is one rectangle per staff the note is drawn on', () => {
    const note = [...stringedNotes(score.tracks[LEAD].staves[0])][0]
    host.api.noteMouseDown.emit(note)

    // Standard notation head and tablature fret number: the marker goes on both.
    expect(edit.selectedNoteRects.value).toHaveLength(2)
    for (const rect of edit.selectedNoteRects.value) {
      expect(rect).toMatchObject({ w: 11, h: 9 })
      expect(Number.isFinite(rect.x)).toBe(true)
      expect(Number.isFinite(rect.y)).toBe(true)
    }
    // Plain data, nothing from the model graph.
    expect(JSON.parse(JSON.stringify(edit.selectedNoteRects.value))).toEqual(
      edit.selectedNoteRects.value,
    )
  })

  it('is empty with nothing selected', () => {
    expect(edit.selectedNoteRects.value).toEqual([])
    host.api.noteMouseDown.emit([...stringedNotes(score.tracks[LEAD].staves[0])][0])
    expect(edit.selectedNoteRects.value.length).toBeGreaterThan(0)
    edit.clearSelection()
    expect(edit.selectedNoteRects.value).toEqual([])
  })

  it('is re-read after every render, because a render rebuilds the lookup', () => {
    host.api.noteMouseDown.emit([...stringedNotes(score.tracks[LEAD].staves[0])][0])
    const before = edit.selectedNoteRects.value

    // A new lookup with different coordinates, as a re-layout would produce.
    host.api.boundsLookup = {
      findBeats: (beat) => [{ notes: beat.notes.map((note) => ({
        note, noteHeadBounds: { x: 777, y: 888, w: 12, h: 10 },
      })) }],
    }
    host.api.postRenderFinished.emit()

    expect(edit.selectedNoteRects.value).not.toBe(before)
    expect(edit.selectedNoteRects.value).toEqual([{ x: 777, y: 888, w: 12, h: 10 }])
  })

  it('follows the note when the edit moves it, via the render hook', () => {
    const note = [...stringedNotes(score.tracks[LEAD].staves[0])][0]
    host.api.noteMouseDown.emit(note)
    expect(edit.selectedNoteRects.value.length).toBe(2)
    edit.setSelectedFret(note.fret + 1)
    host.api.postRenderFinished.emit()
    expect(edit.selectedNoteRects.value.length).toBe(2)
  })

  it('survives a lookup that is not there yet', () => {
    host.api.noteMouseDown.emit([...stringedNotes(score.tracks[LEAD].staves[0])][0])
    host.api.boundsLookup = null
    host.api.postRenderFinished.emit()
    expect(edit.selectedNoteRects.value).toEqual([])
  })
})

describe('the selected note string (Alt + arrow)', () => {
  // Picked by criteria: moving up a string needs 4-5 frets of room.
  function selectMovable() {
    const staff = score.tracks[LEAD].staves[0]
    const note = [...stringedNotes(staff)].find(
      (n) => n.string < staff.tuning.length && n.fret >= 5,
    )
    expect(note).toBeDefined()
    host.api.noteMouseDown.emit(note)
    return note
  }

  it('keeps the pitch, renders incrementally and leaves the midi for next play', () => {
    const note = selectMovable()
    const pitch = note.realValue
    const bar = note.beat.voice.bar.masterBar.index

    expect(edit.nudgeSelectedString(1).ok).toBe(true)

    expect(note.realValue).toBe(pitch)
    expect(host.renders).toEqual([{ reuseViewport: true, firstChangedMasterBar: bar }])
    // Still marked stale even though the pitch did not move: the midi generator
    // reads beat.hasNoteOnString() for let-ring durations.
    expect(host.midiReloads).toBe(0)
    expect(host.midiStale).toBe(true)
  })

  it('stays SILENT, because the pitch has not changed', () => {
    // The silence is what separates this from the semitone nudge.
    selectMovable()
    expect(edit.nudgeSelectedString(1).ok).toBe(true)
    expect(host.previews).toEqual([])
  })

  it('updates the flat descriptor so the inspector shows the new string', () => {
    const note = selectMovable()
    const before = { string: edit.selectedNote.value.string, fret: edit.selectedNote.value.fret }
    edit.nudgeSelectedString(1)
    expect(edit.selectedNote.value.string).toBe(before.string + 1)
    expect(edit.selectedNote.value.fret).toBeLessThan(before.fret)
    expect(edit.selectedNote.value.midiKey).toBe(note.realValue)
  })

  it('refuses SILENTLY at the edge of the fretboard', () => {
    const staff = score.tracks[LEAD].staves[0]
    const top = [...stringedNotes(staff)].find((n) => n.string === staff.tuning.length)
    if (!top) return
    host.api.noteMouseDown.emit(top)
    const result = edit.nudgeSelectedString(1)
    expect(result.ok).toBe(false)
    expect(edit.editMessage.value).toBeNull()
    expect(host.renders).toEqual([])
  })

  it('EXPLAINS a refusal that is not about the edge', () => {
    const note = selectMovable()
    note.fret = 24
    const result = edit.nudgeSelectedString(-1)
    expect(result.ok).toBe(false)
    expect(edit.editMessage.value?.text).toMatch(/outside the 0-24 range/)
  })

  it('asks for a selection rather than acting on nothing', () => {
    edit.clearSelection()
    expect(edit.nudgeSelectedString(1).ok).toBe(false)
    expect(host.renders).toEqual([])
  })
})

describe('the dragged range', () => {
  it('collects the notes of the beats it covers, on the track it started on', () => {
    const beats = beatsOf(LEAD)
    dragOver(beats[0], beats[3])

    expect(edit.selectedRange.value).toMatchObject({
      trackIndex: LEAD,
      startBar: 0,
      noteCount: 4, // the fixture's Lead track is one note per beat
    })
  })

  it('is dropped by a plain click, which alphaTab reports as empty args', () => {
    const beats = beatsOf(LEAD)
    dragOver(beats[0], beats[3])
    expect(edit.selectedRange.value).not.toBeNull()

    dragOver(null)
    expect(edit.selectedRange.value).toBeNull()
  })

  it('and a single-note selection exclude each other', () => {
    const note = [...stringedNotes(score.tracks[LEAD].staves[0])][0]
    const beats = beatsOf(LEAD)

    host.api.noteMouseDown.emit(note)
    expect(edit.selectedNote.value).not.toBeNull()

    dragOver(beats[0], beats[3])
    expect(edit.selectedNote.value).toBeNull() // the range won
    // The rings did not go away, they changed owner: they now mark every note
    // the batch will touch, which is the same marker meaning the same thing.
    expect(edit.selectedNoteRects.value).toHaveLength(8)

    host.api.noteMouseDown.emit(note)
    expect(edit.selectedRange.value).toBeNull() // the click won it back
  })

  it('points the panel at the track the drag started on', () => {
    const beats = beatsOf(BASS)
    dragOver(beats[0], beats[2])
    expect(edit.selectedTrackIndex.value).toBe(BASS)
  })

  it('is cleared by a new score and by closing one', () => {
    const beats = beatsOf(LEAD)
    dragOver(beats[0], beats[3])
    host.api.scoreLoaded.emit(score)
    expect(edit.selectedRange.value).toBeNull()

    dragOver(beats[0], beats[3])
    host.onScoreCleared()
    expect(edit.selectedRange.value).toBeNull()
  })
})

describe('the range wears the same marker as a single note', () => {
  it('rings every note it will edit, not just the band alphaTab paints', () => {
    const beats = beatsOf(LEAD)
    dragOver(beats[0], beats[3])

    // The fixture's Lead track renders score AND tab, so each of the 4 notes is
    // drawn twice: 8 rectangles.
    expect(edit.selectedRange.value.noteCount).toBe(4)
    expect(edit.selectedNoteRects.value).toHaveLength(8)
  })

  it('rings exactly the selected notes, not the whole beat range', () => {
    const beats = beatsOf(LEAD)
    dragOver(beats[0], beats[1])
    expect(edit.selectedNoteRects.value).toHaveLength(4) // 2 notes x 2 staves
  })

  it('drops the rings when the range goes', () => {
    const beats = beatsOf(LEAD)
    dragOver(beats[0], beats[3])
    expect(edit.selectedNoteRects.value.length).toBeGreaterThan(0)
    dragOver(null)
    expect(edit.selectedNoteRects.value).toEqual([])
  })

  it('hands the rings back to the single note when one is clicked', () => {
    const beats = beatsOf(LEAD)
    const note = [...stringedNotes(score.tracks[LEAD].staves[0])][0]

    dragOver(beats[0], beats[3])
    expect(edit.selectedNoteRects.value).toHaveLength(8)

    host.api.noteMouseDown.emit(note)
    // Just the one note now, on its two staves.
    expect(edit.selectedNoteRects.value).toHaveLength(2)
  })

  it('re-reads the rings after a render, like the single note does', () => {
    const beats = beatsOf(LEAD)
    dragOver(beats[0], beats[3])

    host.api.boundsLookup = {
      findBeats: (beat) => [{ notes: beat.notes.map((note) => ({
        note, noteHeadBounds: { x: 5, y: 6, w: 7, h: 8 },
      })) }],
    }
    host.api.postRenderFinished.emit()

    expect(edit.selectedNoteRects.value).toHaveLength(4) // 4 notes, 1 staff now
    expect(edit.selectedNoteRects.value[0]).toEqual({ x: 5, y: 6, w: 7, h: 8 })
  })

  it('looks a beat up once per beat, not once per note of a chord', () => {
    // A chord: several notes sharing one beat must not repeat the lookup.
    let calls = 0
    const beats = beatsOf(LEAD)
    const inner = host.api.boundsLookup.findBeats.bind(host.api.boundsLookup)
    host.api.boundsLookup = {
      findBeats: (beat) => {
        calls += 1
        return inner(beat)
      },
    }
    dragOver(beats[0], beats[3])
    expect(calls).toBe(4) // four beats, not four notes-times-staves
  })
})

describe('batch editing a dragged range', () => {
  function selectRange(trackIndex, from, to) {
    const beats = beatsOf(trackIndex)
    dragOver(beats[from], beats[to])
    return beats.slice(from, to + 1).flatMap((b) => b.notes.filter((n) => n.isStringed))
  }

  it('Alt + Shift + arrow moves every fret in the range by a semitone', () => {
    const notes = selectRange(LEAD, 0, 3)
    const before = notes.map((n) => n.fret)

    expect(edit.nudgeSelectedFret(1).ok).toBe(true)

    expect(notes.map((n) => n.fret)).toEqual(before.map((f) => f + 1))
    expect(host.renders).toEqual([{ reuseViewport: true, firstChangedMasterBar: 0 }])
    expect(host.midiStale).toBe(true)
  })

  it('Alt + arrow moves every note a string, keeping every pitch', () => {
    // A window with enough fret room to move up a string.
    const notes = selectRange(LEAD, 4, 7)
    const pitches = notes.map((n) => n.realValue)
    const strings = notes.map((n) => n.string)

    const result = edit.nudgeSelectedString(1)
    if (!result.ok) {
      // Legitimate if the window has a note too low on the neck; then it must
      // have written nothing at all.
      expect(notes.map((n) => n.string)).toEqual(strings)
      return
    }
    expect(notes.map((n) => n.realValue)).toEqual(pitches)
    expect(notes.map((n) => n.string)).toEqual(strings.map((s) => s + 1))
  })

  it('sounds the first beat rather than every note of the range', () => {
    const notes = selectRange(LEAD, 0, 3)
    edit.nudgeSelectedFret(1)
    // One beat preview, not one per note.
    expect(host.beatPreviews).toHaveLength(1)
    expect(host.beatPreviews[0]).toBe(notes[0].beat)
    expect(host.previews).toEqual([])
  })

  it('refuses the WHOLE range rather than moving part of it', () => {
    // Bars 1-3 of the Rhythm track span fret 0 to fret 24, so neither direction
    // fits: +1 runs past 24 and -1 runs below 0.
    const notes = selectRange(RHYTHM, 0, 11)
    expect(Math.min(...notes.map((n) => n.fret))).toBe(0)
    expect(Math.max(...notes.map((n) => n.fret))).toBe(MAX_FRET)
    const before = notes.map((n) => ({ string: n.string, fret: n.fret }))

    const result = edit.nudgeSelectedFret(1)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/Frets stay between/)
    expect(notes.map((n) => ({ string: n.string, fret: n.fret }))).toEqual(before)
    expect(host.renders).toEqual([])
    expect(host.midiStale).toBe(false)
  })

  it('EXPLAINS a range refusal, unlike the silent single-note one', () => {
    selectRange(RHYTHM, 0, 11)
    expect(edit.nudgeSelectedFret(1).ok).toBe(false)
    // With twelve notes selected there is no guessing which one blocked it.
    expect(edit.editMessage.value).toMatchObject({ kind: 'error' })
  })

  it('refuses a range containing natural harmonics', () => {
    selectRange(HARM, 0, 3)
    const result = edit.nudgeSelectedFret(1)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/natural harmonic/)
  })

  it('is blocked by playback like every other edit', () => {
    const notes = selectRange(LEAD, 0, 3)
    const before = notes.map((n) => n.fret)
    player.isPlaying.value = true
    expect(edit.nudgeSelectedFret(1).ok).toBe(false)
    expect(edit.nudgeSelectedString(1).ok).toBe(false)
    expect(notes.map((n) => n.fret)).toEqual(before)
  })
})

describe('Delete replaces the selection with silence', () => {
  it('empties the beat of a single selected note and drops the selection', () => {
    const note = [...stringedNotes(score.tracks[LEAD].staves[0])][0]
    const beat = note.beat
    host.api.noteMouseDown.emit(note)

    expect(edit.deleteSelection()).toMatchObject({ ok: true, changed: true })

    expect(beat.notes).toHaveLength(0)
    expect(beat.isRest).toBe(true)
    // Nothing could be pointed at afterwards, so the selection and its rings go.
    expect(edit.selectedNote.value).toBeNull()
    expect(edit.selectedNoteRects.value).toEqual([])
    expect(host.dirty).toBe(true)
  })

  it('empties every beat of a dragged range, and drops the range', () => {
    const beats = beatsOf(LEAD)
    dragOver(beats[0], beats[3])
    const covered = beats.slice(0, 4)

    expect(edit.deleteSelection().ok).toBe(true)

    for (const beat of covered) expect(beat.isRest).toBe(true)
    expect(edit.selectedRange.value).toBeNull()
    expect(edit.selectedNoteRects.value).toEqual([])
  })

  it('renders from the bar it changed and leaves the midi for the next play', () => {
    const note = [...stringedNotes(score.tracks[LEAD].staves[0])][0]
    const bar = note.beat.voice.bar.masterBar.index
    host.api.noteMouseDown.emit(note)

    edit.deleteSelection()

    expect(host.renders).toEqual([{ reuseViewport: true, firstChangedMasterBar: bar }])
    expect(host.midiReloads).toBe(0)
    expect(host.midiStale).toBe(true)
  })

  it('makes no sound: silence is not something to preview', () => {
    host.api.noteMouseDown.emit([...stringedNotes(score.tracks[LEAD].staves[0])][0])
    edit.deleteSelection()
    expect(host.previews).toEqual([])
    expect(host.beatPreviews).toEqual([])
  })

  it('asks for a selection rather than deleting something arbitrary', () => {
    edit.clearSelection()
    edit.clearRange()
    const result = edit.deleteSelection()
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/Nothing selected/)
    expect(host.renders).toEqual([])
  })

  it('is blocked by playback like every other edit', () => {
    const note = [...stringedNotes(score.tracks[LEAD].staves[0])][0]
    host.api.noteMouseDown.emit(note)
    player.isPlaying.value = true

    expect(edit.deleteSelection().ok).toBe(false)
    expect(note.beat.notes.length).toBeGreaterThan(0)
  })
})

describe('editing only while paused', () => {
  const EDITS = [
    ['rename', () => edit.rename('Nope')],
    ['setInstrument', () => edit.setInstrument(42)],
    ['setTempo', () => edit.setTempo(200)],
    ['transposeByTuning', () => edit.transposeByTuning(1)],
    ['transposeByFrets', () => edit.transposeByFrets(1)],
    ['retune', () => edit.retune([64, 59, 55, 50, 45, 38], RETUNE_REASSIGN)],
    ['setSelectedFret', () => edit.setSelectedFret(7)],
    ['nudgeSelectedFret', () => edit.nudgeSelectedFret(1)],
    ['nudgeSelectedString', () => edit.nudgeSelectedString(1)],
    ['deleteSelection', () => edit.deleteSelection()],
  ]

  it('canEdit follows the player, and a note preview does NOT clear it', () => {
    expect(edit.canEdit.value).toBe(true)
    player.isPlaying.value = true
    expect(edit.canEdit.value).toBe(false)
    player.isPlaying.value = false
    expect(edit.canEdit.value).toBe(true)
    player.isScoreLoaded.value = false
    expect(edit.canEdit.value).toBe(false)
  })

  it('refuses every edit while playing, and writes nothing', () => {
    const note = [...stringedNotes(score.tracks[LEAD].staves[0])][0]
    host.api.noteMouseDown.emit(note)
    const before = { name: score.tracks[LEAD].name, tempo: score.tempo, fret: note.fret }

    player.isPlaying.value = true
    for (const [label, run] of EDITS) {
      const result = run()
      expect(result.ok, label).toBe(false)
      expect(result.reason, label).toMatch(/Pause playback/)
    }

    expect(host.renders).toEqual([])
    expect(host.midiReloads).toBe(0)
    expect(host.midiStale).toBe(false)
    expect(host.previews).toEqual([])
    expect(host.dirty).toBe(false)
    expect(player.setTrackProgram).not.toHaveBeenCalled()
    expect({ name: score.tracks[LEAD].name, tempo: score.tempo, fret: note.fret }).toEqual(before)
  })

  it('says why, rather than letting a click do nothing', () => {
    player.isPlaying.value = true
    edit.rename('Nope')
    expect(edit.editMessage.value).toMatchObject({ kind: 'error' })
    expect(edit.editMessage.value.text).toMatch(/Pause playback/)
  })

  it('lets everything through again once paused', () => {
    player.isPlaying.value = true
    expect(edit.rename('Nope').ok).toBe(false)
    player.isPlaying.value = false
    expect(edit.rename('Allowed').ok).toBe(true)
    expect(score.tracks[LEAD].name).toBe('Allowed')
  })

  it('still allows SELECTING a note while playing: it writes nothing', () => {
    player.isPlaying.value = true
    const note = [...stringedNotes(score.tracks[LEAD].staves[0])][0]
    host.api.noteMouseDown.emit(note)
    expect(edit.selectedNote.value).not.toBeNull()
  })
})

describe('reads for the panel', () => {
  it('exposes the tempo and how many automations the field is moving', () => {
    expect(edit.tempo.value).toMatchObject({ tempo: 120, automationCount: 3 })
  })

  it('re-reads the tempo after an edit', () => {
    edit.setTempo(240)
    expect(edit.tempo.value.tempo).toBe(240)
  })

  it('offers tuning choices for a stringed track and none for percussion', () => {
    expect(edit.tuningOptions.value.length).toBeGreaterThan(0)
    expect(edit.tuningOptions.value.filter((o) => o.isCurrent)).toHaveLength(1)
    edit.selectTrack(DRUMS)
    expect(edit.tuningOptions.value).toEqual([])
  })

  it('re-reads the tuning choices after a retuning', () => {
    const target = score.tracks[LEAD].staves[0].tuning.map((v) => v - 2)
    edit.retune(target, RETUNE_KEEP_PITCH)
    const current = edit.tuningOptions.value.find((o) => o.isCurrent)
    expect(current.tunings).toEqual(target)
  })

  it('ignores a request to edit a track that is not there', () => {
    edit.selectTrack(99)
    expect(edit.editedTrack.value.index).toBe(LEAD)
  })
})

describe('saving and reverting', () => {
  it('download hands the score to the exporter and clears the dirty flag', () => {
    edit.rename('Dirty Now')
    expect(host.dirty).toBe(true)

    const saved = edit.download()
    // The api's settings go through to the exporter untouched.
    expect(download).toHaveBeenCalledWith(score, host.api.settings, 'fixture.gp')
    expect(saved.fileName).toBe('Edit Fixture (edited).gp')
    expect(host.dirty).toBe(false)
    expect(edit.editMessage.value).toMatchObject({ kind: 'ok' })
  })

  it('download reports a failure instead of throwing at the caller', () => {
    download.mockImplementationOnce(() => {
      throw new Error('disk on fire')
    })
    expect(edit.download()).toBeNull()
    expect(edit.editMessage.value).toMatchObject({ kind: 'error', text: 'disk on fire' })
    expect(edit.isExporting.value).toBe(false)
  })

  it('revert goes through usePlayer, which owns the original bytes', () => {
    expect(edit.revert()).toBe(true)
    expect(player.revertToOriginal).toHaveBeenCalled()
  })

  it('revert says so when there is nothing to go back to', () => {
    player.revertToOriginal.mockReturnValueOnce(false)
    expect(edit.revert()).toBe(false)
    expect(edit.editMessage.value).toMatchObject({ kind: 'error' })
  })
})
