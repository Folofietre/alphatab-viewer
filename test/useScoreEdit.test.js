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
  syncedAllTracks: 0,
  dirty: false,
  tracksById: new Map(),

  hostElement: null,
  // Mirrors usePlayer's getter. The playhead follows the cursor while paused
  // and must not while playing.
  isPlaying: false,
  trackAt(index) {
    return host.tracksById.get(index) ?? null
  },
  syncTrack(index) {
    host.syncedTracks.push(index)
  },
  syncAllTracks() {
    host.syncedAllTracks += 1
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
  // Models `removeTrackAt`: the model splice from scoreEdits, plus the reactive
  // descriptor that carries the mixer state, spliced and renumbered with it.
  // Both halves in one undo, which is the thing worth pinning here.
  removeTrack(index) {
    const at = player.tracks.value.findIndex((d) => d.index === index)
    const descriptor = at >= 0 ? player.tracks.value[at] : null
    if (!descriptor) {
      return { ok: false, changed: false, reason: 'That is not a track of this score.' }
    }
    const result = deleteTrack(host.score, index)
    if (!result.changed) return result

    const renumber = () => player.tracks.value.forEach((d, i) => { d.index = i })
    const detachView = () => {
      player.tracks.value.splice(at, 1)
      renumber()
      host.renderedTracks += 1
    }
    const attachView = () => {
      player.tracks.value.splice(Math.min(at, player.tracks.value.length), 0, descriptor)
      renumber()
      host.renderedTracks += 1
    }
    detachView()
    let isDetached = true
    const swapModel = result.undo
    return {
      ...result,
      undo: () => {
        swapModel()
        if (isDetached) attachView()
        else detachView()
        isDetached = !isDetached
      },
    }
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

const { useScoreEdit, focusToRelease } = await import('@/composables/useScoreEdit')
const { loadFixture } = await import('./helpers')
const {
  deleteTrack,
  stringedNotes,
  MAX_FRET,
  RETUNE_KEEP_PITCH,
  RETUNE_REASSIGN,
  DURATION_SHORTER,
  DURATION_LONGER,
} = await import('@/utils/scoreEdits')

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
      // Two rows per beat, standard notation then tablature, which is the order
      // alphaTab renders them in and which the cursor geometry relies on.
      return [0, 1].map((row) => ({
        onNotesX: 100 + row,
        barBounds: {
          bar: beat.voice.bar,
          visualBounds: { x: 90, y: 40 + row * 40, w: 200, h: row === 0 ? 36 : 65 },
        },
        notes: beat.notes.map((note, i) => ({
          note,
          noteHeadBounds: { x: 100 + row * 1000 + i, y: 50 + row * 40, w: 11, h: 9 },
        })),
      }))
    },
    staffSystems: [],
  }
}

// A minimal but real-shaped `staffSystems` tree over bar 0 of one track, so the
// click-to-cursor wiring can be exercised without a browser.
//
// Deliberately small: the hit-test arithmetic itself is pinned against a REAL
// headless render in scoreGeometry.test.js, and duplicating that here would only
// assert that two stubs agree. What this covers is the wiring - that the DOM
// event's coordinates reach the deselect microtask in time, and that a miss now
// places a cursor instead of clearing everything.
//
// Two rows for the bar, standard notation then tablature, at the vertical
// positions and spacing a six-string staff really renders at.
function fakeStaffSystems(bar) {
  const beats = bar.voices[0].beats
  const beatBounds = (row) =>
    beats.map((beat, i) => ({
      beat,
      realBounds: { x: 100 + i * 50, y: row.y, w: 50, h: row.h },
    }))
  const rows = [
    { y: 40, h: 36 },
    { y: 120, h: 65 },
  ].map((row) => ({
    bar,
    realBounds: { x: 100, y: row.y, w: 200, h: row.h },
    visualBounds: { x: 100, y: row.y, w: 200, h: row.h },
    beats: beatBounds(row),
  }))

  return [
    {
      realBounds: { x: 100, y: 40, w: 200, h: 145 },
      bars: [{ realBounds: { x: 100, y: 40, w: 200, h: 145 }, bars: rows }],
    },
  ]
}

// A stand-in for the alphaTab host element, which is where the DOM
// `alphaTab.beatMouseDown` carrying the mouse coordinates is dispatched.
function fakeHostElement() {
  const listeners = new Map()
  return {
    isConnected: true,
    addEventListener: (name, fn) => listeners.set(name, fn),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    fire: (name, event) => listeners.get(name)?.(event),
    // alphaTab renders inside the host, so the blur-on-press has to leave
    // anything in there alone.
    contains: (el) => el?.insideTheHost === true,
  }
}

function fakeApi() {
  return {
    noteMouseDown: emitter(),
    beatMouseDown: emitter(),
    beatMouseUp: emitter(),
    playbackRangeHighlightChanged: emitter(),
    scoreLoaded: emitter(),
    postRenderFinished: emitter(),
    highlights: [],
    appliedHighlights: 0,
    // alphaTab's own selection, which is NOT the same object as ours and does
    // not go away when ours does.
    playbackRange: null,
    _selectionStart: null,
    _selectionEnd: null,
    // Every beat the playhead was moved to, so a test can assert the playhead
    // followed the cursor rather than only that nothing threw.
    seeks: [],
    highlightPlaybackRange(startBeat, endBeat) {
      this.highlights.push([startBeat, endBeat])
      this._selectionStart = startBeat
      this._selectionEnd = endBeat
      // alphaTab fires the change event synchronously, and reports EMPTY args
      // when the two beats are the same - the edge the bar selection works
      // around, and the edge `dropAlphaTabRange` deliberately steers into.
      if (startBeat === endBeat) this.playbackRangeHighlightChanged.emit({})
      else this.playbackRangeHighlightChanged.emit({ startBeat, endBeat })
    },
    // What `_onPostRenderFinished` does in alphaTab 1.8.4: re-apply the
    // highlight from its own retained state, after every single render.
    replayPostRenderHighlight() {
      if (this._selectionStart) {
        // alphaTab reads `this._selectionEnd.beat` here without checking it
        // either, so a start with no end is the mirror image of the crash.
        if (!this._selectionEnd) {
          throw new TypeError('can\'t access property "beat", this._selectionEnd is undefined')
        }
        this.highlightPlaybackRange(this._selectionStart, this._selectionEnd)
      }
      this.postRenderFinished.emit()
    },
    // Models the branch that matters: with the start and end on the SAME beat,
    // alphaTab seeks, then clears its own selection and the playback range
    // outright. With different beats it keeps the selection and sets a range.
    //
    // AND MODELS WHERE IT THROWS, which a forgiving early return here hid until
    // it reached the browser. alphaTab 1.8.4 reads `this._selectionStart.beat`
    // inside `if (this._selectionEnd)` without checking the start:
    //
    //   if (this._selectionEnd) {
    //     const startTick = ... this._selectionStart.beat ...
    //
    // So an end with no start is not a no-op, it is
    // `TypeError: can't access property "beat", this._selectionStart is
    // undefined` - and that pair is a state only WE can produce, by calling this
    // after a same-beat highlight (which clears the start and leaves the end).
    applyPlaybackRangeFromHighlight() {
      this.appliedHighlights += 1
      if (this._selectionEnd && !this._selectionStart) {
        throw new TypeError('can\'t access property "beat", this._selectionStart is undefined')
      }
      if (!this._selectionStart) return
      this.seeks.push(this._selectionStart)
      if (this._selectionEnd && this._selectionStart !== this._selectionEnd) {
        this.playbackRange = { startTick: 0, endTick: 1 }
      } else {
        this._selectionStart = null
        this.playbackRange = null
        this.playbackRangeHighlightChanged.emit({})
      }
    },
    // The mouse sequence alphaTab itself runs, in ITS order: the selection state
    // is set BEFORE the typed event is triggered, so whatever our handler does
    // runs with that state already in place. `beats` is the beat the button went
    // down on followed by the beats it was dragged over.
    //
    // `point` is the mousedown's coordinates, and leaving it out is not the same
    // gesture: alphaTab dispatches a DOM CustomEvent alongside the typed one and
    // only the DOM one carries them, so without it the click resolves to no
    // position and the cursor is never placed. That is exactly the difference
    // between a drag that works in a test and one that breaks in a browser.
    async dragOverBeats(beats, point = null) {
      const [down, ...moves] = beats
      this._selectionStart = down
      this._selectionEnd = null
      this.beatMouseDown.emit(down)
      if (point) host.hostElement.fire('alphaTab.beatMouseDown', { originalEvent: point })
      // The deselect microtask, which in a browser really does run between the
      // mousedown task and the first mousemove task.
      await Promise.resolve()
      for (const beat of moves) {
        if (this._selectionEnd === beat) continue
        this._selectionEnd = beat
        // _cursorSelectRange: empty args when there is no start or the two beats
        // are the same.
        if (!this._selectionStart || this._selectionStart === beat) {
          this.playbackRangeHighlightChanged.emit({})
        } else {
          this.playbackRangeHighlightChanged.emit({
            startBeat: this._selectionStart,
            endBeat: beat,
          })
        }
      }
      // mouseup: alphaTab applies its selection first, then triggers the event
      // that hands the state back to us.
      this.applyPlaybackRangeFromHighlight()
      this.beatMouseUp.emit(this._selectionEnd ?? down)
    },
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
  // The release, which is what hands the selection state back to us. alphaTab
  // fires it for every press on the score. `dragOverBeats` is the faithful
  // gesture; this one stays synchronous, because forty tests read the selection
  // on the line after calling it.
  host.api.beatMouseUp.emit(null)
}

// Reproduce a double click: two presses on the SAME beat, close together.
//
// ASYNC on purpose. In a browser the two presses are separate tasks, so the
// deselection microtask queued by the first one runs before the second arrives -
// and a bug that only shows up in that gap is exactly what a synchronous version
// of this helper missed.
async function doubleClick(beat) {
  host.api.beatMouseDown.emit(beat)
  await Promise.resolve()
  host.api.beatMouseDown.emit(beat)
  await Promise.resolve()
}

// Reproduce a click-and-drag range. alphaTab normalises the order itself and
// fires EMPTY args for a plain click, which is what `dragOver(null)` stands for.
function dragOver(startBeat, endBeat) {
  if (!startBeat || !endBeat) {
    host.api.playbackRangeHighlightChanged.emit({})
    return
  }
  // alphaTab RECORDS the selection on itself before firing, which is the state
  // its post-render echo replays from. A helper that only fired the event was
  // modelling half the drag, and the half it left out is where the bug lived.
  host.api._selectionStart = startBeat
  host.api._selectionEnd = endBeat
  host.api.playbackRange = { startTick: 0, endTick: 1 }
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
  host.hostElement = fakeHostElement()
  host.isPlaying = false
  host.score = score
  host.renders = []
  host.midiReloads = 0
  host.syncedTracks = []
  host.syncedScoreInfo = 0
  host.syncedAllTracks = 0
  host.dirty = false
  host.tracksById = new Map(score.tracks.map((track) => [track.index, track]))

  // The flat descriptors the panel reads, in the shape usePlayer builds.
  host.midiStale = false
  host.renderedTracks = 0
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
  // useScoreEdit keeps its selection, range and undo stack at MODULE scope - one
  // score, one of each - so a fresh test needs them reset. `onScoreCleared` is
  // the app's own "this score is gone" hook, which is exactly that reset.
  host.onScoreCleared?.()
  edit.selectTrack(LEAD)
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

describe('double click selects the whole measure', () => {
  // The fixture is 4 beats to a bar, one note per beat on the Lead track.
  it('selects every note of the bar, on the track that was clicked', async () => {
    const beats = beatsOf(LEAD)
    await doubleClick(beats[1]) // second beat of bar 1

    expect(edit.selectedRange.value).toMatchObject({
      trackIndex: LEAD,
      startBar: 0,
      endBar: 0,
      noteCount: 4,
    })
  })

  it('asks alphaTab for the band, so it looks and loops like a drag', async () => {
    const beats = beatsOf(LEAD)
    await doubleClick(beats[0])
    // First and last beat of the bar, and the loop range applied.
    expect(host.api.highlights).toHaveLength(1)
    expect(host.api.highlights[0][0]).toBe(beats[0])
    expect(host.api.highlights[0][1]).toBe(beats[3])
    expect(host.api.appliedHighlights).toBe(1)
  })

  it('works on a later bar too', async () => {
    const beats = beatsOf(LEAD)
    await doubleClick(beats[6]) // bar 2
    expect(edit.selectedRange.value).toMatchObject({ startBar: 1, endBar: 1, noteCount: 4 })
  })

  it('rings every note of the measure', async () => {
    await doubleClick(beatsOf(LEAD)[0])
    // 4 notes, drawn on the score staff and the tablature.
    expect(edit.selectedNoteRects.value).toHaveLength(8)
  })

  it('a SLOW second click is two clicks, not a double', async () => {
    const beats = beatsOf(LEAD)
    vi.useFakeTimers()
    try {
      host.api.beatMouseDown.emit(beats[0])
      // Past the threshold, so the two presses do not pair.
      vi.advanceTimersByTime(1000)
      host.api.beatMouseDown.emit(beats[0])
      await Promise.resolve()
      expect(edit.selectedRange.value).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('two quick clicks on DIFFERENT beats are two clicks', async () => {
    const beats = beatsOf(LEAD)
    host.api.beatMouseDown.emit(beats[0])
    host.api.beatMouseDown.emit(beats[1])
    await Promise.resolve()
    // Moving the playhead twice is not a measure selection.
    expect(edit.selectedRange.value).toBeNull()
  })

  it('does not let the miss-deselection wipe the selection it just made', async () => {
    // Both jobs live in one beatMouseDown handler precisely so this cannot
    // depend on which ran first.
    await doubleClick(beatsOf(LEAD)[0])
    expect(edit.selectedRange.value).not.toBeNull()
    expect(edit.selectedNoteRects.value.length).toBeGreaterThan(0)
  })

  it('a THIRD click starts over rather than re-selecting', async () => {
    const beats = beatsOf(LEAD)
    await doubleClick(beats[0])
    expect(edit.selectedRange.value).not.toBeNull()

    host.api.beatMouseDown.emit(beats[0])
    await Promise.resolve()
    // A single click on a bar deselects, as it always did.
    expect(edit.selectedRange.value).toBeNull()
  })

  it('the measure can then be batch-edited like any other selection', async () => {
    const beats = beatsOf(LEAD)
    const notes = beats.slice(0, 4).flatMap((b) => b.notes)
    const before = notes.map((n) => n.fret)

    await doubleClick(beats[0])
    expect(edit.nudgeSelectedFret(1).ok).toBe(true)

    expect(notes.map((n) => n.fret)).toEqual(before.map((f) => f + 1))
    expect(edit.undoLabel.value).toBe('Transpose selection')
  })

  it('leaves a percussion bar alone rather than selecting nothing', async () => {
    // notesInTickRange only yields stringed notes, so a drum bar has none.
    const beats = beatsOf(DRUMS)
    await doubleClick(beats[0])
    expect(edit.selectedRange.value).toBeNull()
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

describe('undo', () => {
  it('is unavailable until something has been edited', () => {
    expect(edit.canUndo.value).toBe(false)
    expect(edit.undoDepth.value).toBe(0)
    expect(edit.undoLabel.value).toBeNull()
    expect(edit.undo().ok).toBe(false)
  })

  it('takes back the last edit, and names it', () => {
    const before = score.tracks[LEAD].name
    edit.rename('Renamed')
    expect(score.tracks[LEAD].name).toBe('Renamed')
    expect(edit.undoDepth.value).toBe(1)
    expect(edit.undoLabel.value).toBe('Rename track')

    expect(edit.undo()).toMatchObject({ ok: true, label: 'Rename track' })

    expect(score.tracks[LEAD].name).toBe(before)
    expect(edit.undoDepth.value).toBe(0)
    expect(edit.canUndo.value).toBe(false)
  })

  it('unwinds newest first', () => {
    edit.rename('One')
    edit.setTempo(200)
    expect(edit.undoLabel.value).toBe('Tempo')

    edit.undo()
    expect(score.tempo).toBe(120)
    expect(score.tracks[LEAD].name).toBe('One')

    edit.undo()
    expect(score.tracks[LEAD].name).toBe('Lead')
  })

  it('clears the dirty flag once every edit is taken back', () => {
    edit.rename('Dirty')
    expect(host.dirty).toBe(true)
    edit.undo()
    // The score really is back to how it was loaded, so nothing needs saving.
    expect(host.dirty).toBe(false)
  })

  it('does NOT clear the dirty flag when the bound dropped older edits', () => {
    // 31 edits with a depth of 30: the first one is gone from the stack but is
    // still applied, so the score is not clean however many undos follow.
    for (let i = 0; i < 31; i += 1) edit.rename(`Name ${i}`)
    expect(edit.undoDepth.value).toBe(30)
    for (let i = 0; i < 30; i += 1) edit.undo()

    expect(edit.undoDepth.value).toBe(0)
    expect(host.dirty).toBe(true)
    // And the name is the one the dropped edit left, not the original.
    expect(score.tracks[LEAD].name).not.toBe('Lead')
  })

  it('re-renders, re-reads every track, and leaves the midi for the next play', () => {
    edit.transposeByFrets(2)
    host.renders = []
    host.midiStale = false
    host.syncedAllTracks = 0

    edit.undo()

    expect(host.renders).toEqual([{ reuseViewport: true }])
    expect(host.midiStale).toBe(true)
    // An undo can reach any track and the stack does not record which.
    expect(host.syncedAllTracks).toBe(1)
  })

  it('drops the selection, since what was selected may have moved', () => {
    const note = [...stringedNotes(score.tracks[LEAD].staves[0])][0]
    host.api.noteMouseDown.emit(note)
    edit.setSelectedFret(note.fret + 1)
    expect(edit.selectedNote.value).not.toBeNull()

    edit.undo()

    expect(edit.selectedNote.value).toBeNull()
    expect(edit.selectedNoteRects.value).toEqual([])
  })

  it('brings silenced notes back', () => {
    const note = [...stringedNotes(score.tracks[LEAD].staves[0])][0]
    const beat = note.beat
    const fret = note.fret
    host.api.noteMouseDown.emit(note)

    edit.deleteSelection()
    expect(beat.isRest).toBe(true)

    edit.undo()

    expect(beat.isRest).toBe(false)
    expect(beat.notes).toHaveLength(1)
    expect(beat.notes[0].fret).toBe(fret)
  })

  it('undoes a batch range edit in one step', () => {
    const beats = beatsOf(LEAD)
    dragOver(beats[0], beats[3])
    const notes = beats.slice(0, 4).flatMap((b) => b.notes)
    const before = notes.map((n) => n.fret)

    edit.nudgeSelectedFret(1)
    expect(edit.undoDepth.value).toBe(1) // one record, not one per note
    expect(edit.undoLabel.value).toBe('Transpose selection')

    edit.undo()
    expect(notes.map((n) => n.fret)).toEqual(before)
  })

  it('records nothing for a refused or no-op edit', () => {
    edit.rename(score.tracks[LEAD].name) // no-op
    expect(edit.undoDepth.value).toBe(0)
    edit.selectTrack(RHYTHM)
    edit.transposeByFrets(1) // refused
    expect(edit.undoDepth.value).toBe(0)
  })

  it('is blocked by playback like every other edit', () => {
    edit.rename('Renamed')
    player.isPlaying.value = true
    expect(edit.undo().ok).toBe(false)
    expect(score.tracks[LEAD].name).toBe('Renamed')
    expect(edit.canUndo.value).toBe(false)
  })

  it('is forgotten when the score is replaced or closed', () => {
    edit.rename('Renamed')
    expect(edit.undoDepth.value).toBe(1)

    host.api.scoreLoaded.emit(score)
    // The records point at notes of a graph that is no longer displayed, and
    // holding them would pin the discarded score in memory.
    expect(edit.undoDepth.value).toBe(0)

    edit.rename('Again')
    host.onScoreCleared()
    expect(edit.undoDepth.value).toBe(0)
  })

  it('takes back an instrument change through usePlayer', () => {
    const before = player.tracks.value[LEAD].program
    edit.setInstrument(42)
    expect(player.setTrackProgram).toHaveBeenLastCalledWith(LEAD, 42)

    edit.undo()
    expect(player.setTrackProgram).toHaveBeenLastCalledWith(LEAD, before)
  })
})

describe('redo', () => {
  it('is unavailable until something has been undone', () => {
    expect(edit.canRedo.value).toBe(false)
    expect(edit.redoDepth.value).toBe(0)
    expect(edit.redoLabel.value).toBeNull()
    expect(edit.redo().ok).toBe(false)
  })

  it('re-applies what undo took back, and names it', () => {
    edit.rename('Renamed')
    edit.undo()
    expect(score.tracks[LEAD].name).toBe('Lead')
    expect(edit.redoDepth.value).toBe(1)
    expect(edit.redoLabel.value).toBe('Rename track')

    expect(edit.redo()).toMatchObject({ ok: true, label: 'Rename track' })

    expect(score.tracks[LEAD].name).toBe('Renamed')
    expect(edit.redoDepth.value).toBe(0)
    expect(edit.undoDepth.value).toBe(1)
  })

  it('walks a stack down and back up', () => {
    edit.rename('One')
    edit.setTempo(200)
    edit.undo()
    edit.undo()
    expect(score.tracks[LEAD].name).toBe('Lead')
    expect(score.tempo).toBe(120)

    edit.redo()
    expect(score.tracks[LEAD].name).toBe('One')
    edit.redo()
    expect(score.tempo).toBe(200)
  })

  it('makes the score dirty again', () => {
    edit.rename('Renamed')
    edit.undo()
    expect(host.dirty).toBe(false)
    edit.redo()
    expect(host.dirty).toBe(true)
  })

  it('a NEW edit throws away the redo branch', () => {
    edit.rename('One')
    edit.undo()
    expect(edit.canRedo.value).toBe(true)

    edit.setTempo(200)
    expect(edit.redoDepth.value).toBe(0)
    expect(edit.redo().ok).toBe(false)
  })

  it('brings a silenced note back and silences it again', () => {
    const note = [...stringedNotes(score.tracks[LEAD].staves[0])][0]
    const beat = note.beat
    host.api.noteMouseDown.emit(note)

    edit.deleteSelection()
    expect(beat.isRest).toBe(true)
    edit.undo()
    expect(beat.isRest).toBe(false)
    edit.redo()
    expect(beat.isRest).toBe(true)
  })

  it('re-applies a batch range edit in one step', () => {
    const beats = beatsOf(LEAD)
    dragOver(beats[0], beats[3])
    const notes = beats.slice(0, 4).flatMap((b) => b.notes)
    const before = notes.map((n) => n.fret)

    edit.nudgeSelectedFret(1)
    edit.undo()
    expect(notes.map((n) => n.fret)).toEqual(before)

    // The selection is gone by now, so a redo rebuilt from ambient state would
    // refuse. The swap does not need it.
    expect(edit.selectedRange.value).toBeNull()
    edit.redo()
    expect(notes.map((n) => n.fret)).toEqual(before.map((f) => f + 1))
  })

  it('re-renders and leaves the midi for the next play', () => {
    edit.transposeByFrets(2)
    edit.undo()
    host.renders = []
    host.midiStale = false

    edit.redo()

    expect(host.renders).toEqual([{ reuseViewport: true }])
    expect(host.midiStale).toBe(true)
  })

  it('is blocked by playback like every other edit', () => {
    edit.rename('Renamed')
    edit.undo()
    player.isPlaying.value = true
    expect(edit.redo().ok).toBe(false)
    expect(score.tracks[LEAD].name).toBe('Lead')
    expect(edit.canRedo.value).toBe(false)
  })

  it('is forgotten with the score', () => {
    edit.rename('Renamed')
    edit.undo()
    expect(edit.redoDepth.value).toBe(1)
    host.api.scoreLoaded.emit(score)
    expect(edit.redoDepth.value).toBe(0)
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
    ['undo', () => edit.undo()],
    ['redo', () => edit.redo()],
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

// The seam between the two files that nothing was checking, and it let a real
// `TypeError: edit.canEditBars is undefined` reach the browser: every shortcut
// test passes a STUB `edit`, so a binding could reach for a key the composable
// never returned and no test would notice.
describe('the shortcut table and the composable agree', () => {
  it('every key a binding reaches for is really on the composable', async () => {
    const { BINDINGS } = await import('@/composables/useShortcuts')

    // What each `appliesTo` and `run` touches, read off the source rather than
    // guessed: `edit.<name>` for the argument they are given.
    const wanted = new Set()
    for (const binding of BINDINGS) {
      for (const fn of [binding.appliesTo, binding.run]) {
        for (const match of String(fn).matchAll(/\bedit\.([A-Za-z_$][\w$]*)/g)) {
          wanted.add(match[1])
        }
      }
    }
    // A sanity check on the reading itself: if the regex ever stops matching,
    // this test would pass by finding nothing.
    expect(wanted.size).toBeGreaterThan(8)
    expect(wanted.has('canEditBars')).toBe(true)

    for (const name of wanted) {
      expect(edit[name], `edit.${name} is missing`).toBeDefined()
    }
  })

  it('and the ones the bindings read as refs really are refs', () => {
    // `appliesTo` reads `.value` off them, so a plain boolean would throw the
    // same way a missing key does.
    for (const name of ['canNavigate', 'canWriteNote', 'canChangeDuration', 'canEditBars']) {
      expect(edit[name], name).toHaveProperty('value')
      expect(typeof edit[name].value, name).toBe('boolean')
    }
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

// ---------------------------------------------------------------------------

describe('the cursor', () => {
  // Beat helpers on the Lead track, which renders standard notation AND
  // tablature and has four beats per bar.
  function beatAt(bar, index, track = LEAD) {
    return score.tracks[track].staves[0].bars[bar].voices[0].beats[index]
  }

  it('clicking a note puts the cursor ON it: one notion, not two states', () => {
    const note = beatAt(0, 0).notes[0]
    clickAt(note)

    expect(edit.selectedNote.value).toMatchObject({ string: note.string, fret: note.fret })
    expect(edit.cursor.value).toMatchObject({
      trackIndex: LEAD,
      barIndex: 0,
      beatIndex: 0,
      string: note.string,
      hasNote: true,
    })
    // The ring already marks it, so the cursor draws nothing of its own.
    expect(edit.cursorRects.value).toEqual([])
    expect(edit.selectedNoteRects.value.length).toBeGreaterThan(0)
  })

  it('and a percussion note still selects, though it has no string', () => {
    // Percussion reports `string: -1`, so a cursor that resolved the note back
    // through `getNoteOnString` would find nothing and silently deselect.
    const drum = beatAt(0, 0, DRUMS).notes[0]
    clickAt(drum)
    expect(edit.selectedNote.value).not.toBeNull()
    expect(edit.cursor.value.string).toBeNull()
  })

  it('clicking an EMPTY string places the cursor there, instead of deselecting', async () => {
    // The whole point of a cursor: a selection can only designate something that
    // exists, and this designates a place. Before this, the same click cleared
    // the selection and nothing else.
    const bar = score.tracks[LEAD].staves[0].bars[0]
    host.api.boundsLookup.staffSystems = fakeStaffSystems(bar)
    clickAt(bar.voices[0].beats[0].notes[0])
    expect(edit.cursor.value.hasNote).toBe(true)

    // A miss: beatMouseDown, then the DOM event with the coordinates, and no
    // noteMouseDown. The tab row runs 120..185 over six strings, so 13px per
    // line and y = 133 is the second line from the top - string 5.
    host.api.beatMouseDown.emit(bar.voices[0].beats[1])
    host.hostElement.fire('alphaTab.beatMouseDown', {
      originalEvent: { clientX: 160, clientY: 133 },
    })
    await Promise.resolve()

    expect(edit.cursor.value).toMatchObject({ barIndex: 0, beatIndex: 1, string: 5 })
    expect(edit.selectedNote.value).toBeNull()
    expect(edit.cursorRects.value.length).toBe(1)
  })

  it('and a click with no coordinates still just deselects', async () => {
    // The fallback matters: without it a keyboard-driven or synthetic event
    // would leave a stale cursor pointing at wherever the last real click was.
    clickAt(beatAt(0, 0).notes[0])
    host.api.beatMouseDown.emit(beatAt(0, 1))
    await Promise.resolve()
    expect(edit.cursor.value).toBeNull()
    expect(edit.selectedNote.value).toBeNull()
  })

  it('a click on the standard-notation row still lands on a string', async () => {
    // A Y on the standard staff carries no string information, so it is
    // projected onto the tablature row and clamped. Above the tab, that is the
    // top string. Answering "no string" instead left half of every bar placing a
    // cursor nothing could be done with.
    const bar = score.tracks[LEAD].staves[0].bars[0]
    host.api.boundsLookup.staffSystems = fakeStaffSystems(bar)

    host.api.beatMouseDown.emit(bar.voices[0].beats[0])
    host.hostElement.fire('alphaTab.beatMouseDown', {
      originalEvent: { clientX: 110, clientY: 55 },
    })
    await Promise.resolve()

    expect(edit.cursor.value).toMatchObject({ beatIndex: 0, string: 6 })
    // One marker on the tablature, not a caret across both rows.
    expect(edit.cursorRects.value.length).toBe(1)
  })

  it('and clicking down the tablature reads the string exactly', async () => {
    // The tab row of the stub runs 120..185 over six strings, so 13px a line.
    const bar = score.tracks[LEAD].staves[0].bars[0]
    host.api.boundsLookup.staffSystems = fakeStaffSystems(bar)

    for (const [y, string] of [[120, 6], [133, 5], [172, 2], [185, 1]]) {
      // A different beat each time, so two presses are never a double click.
      host.api.beatMouseDown.emit(bar.voices[0].beats[string % 4])
      host.hostElement.fire('alphaTab.beatMouseDown', {
        originalEvent: { clientX: 110 + (string % 4) * 50, clientY: y },
      })
      await Promise.resolve()
      expect(edit.cursor.value.string, `y=${y}`).toBe(string)
    }
  })

  it('the arrows walk the beats, crossing into the next bar', () => {
    clickAt(beatAt(0, 3).notes[0])
    expect(edit.moveCursorBeat(1).ok).toBe(true)
    expect(edit.cursor.value).toMatchObject({ barIndex: 1, beatIndex: 0 })

    expect(edit.moveCursorBeat(-1).ok).toBe(true)
    expect(edit.cursor.value).toMatchObject({ barIndex: 0, beatIndex: 3 })
  })

  it('and selects whatever note is at the position it lands on', () => {
    clickAt(beatAt(0, 0).notes[0])
    const next = beatAt(0, 1).notes[0]
    // Same string across the fixture's first bar, so the walk stays on notes.
    edit.moveCursorBeat(1)
    expect(edit.cursor.value.hasNote).toBe(true)
    expect(edit.selectedNote.value.fret).toBe(next.fret)
  })

  it('leaves the selection empty where the string it keeps holds nothing', () => {
    clickAt(beatAt(0, 0).notes[0])
    // Two strings away from the line this bar is written on.
    edit.moveCursorString(2)
    expect(edit.cursor.value.hasNote).toBe(false)
    expect(edit.selectedNote.value).toBeNull()
    // And NOW the cursor draws itself, because no ring is doing it.
    expect(edit.cursorRects.value.length).toBe(1)
  })

  it('stops silently at the ends of the score rather than creating anything', () => {
    // Creating a bar past the end is a WRITE, and belongs to the writing palier.
    const staff = score.tracks[LEAD].staves[0]
    const lastBar = staff.bars.length - 1
    const lastBeat = staff.bars[lastBar].voices[0].beats
    clickAt(lastBeat[lastBeat.length - 1].notes[0])

    const before = edit.cursor.value
    expect(edit.moveCursorBeat(1)).toMatchObject({ ok: false, changed: false })
    expect(edit.cursor.value).toEqual(before)
    expect(score.masterBars.length).toBe(4)
  })

  it('walks the strings the way the key points, and stops at the edges', () => {
    clickAt(beatAt(0, 0).notes[0])
    const { string, stringCount } = edit.cursor.value

    expect(edit.moveCursorString(1).ok).toBe(true)
    expect(edit.cursor.value.string).toBe(string + 1)

    // Up to the top, then no further - silent, like running out of frets.
    while (edit.cursor.value.string < stringCount) edit.moveCursorString(1)
    expect(edit.moveCursorString(1)).toMatchObject({ ok: false, changed: false })
    expect(edit.cursor.value.string).toBe(stringCount)
  })

  it('enters the fretboard from the far edge where there is no tablature', async () => {
    // A stringed staff with its tab hidden - standard notation only, which a
    // real .gp file can carry. There is nothing to project a click onto, so the
    // position has no string, and the first arrow starts from the edge it is
    // travelling away from rather than doubling back.
    const bar = score.tracks[LEAD].staves[0].bars[0]
    bar.staff.showTablature = false
    host.api.boundsLookup.staffSystems = fakeStaffSystems(bar)

    // A DIFFERENT beat each time: two presses on the same one inside 400ms are a
    // double click, which selects the bar instead.
    const land = async (index) => {
      host.api.beatMouseDown.emit(bar.voices[0].beats[index])
      host.hostElement.fire('alphaTab.beatMouseDown', {
        originalEvent: { clientX: 110 + index * 50, clientY: 55 },
      })
      await Promise.resolve()
    }

    await land(0)
    expect(edit.cursor.value.string).toBeNull()
    edit.moveCursorString(1)
    expect(edit.cursor.value.string).toBe(1)

    await land(1)
    expect(edit.cursor.value.string).toBeNull()
    edit.moveCursorString(-1)
    expect(edit.cursor.value.string).toBe(edit.cursor.value.stringCount)
  })

  it('refuses to walk strings on a staff that has none', () => {
    clickAt(beatAt(0, 0, DRUMS).notes[0])
    expect(edit.cursor.value.string).toBeNull()
    expect(edit.moveCursorString(1)).toMatchObject({ ok: false, changed: false })
  })

  it('bumps the move counter only when it actually moved', () => {
    // ScoreViewer follows this and nothing else: watching the rectangles would
    // make the view jump on every render, including alphaTab's own during
    // playback.
    clickAt(beatAt(0, 0).notes[0])
    const before = edit.cursorMoves.value
    edit.moveCursorBeat(1)
    expect(edit.cursorMoves.value).toBe(before + 1)

    // A refused move does not count as one.
    const staff = score.tracks[LEAD].staves[0]
    const beats = staff.bars[0].voices[0].beats
    clickAt(beats[0].notes[0])
    const at = edit.cursorMoves.value
    edit.moveCursorBeat(-1)
    expect(edit.cursorMoves.value).toBe(at)
  })

  it('a dragged range collapses onto its far edge, per direction', () => {
    const first = beatAt(0, 0)
    const last = beatAt(0, 3)
    dragOver(first, last)
    expect(edit.selectedRange.value).not.toBeNull()
    expect(edit.cursor.value).toBeNull()

    // Right moves on from the LAST note of the range.
    edit.moveCursorBeat(1)
    expect(edit.cursor.value).toMatchObject({ barIndex: 1, beatIndex: 0 })
    // And the range is gone: a cursor and a range are the two notions, one at a
    // time, or every key would be ambiguous about what it acts on.
    expect(edit.selectedRange.value).toBeNull()

    dragOver(beatAt(1, 1), beatAt(1, 3))
    edit.moveCursorBeat(-1)
    expect(edit.cursor.value).toMatchObject({ barIndex: 1, beatIndex: 0 })
  })

  it('canNavigate is what lets the bare arrows keep scrolling the page', () => {
    expect(edit.canNavigate.value).toBe(false)
    clickAt(beatAt(0, 0).notes[0])
    expect(edit.canNavigate.value).toBe(true)
    edit.clearSelection()
    expect(edit.canNavigate.value).toBe(false)
    dragOver(beatAt(0, 0), beatAt(0, 3))
    expect(edit.canNavigate.value).toBe(true)
  })

  it('is dropped when the score is replaced, like everything else holding a model object', () => {
    clickAt(beatAt(0, 0).notes[0])
    expect(edit.cursor.value).not.toBeNull()
    host.api.scoreLoaded.emit()
    expect(edit.cursor.value).toBeNull()
    expect(edit.cursorBarFill.value).toBeNull()
  })

  it('reports how full its bar is, and follows the cursor to another bar', () => {
    clickAt(beatAt(0, 0).notes[0])
    expect(edit.cursorBarFill.value).toMatchObject({
      barIndex: 0,
      beats: 4,
      beatCapacity: 4,
      state: 'exact',
    })

    // A bar of the same score with a beat taken out reads as incomplete.
    score.tracks[LEAD].staves[0].bars[1].voices[0].beats.pop()
    clickAt(beatAt(1, 0).notes[0])
    expect(edit.cursorBarFill.value).toMatchObject({ barIndex: 1, beats: 3, state: 'under' })
  })
})

describe('the octave', () => {
  function leadNote() {
    return score.tracks[LEAD].staves[0].bars[0].voices[0].beats[0].notes[0]
  }

  it('renders from the bar that changed and defers the midi, like every pitch edit', () => {
    clickAt(leadNote())
    host.renders = []
    expect(edit.shiftSelectedOctave(1)).toMatchObject({ ok: true, changed: true })
    expect(host.renders).toEqual([{ reuseViewport: true, firstChangedMasterBar: 0 }])
    expect(host.midiStale).toBe(true)
    expect(host.midiReloads).toBe(0)
  })

  it('sounds the new pitch, unlike the string move which keeps it', () => {
    const note = leadNote()
    clickAt(note)
    edit.shiftSelectedOctave(1)
    expect(host.previews).toContain(note)
  })

  it('keeps the note descriptor in step with where the note ended up', () => {
    const note = leadNote()
    clickAt(note)
    edit.shiftSelectedOctave(1)
    expect(edit.selectedNote.value).toMatchObject({ string: note.string, fret: note.fret })
  })

  it('says how many notes stayed put, without inventing a result state', () => {
    // The one best-effort operation. `propagate` clears the message on success,
    // so this is posted after it - an existing channel used by a caller, not a
    // fourth kind of result.
    const notes = [...stringedNotes(score.tracks[BASS].staves[0])]
    dragOver(notes[0].beat, notes[notes.length - 1].beat)

    const result = edit.shiftSelectedOctave(-1)
    expect(result.ok).toBe(true)
    expect(result.blockedCount).toBeGreaterThan(0)
    expect(edit.editMessage.value).toMatchObject({ kind: 'info' })
    expect(edit.editMessage.value.text).toMatch(/stayed put/)
  })

  it('says nothing extra when every note moved', () => {
    clickAt(leadNote())
    edit.shiftSelectedOctave(1)
    expect(edit.editMessage.value).toBeNull()
  })

  it('refuses while playing, like every other edit', () => {
    clickAt(leadNote())
    player.isPlaying.value = true
    expect(edit.shiftSelectedOctave(1)).toMatchObject({ ok: false })
    expect(edit.editMessage.value).toMatchObject({ kind: 'error' })
  })

  it('refuses with nothing selected', () => {
    expect(edit.shiftSelectedOctave(1)).toMatchObject({ ok: false, changed: false })
  })

  it('is undoable through the same stack as everything else', () => {
    const note = leadNote()
    const before = { string: note.string, fret: note.fret }
    clickAt(note)
    edit.shiftSelectedOctave(1)
    expect(edit.undoDepth.value).toBe(1)
    expect(edit.undoLabel.value).toBe('Up an octave')

    edit.undo()
    expect({ string: note.string, fret: note.fret }).toEqual(before)
    edit.redo()
    expect(note.fret).toBe(before.fret + 12)
  })
})

describe('the cursor stays in step with the edits', () => {
  function leadNote() {
    return score.tracks[LEAD].staves[0].bars[0].voices[0].beats[0].notes[0]
  }

  it('follows the note when Alt + arrow moves it to another string', () => {
    // They are one notion: a cursor still pointing at the string the note has
    // LEFT would make the next bare arrow start from the wrong place.
    const note = leadNote()
    clickAt(note)
    const before = edit.cursor.value.string

    expect(edit.nudgeSelectedString(-1).ok).toBe(true)
    expect(note.string).toBe(before - 1)
    expect(edit.cursor.value.string).toBe(note.string)
    expect(edit.cursor.value.hasNote).toBe(true)
  })

  it('so the next bare arrow starts from where the note ended up', () => {
    // The consequence that would actually be felt: without the cursor following,
    // pressing Alt+Down then Down would jump two strings.
    const note = leadNote()
    clickAt(note)
    edit.nudgeSelectedString(-1)
    const landed = note.string

    edit.moveCursorString(-1)
    expect(edit.cursor.value.string).toBe(landed - 1)
  })

  it('stays where a silenced note was, instead of disappearing with it', () => {
    // The beat outlives the note - `Beat.isRest` is a getter over
    // `notes.length` - so the position is still there, and it is where someone
    // would want to be next.
    const note = leadNote()
    clickAt(note)
    const at = { ...edit.cursor.value }

    expect(edit.deleteSelection().ok).toBe(true)
    expect(edit.selectedNote.value).toBeNull()
    expect(edit.cursor.value).toMatchObject({
      barIndex: at.barIndex,
      beatIndex: at.beatIndex,
      string: at.string,
      hasNote: false,
    })
    // And the dashed marker takes over from the ring.
    expect(edit.cursorRects.value.length).toBe(1)
  })

  it('but a range delete leaves nothing to point at', () => {
    dragOver(
      score.tracks[LEAD].staves[0].bars[0].voices[0].beats[0],
      score.tracks[LEAD].staves[0].bars[0].voices[0].beats[3],
    )
    expect(edit.deleteSelection().ok).toBe(true)
    expect(edit.cursor.value).toBeNull()
    expect(edit.selectedRange.value).toBeNull()
  })
})


describe('a range and a cursor never both survive', () => {
  function beatAt(bar, index, track = LEAD) {
    return score.tracks[track].staves[0].bars[bar].voices[0].beats[index]
  }

  it('an arrow drops the range in alphaTab too, not just in ours', () => {
    // Ours going quiet is not enough: alphaTab keeps its own selection and
    // draws the band from it, so the passage stayed highlighted on screen after
    // the cursor had already moved off it.
    dragOver(beatAt(0, 0), beatAt(0, 3))
    expect(edit.selectedRange.value).not.toBeNull()
    expect(host.api.playbackRange).not.toBeNull()

    edit.moveCursorBeat(1)

    expect(edit.selectedRange.value).toBeNull()
    expect(edit.cursor.value).not.toBeNull()
    // Collapsed onto one beat, which is what makes alphaTab draw nothing.
    expect(host.api.highlights.length).toBeGreaterThan(0)
    const last = host.api.highlights[host.api.highlights.length - 1]
    expect(last[0]).toBe(last[1])
    // And the loop range went with the selection it was made from.
    expect(host.api.playbackRange).toBeNull()
  })

  it('and a later render cannot bring it back', () => {
    // The reported bug. A tone shift renders; alphaTab re-applies its highlight
    // after every render; our handler rebuilt the range from that echo and wiped
    // the cursor - so the note moved and then the old passage re-selected itself.
    dragOver(beatAt(0, 0), beatAt(0, 3))
    edit.moveCursorBeat(1)
    const cursorAfterArrow = { ...edit.cursor.value }

    host.api.replayPostRenderHighlight()

    expect(edit.selectedRange.value).toBeNull()
    expect(edit.cursor.value).toMatchObject(cursorAfterArrow)
  })

  it('survives the echo that follows a real edit', () => {
    dragOver(beatAt(0, 0), beatAt(0, 3))
    edit.moveCursorString(1)
    const at = { ...edit.cursor.value }

    // Every render in the app is followed by that echo.
    host.api.replayPostRenderHighlight()
    host.api.replayPostRenderHighlight()

    expect(edit.selectedRange.value).toBeNull()
    expect(edit.cursor.value).toMatchObject(at)
  })

  it('a genuine new drag still makes a range, echo or not', () => {
    // The guard must not be so eager that it swallows the gesture it exists to
    // protect: dropping a range and starting a new one are different things.
    dragOver(beatAt(0, 0), beatAt(0, 3))
    edit.moveCursorBeat(1)
    expect(edit.selectedRange.value).toBeNull()

    dragOver(beatAt(1, 0), beatAt(1, 3))
    expect(edit.selectedRange.value).not.toBeNull()
    expect(edit.cursor.value).toBeNull()
  })

  it('collapsing does not recurse', () => {
    // `dropAlphaTabRange` makes alphaTab fire the very event that calls it, so
    // without a guard the two bounce until the stack goes.
    dragOver(beatAt(0, 0), beatAt(0, 3))
    expect(() => edit.clearRange()).not.toThrow()
    expect(edit.selectedRange.value).toBeNull()
  })
})

describe('the papyrus wash follows the cursor', () => {
  function barOfLead(index = 0) {
    return score.tracks[LEAD].staves[0].bars[index]
  }

  it('marks the bar the cursor is in, merged across its notation rows', () => {
    const bar = barOfLead(0)
    host.api.boundsLookup.staffSystems = fakeStaffSystems(bar)
    clickAt(bar.voices[0].beats[0].notes[0])

    // One rectangle for the bar, not one per row: what is being marked is the
    // measure, and the measure is one thing.
    expect(edit.cursorBarRects.value).toHaveLength(1)
    const rect = edit.cursorBarRects.value[0]
    // The stub's two rows run 40..76 and 120..185, so the merge spans both.
    expect(rect.y).toBe(40)
    expect(rect.y + rect.h).toBe(185)
  })

  it('goes when the cursor goes', () => {
    const bar = barOfLead(0)
    host.api.boundsLookup.staffSystems = fakeStaffSystems(bar)
    clickAt(bar.voices[0].beats[0].notes[0])
    expect(edit.cursorBarRects.value).toHaveLength(1)

    edit.clearSelection()
    expect(edit.cursorBarRects.value).toEqual([])
  })

  it('is re-read after a render, like every other rectangle', () => {
    // A render rebuilds the whole bounds lookup, so coordinates taken before it
    // point nowhere afterwards.
    const bar = barOfLead(0)
    host.api.boundsLookup.staffSystems = fakeStaffSystems(bar)
    clickAt(bar.voices[0].beats[0].notes[0])

    host.api.boundsLookup = fakeBoundsLookup()
    host.api.boundsLookup.staffSystems = fakeStaffSystems(bar)
    host.api.postRenderFinished.emit()

    expect(edit.cursorBarRects.value).toHaveLength(1)
  })
})

describe('the playhead follows the cursor', () => {
  function beatAt(bar, index, track = LEAD) {
    return score.tracks[track].staves[0].bars[bar].voices[0].beats[index]
  }

  it('seeks to the beat an arrow lands on, so play starts from there', () => {
    clickAt(beatAt(0, 0).notes[0])
    host.api.seeks = []

    edit.moveCursorBeat(1)

    expect(host.api.seeks).toHaveLength(1)
    expect(host.api.seeks[0]).toBe(beatAt(0, 1))
  })

  it('and a click seeks too, but alphaTab is the one that does it', async () => {
    // Driven as a whole gesture, because that is the difference: while the
    // button is down alphaTab owns its selection, and its own mouseup both seeks
    // to the beat that was pressed and clears the selection afterwards. Doing it
    // ourselves in between is what broke click-and-drag.
    host.api.seeks = []
    await host.api.dragOverBeats([beatAt(0, 2)])
    expect(host.api.seeks).toContain(beatAt(0, 2))
    expect(host.api.playbackRange).toBeNull()
  })

  it('does NOT seek while playing, or every arrow would jump the music', () => {
    clickAt(beatAt(0, 0).notes[0])
    host.isPlaying = true
    host.api.seeks = []

    expect(edit.moveCursorBeat(1).ok).toBe(true)

    // The cursor still moved; only the transport was left alone.
    expect(edit.cursor.value).toMatchObject({ beatIndex: 1 })
    expect(host.api.seeks).toEqual([])
  })

  it('still drops alphaTab´s selection while playing', () => {
    // The seek is what is skipped, not the clean-up: a range surviving into
    // playback would come back on the next render exactly as it did before.
    dragOver(beatAt(0, 0), beatAt(0, 3))
    host.isPlaying = true

    edit.moveCursorBeat(1)
    host.api.replayPostRenderHighlight()

    expect(edit.selectedRange.value).toBeNull()
    expect(edit.cursor.value).not.toBeNull()
  })

  it('moving the cursor with no beat to land on seeks nowhere', () => {
    clickAt(beatAt(0, 0).notes[0])
    host.api.seeks = []
    edit.clearSelection()
    expect(host.api.seeks).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The writing tier: the first keys that put something into the score.
// ---------------------------------------------------------------------------

describe('typing a fret at the cursor', () => {
  function beatAt(bar, index, track = LEAD) {
    return score.tracks[track].staves[0].bars[bar].voices[0].beats[index]
  }

  // Put the cursor on an EMPTY string of a beat that has a note: click the note,
  // then step down one string. The fixture's Lead beat 0 carries string 4.
  function cursorOnEmptyString() {
    clickAt(beatAt(0, 0).notes[0])
    expect(edit.moveCursorString(-1).ok).toBe(true)
    expect(edit.cursor.value).toMatchObject({ string: 3, hasNote: false })
  }

  it('creates the note, rings it, and sounds it', () => {
    cursorOnEmptyString()
    host.previews = []

    const result = edit.typeFret('7')
    expect(result).toMatchObject({ ok: true, changed: true, created: true })
    expect(beatAt(0, 0).getNoteOnString(3).fret).toBe(7)
    // The cursor and the selection are one notion, so the new note is selected.
    expect(edit.selectedNote.value).toMatchObject({ string: 3, fret: 7 })
    expect(edit.cursor.value).toMatchObject({ string: 3, hasNote: true })
    expect(host.previews).toEqual([result.note])
  })

  it('renders from the bar that changed and defers the midi to the next play', () => {
    // `onPlay` rather than `now`: adding a note moves no tick, and a rebuild
    // calls stop() - which would cut off the preview above.
    cursorOnEmptyString()
    host.renders = []
    host.midiStale = false
    host.syncedTracks = []

    edit.typeFret('7')
    expect(host.renders).toEqual([{ reuseViewport: true, firstChangedMasterBar: 0 }])
    expect(host.midiReloads).toBe(0)
    expect(host.midiStale).toBe(true)
    expect(host.syncedTracks).toEqual([LEAD])
    expect(host.dirty).toBe(true)
  })

  it('a fret on a string that is taken changes that note instead of stacking one', () => {
    clickAt(beatAt(0, 0).notes[0])
    const result = edit.typeFret('9')
    expect(result).toMatchObject({ ok: true, created: false })
    expect(beatAt(0, 0).notes).toHaveLength(1)
    expect(beatAt(0, 0).notes[0].fret).toBe(9)
  })

  describe('the second digit replaces rather than waits', () => {
    it('1 then 2 is fret 12', () => {
      cursorOnEmptyString()
      edit.typeFret('1')
      expect(beatAt(0, 0).getNoteOnString(3).fret).toBe(1)
      edit.typeFret('2')
      expect(beatAt(0, 0).getNoteOnString(3).fret).toBe(12)
      // One note, corrected - not two.
      expect(beatAt(0, 0).notes).toHaveLength(2)
    })

    it('and 2 then 4 is fret 24, the last one the neck has', () => {
      cursorOnEmptyString()
      edit.typeFret('2')
      edit.typeFret('4')
      expect(beatAt(0, 0).getNoteOnString(3).fret).toBe(24)
      expect(MAX_FRET).toBe(24)
    })

    it('but 3 then 5 is fret 3 then fret 5, because 35 is off any neck', () => {
      cursorOnEmptyString()
      edit.typeFret('3')
      edit.typeFret('5')
      expect(beatAt(0, 0).getNoteOnString(3).fret).toBe(5)
    })

    it('a leading zero is not a number: 0 then 5 is fret 5', () => {
      cursorOnEmptyString()
      edit.typeFret('0')
      edit.typeFret('5')
      expect(beatAt(0, 0).getNoteOnString(3).fret).toBe(5)
    })

    it('a first digit that changed nothing still counts as typed', () => {
      // The Bass track's fourth note already reads fret 1, so typing "12" makes
      // the first press a NO-OP - and if that did not arm the window, the second
      // press would find no number in progress and write fret 2.
      const note = beatAt(0, 3, BASS).notes[0]
      expect(note.fret).toBe(1)
      clickAt(note)

      expect(edit.typeFret('1')).toMatchObject({ ok: true, changed: false })
      edit.typeFret('2')
      expect(note.fret).toBe(12)
    })

    it('the window closes, so a slow second digit starts a new number', () => {
      const now = vi.spyOn(Date, 'now')
      try {
        now.mockReturnValue(10_000)
        cursorOnEmptyString()
        edit.typeFret('1')
        // 900ms later, past MULTI_DIGIT_MS.
        now.mockReturnValue(10_900)
        edit.typeFret('2')
        expect(beatAt(0, 0).getNoteOnString(3).fret).toBe(2)
      } finally {
        now.mockRestore()
      }
    })

    it('and moving the cursor between the digits does too', () => {
      cursorOnEmptyString()
      edit.typeFret('1')
      expect(edit.moveCursorBeat(1).ok).toBe(true)
      expect(edit.moveCursorBeat(-1).ok).toBe(true)
      edit.typeFret('2')
      expect(beatAt(0, 0).getNoteOnString(3).fret).toBe(2)
    })

    it('leaving two undo records, both of which were really on screen', () => {
      cursorOnEmptyString()
      edit.typeFret('1')
      edit.typeFret('2')
      expect(edit.undoDepth.value).toBe(2)

      expect(edit.undo().ok).toBe(true)
      expect(beatAt(0, 0).getNoteOnString(3).fret).toBe(1)
      expect(edit.undo().ok).toBe(true)
      expect(beatAt(0, 0).getNoteOnString(3)).toBeNull()
    })
  })

  it('refuses a position with no string, and says why', () => {
    // Percussion: `string` is null on the cursor, so there is nowhere to write.
    const drums = score.tracks[DRUMS].staves[0].bars[0].voices[0].beats[0]
    host.api.beatMouseDown.emit(drums)
    host.api.noteMouseDown.emit(drums.notes[0])
    expect(edit.cursor.value.string).toBeNull()

    const result = edit.typeFret('5')
    expect(result.ok).toBe(false)
    expect(edit.editMessage.value).toMatchObject({ kind: 'error' })
    expect(edit.editMessage.value.text).toMatch(/no string/)
  })

  it('refuses with no cursor at all', () => {
    edit.clearSelection()
    expect(edit.typeFret('5').ok).toBe(false)
    expect(edit.editMessage.value.text).toMatch(/Click a note or a bar/)
  })

  it('refuses anything that is not a digit', () => {
    cursorOnEmptyString()
    expect(edit.typeFret('x').ok).toBe(false)
    expect(edit.typeFret('12').ok).toBe(false)
  })

  it('stands down while playing, like every other edit', () => {
    cursorOnEmptyString()
    player.isPlaying.value = true
    expect(edit.typeFret('7').ok).toBe(false)
    expect(edit.editMessage.value.text).toMatch(/Pause playback/)
    expect(beatAt(0, 0).getNoteOnString(3)).toBeNull()
  })
})

describe('durations', () => {
  function beatAt(bar, index, track = LEAD) {
    return score.tracks[track].staves[0].bars[bar].voices[0].beats[index]
  }

  it('the cursor reports the duration the next thing written will take', () => {
    clickAt(beatAt(0, 0).notes[0])
    expect(edit.cursor.value).toMatchObject({ duration: 4, durationName: 'quarter' })
  })

  it('+ shortens the beat under the cursor, and the counter follows', () => {
    clickAt(beatAt(0, 0).notes[0])
    expect(edit.cursorBarFill.value).toMatchObject({ state: 'exact', beats: 4 })

    const result = edit.changeDuration(DURATION_SHORTER)
    expect(result).toMatchObject({ ok: true, changed: true, beatCount: 1 })
    expect(beatAt(0, 0).duration).toBe(8)
    expect(edit.cursor.value).toMatchObject({ durationName: 'eighth' })
    // Pitfall 7: this only reads right because the write finished the score.
    expect(edit.cursorBarFill.value).toMatchObject({ state: 'under', beats: 3.5 })
  })

  it('- lengthens it, and an overfull bar is allowed and flagged', () => {
    clickAt(beatAt(0, 0).notes[0])
    expect(edit.changeDuration(DURATION_LONGER).ok).toBe(true)
    expect(beatAt(0, 0).duration).toBe(2)
    expect(edit.cursorBarFill.value).toMatchObject({ state: 'over' })
  })

  // The second edit ever to need `now`, and for the same reason the tempo does:
  // it changes TIMING, and the loaded midi is what maps a scrub position to a
  // tick.
  it('rebuilds the midi NOW rather than at the next play', () => {
    clickAt(beatAt(0, 0).notes[0])
    host.renders = []
    host.midiReloads = 0
    host.midiStale = false

    edit.changeDuration(DURATION_SHORTER)
    expect(host.midiReloads).toBe(1)
    expect(host.midiStale).toBe(false)
    expect(host.renders).toEqual([{ reuseViewport: true, firstChangedMasterBar: 0 }])
  })

  it('a dragged passage moves every beat it covers, all or nothing', () => {
    dragOver(beatAt(0, 0), beatAt(0, 3))
    expect(edit.selectedRange.value.noteCount).toBeGreaterThan(0)

    const result = edit.changeDuration(DURATION_SHORTER)
    expect(result).toMatchObject({ ok: true, beatCount: 4 })
    expect(score.tracks[LEAD].staves[0].bars[0].voices[0].beats.map((b) => b.duration))
      .toEqual([8, 8, 8, 8])
  })

  it('refuses at the end of the ladder, and moves nothing', () => {
    clickAt(beatAt(0, 0).notes[0])
    for (let i = 0; i < 6; i += 1) edit.changeDuration(DURATION_SHORTER)
    expect(beatAt(0, 0).duration).toBe(256)

    const result = edit.changeDuration(DURATION_SHORTER)
    expect(result.ok).toBe(false)
    expect(edit.editMessage.value).toMatchObject({ kind: 'error' })
    expect(edit.editMessage.value.text).toMatch(/shortest/)
    expect(beatAt(0, 0).duration).toBe(256)
  })

  it('refuses with nothing selected, and while playing', () => {
    edit.clearSelection()
    expect(edit.changeDuration(DURATION_SHORTER).ok).toBe(false)

    clickAt(beatAt(0, 0).notes[0])
    player.isPlaying.value = true
    expect(edit.changeDuration(DURATION_SHORTER).ok).toBe(false)
    expect(beatAt(0, 0).duration).toBe(4)
  })

  it('undoes back to the duration it had, ticks included', () => {
    clickAt(beatAt(0, 0).notes[0])
    edit.changeDuration(DURATION_SHORTER)
    expect(beatAt(0, 0).playbackDuration).toBe(480)

    expect(edit.undo().ok).toBe(true)
    expect(beatAt(0, 0).duration).toBe(4)
    expect(beatAt(0, 0).playbackDuration).toBe(960)
  })
})

describe('palm mute', () => {
  function beatAt(bar, index, track = LEAD) {
    return score.tracks[track].staves[0].bars[bar].voices[0].beats[index]
  }

  it('mutes the selected note, and sounds it', () => {
    const note = beatAt(0, 0).notes[0]
    clickAt(note)
    host.previews = []

    const result = edit.toggleSelectedPalmMute()
    expect(result).toMatchObject({ ok: true, changed: true, noteCount: 1, palmMute: true })
    expect(note.isPalmMute).toBe(true)
    // The bracket alphaTab draws comes from the beat's own derived flag.
    expect(note.beat.isPalmMute).toBe(true)
    expect(edit.selectedNote.value.isPalmMute).toBe(true)
    // A change of attack rather than of pitch, so hearing it is the only way to
    // know what it did.
    expect(host.previews).toEqual([note])
  })

  it('and unmutes on the second press, bracket included', () => {
    const note = beatAt(0, 0).notes[0]
    clickAt(note)
    edit.toggleSelectedPalmMute()
    expect(edit.toggleSelectedPalmMute()).toMatchObject({ ok: true, palmMute: false })
    expect(note.isPalmMute).toBe(false)
    // The one a plain finish() would have left behind: it only ever SETS this.
    expect(note.beat.isPalmMute).toBe(false)
    expect(edit.selectedNote.value.isPalmMute).toBe(false)
  })

  it('renders from the bar that changed and defers the midi', () => {
    // It cuts the note short without moving where it starts, so the scrub
    // mapping is still right and the rebuild can wait for the next play.
    clickAt(beatAt(1, 0).notes[0])
    host.renders = []
    host.midiReloads = 0
    host.midiStale = false

    edit.toggleSelectedPalmMute()
    expect(host.renders).toEqual([{ reuseViewport: true, firstChangedMasterBar: 1 }])
    expect(host.midiReloads).toBe(0)
    expect(host.midiStale).toBe(true)
    expect(host.dirty).toBe(true)
  })

  it('mutes every note of a dragged passage, without sounding forty of them', () => {
    dragOver(beatAt(0, 0), beatAt(0, 3))
    const count = edit.selectedRange.value.noteCount
    host.previews = []

    expect(edit.toggleSelectedPalmMute()).toMatchObject({ ok: true, noteCount: count, palmMute: true })
    for (const beat of score.tracks[LEAD].staves[0].bars[0].voices[0].beats) {
      expect(beat.isPalmMute).toBe(true)
    }
    expect(host.previews).toEqual([])
  })

  it('refuses percussion, which has no string to mute', () => {
    const drums = beatAt(0, 0, DRUMS)
    host.api.beatMouseDown.emit(drums)
    host.api.noteMouseDown.emit(drums.notes[0])

    const result = edit.toggleSelectedPalmMute()
    expect(result.ok).toBe(false)
    expect(edit.editMessage.value.text).toMatch(/percussion cannot be palm muted/)
  })

  it('refuses with nothing selected, and while playing', () => {
    edit.clearSelection()
    expect(edit.toggleSelectedPalmMute().ok).toBe(false)

    clickAt(beatAt(0, 0).notes[0])
    player.isPlaying.value = true
    expect(edit.toggleSelectedPalmMute().ok).toBe(false)
    expect(edit.editMessage.value.text).toMatch(/Pause playback/)
    expect(beatAt(0, 0).notes[0].isPalmMute).toBe(false)
  })

  it('and a cursor on an empty string is not a note to mute', () => {
    clickAt(beatAt(0, 0).notes[0])
    expect(edit.moveCursorString(-1).ok).toBe(true)
    expect(edit.cursor.value.hasNote).toBe(false)
    // The key stands down in this state rather than refusing, which is what
    // `canEditNotes` is for.
    expect(edit.canEditNotes.value).toBe(false)
  })

  it('undoes back, bracket and all', () => {
    const note = beatAt(0, 0).notes[0]
    clickAt(note)
    edit.toggleSelectedPalmMute()

    expect(edit.undo().ok).toBe(true)
    expect(note.isPalmMute).toBe(false)
    expect(note.beat.isPalmMute).toBe(false)
    expect(host.dirty).toBe(false)
  })

  it('and the undo label says which way it went', () => {
    clickAt(beatAt(0, 0).notes[0])
    edit.toggleSelectedPalmMute()
    expect(edit.undoLabel.value).toBe('Palm mute')
    edit.toggleSelectedPalmMute()
    expect(edit.undoLabel.value).toBe('Remove palm mute')
  })
})

describe('the dot', () => {
  function beatAt(bar, index, track = LEAD) {
    return score.tracks[track].staves[0].bars[bar].voices[0].beats[index]
  }

  it('dots the beat under the cursor, and the counter follows', () => {
    clickAt(beatAt(0, 0).notes[0])
    expect(edit.cursorBarFill.value).toMatchObject({ state: 'exact', beats: 4 })

    const result = edit.toggleDot()
    expect(result).toMatchObject({ ok: true, changed: true, beatCount: 1, dots: 1 })
    expect(beatAt(0, 0).dots).toBe(1)
    expect(edit.cursor.value.dots).toBe(1)
    // A dotted quarter in a full 4/4 bar overflows it, which is allowed and
    // flagged rather than refused.
    expect(edit.cursorBarFill.value.state).toBe('over')
  })

  it('and takes it off on the second press', () => {
    clickAt(beatAt(0, 0).notes[0])
    edit.toggleDot()
    expect(edit.toggleDot()).toMatchObject({ ok: true, dots: 0 })
    expect(beatAt(0, 0).dots).toBe(0)
    expect(edit.cursorBarFill.value.state).toBe('exact')
  })

  it('is a timing change, so the midi is rebuilt now', () => {
    clickAt(beatAt(0, 0).notes[0])
    host.renders = []
    host.midiReloads = 0

    edit.toggleDot()
    expect(host.midiReloads).toBe(1)
    expect(host.renders).toEqual([{ reuseViewport: true, firstChangedMasterBar: 0 }])
    expect(host.dirty).toBe(true)
  })

  it('acts on every beat of a dragged passage, like the length keys', () => {
    dragOver(beatAt(0, 0), beatAt(0, 3))
    expect(edit.toggleDot()).toMatchObject({ ok: true, beatCount: 4, dots: 1 })
    expect(score.tracks[LEAD].staves[0].bars[0].voices[0].beats.map((b) => b.dots))
      .toEqual([1, 1, 1, 1])
  })

  it('refuses with nothing selected, and while playing', () => {
    edit.clearSelection()
    expect(edit.toggleDot().ok).toBe(false)

    clickAt(beatAt(0, 0).notes[0])
    player.isPlaying.value = true
    expect(edit.toggleDot().ok).toBe(false)
    expect(edit.editMessage.value.text).toMatch(/Pause playback/)
    expect(beatAt(0, 0).dots).toBe(0)
  })

  it('undoes back to the ticks it had', () => {
    clickAt(beatAt(0, 0).notes[0])
    edit.toggleDot()
    expect(beatAt(0, 0).playbackDuration).toBe(1440)

    expect(edit.undo().ok).toBe(true)
    expect(beatAt(0, 0).dots).toBe(0)
    expect(beatAt(0, 0).playbackDuration).toBe(960)
  })

  it('and a new beat inherits the dot of the one it follows', () => {
    // `placeRest` copies `dots` along with the duration, so a run of rests after
    // a dotted note comes out even.
    clickAt(beatAt(0, 3).notes[0])
    edit.toggleDot()
    expect(edit.insertRest()).toMatchObject({ ok: true, inserted: true })
    const beats = score.tracks[LEAD].staves[0].bars[0].voices[0].beats
    expect(beats[4].dots).toBe(1)
  })
})

// alphaTab calls preventDefault() on its own mousedown, which suppresses the
// focus change - so without this, a control used a moment ago still owns the
// keyboard while the user is looking at the score. The rule is split out from
// the listener so it needs no document, the same way `guardUnload` is.
describe('clicking the score takes the keyboard back', () => {
  const host = { contains: (el) => el?.insideTheHost === true }

  it('names the focused element as the one to release', () => {
    const select = { tagName: 'SELECT', blur() {} }
    expect(focusToRelease(select, host)).toBe(select)
  })

  it('leaves the host and anything alphaTab put inside it alone', () => {
    expect(focusToRelease(host, host)).toBeNull()
    expect(focusToRelease({ insideTheHost: true, blur() {} }, host)).toBeNull()
  })

  it('and answers null rather than throwing on nothing to blur', () => {
    expect(focusToRelease(null, host)).toBeNull()
    expect(focusToRelease(undefined, host)).toBeNull()
    // Not everything focusable carries a blur, in a test or in a future DOM.
    expect(focusToRelease({ tagName: 'DIV' }, host)).toBeNull()
  })

  it('works with no host at all, which is the state before init', () => {
    const el = { blur() {} }
    expect(focusToRelease(el, null)).toBe(el)
  })
})

describe('Enter places a rest, or steps along the bar', () => {
  function voiceAt(bar, track = LEAD) {
    return score.tracks[track].staves[0].bars[bar].voices[0]
  }
  function beatAt(bar, index, track = LEAD) {
    return voiceAt(bar, track).beats[index]
  }

  it('steps to the next beat of the bar, writing nothing', () => {
    clickAt(beatAt(0, 0).notes[0])
    const before = voiceAt(0).beats.length

    const result = edit.insertRest()
    expect(result.ok).toBe(true)
    expect(edit.cursor.value).toMatchObject({ barIndex: 0, beatIndex: 1 })
    expect(voiceAt(0).beats).toHaveLength(before)
    expect(host.dirty).toBe(false)
    expect(edit.undoDepth.value).toBe(0)
  })

  it('moves on to the next bar from the last beat of a FULL one', () => {
    clickAt(beatAt(0, 3).notes[0])
    expect(edit.cursorBarFill.value.state).toBe('exact')

    expect(edit.insertRest().ok).toBe(true)
    expect(edit.cursor.value).toMatchObject({ barIndex: 1, beatIndex: 0 })
    expect(voiceAt(0).beats).toHaveLength(4)
  })

  it('inserts one where the bar is not exactly full, and lands on it', () => {
    // Make room first, which is the flow this exists for: shorten, then fill.
    clickAt(beatAt(0, 3).notes[0])
    expect(edit.changeDuration(DURATION_SHORTER).ok).toBe(true)
    expect(edit.cursorBarFill.value.state).toBe('under')

    const result = edit.insertRest()
    expect(result).toMatchObject({ ok: true, changed: true, inserted: true })
    expect(voiceAt(0).beats).toHaveLength(5)
    expect(edit.cursor.value).toMatchObject({ barIndex: 0, beatIndex: 4, hasNote: false })
    expect(voiceAt(0).beats[4].isRest).toBe(true)
    // The new rest takes the length of the beat it follows.
    expect(voiceAt(0).beats[4].duration).toBe(8)
  })

  it('an inserted beat is a timing change, so the midi is rebuilt now', () => {
    clickAt(beatAt(0, 3).notes[0])
    edit.changeDuration(DURATION_SHORTER)
    host.midiReloads = 0
    host.renders = []

    edit.insertRest()
    expect(host.midiReloads).toBe(1)
    expect(host.renders).toEqual([{ reuseViewport: true, firstChangedMasterBar: 0 }])
  })

  it('and the undo takes the beat back out', () => {
    clickAt(beatAt(0, 3).notes[0])
    edit.changeDuration(DURATION_SHORTER)
    edit.insertRest()
    expect(voiceAt(0).beats).toHaveLength(5)

    expect(edit.undo().ok).toBe(true)
    expect(voiceAt(0).beats).toHaveLength(4)
    expect(voiceAt(0).beats.map((b) => b.index)).toEqual([0, 1, 2, 3])
  })

  it('refuses with no cursor, and while playing', () => {
    edit.clearSelection()
    expect(edit.insertRest().ok).toBe(false)

    clickAt(beatAt(0, 0).notes[0])
    player.isPlaying.value = true
    expect(edit.insertRest().ok).toBe(false)
    expect(edit.editMessage.value.text).toMatch(/Pause playback/)
  })
})

// A whole track, which is the biggest thing that can go - and it goes in one
// undoable step, because no note link crosses a track.
describe('deleting a track', () => {
  function names() {
    return score.tracks.map((t) => t.name)
  }
  function descriptorNames() {
    return player.tracks.value.map((t) => t.name)
  }

  it('takes the track out of the score AND out of the mixer', () => {
    const before = names()
    const result = edit.removeTrack(RHYTHM)

    expect(result).toMatchObject({ ok: true, changed: true, trackName: 'Rhythm' })
    expect(names()).toEqual(before.filter((n) => n !== 'Rhythm'))
    expect(descriptorNames()).toEqual(before.filter((n) => n !== 'Rhythm'))
    // Both lists renumbered together, which is what every lookup is keyed on.
    expect(score.tracks.map((t) => t.index)).toEqual([0, 1, 2, 3, 4])
    expect(player.tracks.value.map((t) => t.index)).toEqual([0, 1, 2, 3, 4])
    expect(host.dirty).toBe(true)
  })

  it('rebuilds the midi now, and renders through renderTracks rather than twice', () => {
    host.renders = []
    host.midiReloads = 0
    edit.removeTrack(RHYTHM)

    expect(host.midiReloads).toBe(1)
    // The re-render comes from re-applying the displayed tracks, so nothing
    // asks for a second one.
    expect(host.renders).toEqual([])
    expect(host.renderedTracks).toBe(1)
  })

  it('drops the selection, which may have been on the track that went', () => {
    clickAt(score.tracks[RHYTHM].staves[0].bars[0].voices[0].beats[0].notes[0])
    expect(edit.selectedNote.value).not.toBeNull()

    edit.removeTrack(RHYTHM)
    expect(edit.selectedNote.value).toBeNull()
    expect(edit.cursor.value).toBeNull()
    expect(edit.selectedRange.value).toBeNull()
  })

  it('keeps the panel pointing at a track that still exists', () => {
    edit.selectTrack(score.tracks.length - 1)
    edit.removeTrack(score.tracks.length - 1)
    expect(edit.selectedTrackIndex.value).toBeLessThan(score.tracks.length)
    expect(edit.editedTrack.value).not.toBeNull()
  })

  it('refuses the last track', () => {
    while (score.tracks.length > 1) expect(edit.removeTrack(0).ok).toBe(true)
    const result = edit.removeTrack(0)
    expect(result.ok).toBe(false)
    expect(edit.editMessage.value.text).toMatch(/only track left/)
    expect(score.tracks).toHaveLength(1)
  })

  it('and stands down while playing', () => {
    player.isPlaying.value = true
    expect(edit.removeTrack(RHYTHM).ok).toBe(false)
    expect(edit.editMessage.value.text).toMatch(/Pause playback/)
    expect(score.tracks).toHaveLength(6)
  })

  it('names the track in the undo label, so it can be recognised', () => {
    edit.removeTrack(RHYTHM)
    expect(edit.undoLabel.value).toBe('Delete track Rhythm')
  })

  it('CTRL+Z puts it back, in the score and in the mixer', () => {
    const before = names()
    edit.removeTrack(RHYTHM)

    expect(edit.undo().ok).toBe(true)
    expect(names()).toEqual(before)
    expect(descriptorNames()).toEqual(before)
    expect(score.tracks.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5])
    expect(host.dirty).toBe(false)
  })

  it('and the mixer state comes back with it, not reset', () => {
    // The descriptor is the same object, so volume, mute and solo survive the
    // round trip - rebuilding the list would have lost them.
    const strip = player.tracks.value.find((t) => t.index === RHYTHM)
    strip.volume = 0.42
    strip.isMute = true

    edit.removeTrack(RHYTHM)
    expect(edit.undo().ok).toBe(true)

    const back = player.tracks.value.find((t) => t.index === RHYTHM)
    expect(back).toMatchObject({ name: 'Rhythm', volume: 0.42, isMute: true })
  })

  it('and redo takes it out again', () => {
    edit.removeTrack(RHYTHM)
    edit.undo()
    expect(edit.redo().ok).toBe(true)
    expect(names()).not.toContain('Rhythm')
    expect(descriptorNames()).not.toContain('Rhythm')
  })
})

// Ctrl+A. Taken from the browser, which is the point: it must select the music
// rather than the page as text.
describe('select all', () => {
  function beatAt(bar, index, track = LEAD) {
    return score.tracks[track].staves[0].bars[bar].voices[0].beats[index]
  }
  function everyStringedNote(trackIndex) {
    return [...stringedNotes(score.tracks[trackIndex].staves[0])]
  }

  it('selects every note of the track being edited', () => {
    edit.selectTrack(LEAD)
    const result = edit.selectAll()
    expect(result).toMatchObject({ ok: true, changed: true })
    expect(edit.selectedRange.value).toMatchObject({
      trackIndex: LEAD,
      startBar: 0,
      endBar: score.masterBars.length - 1,
      noteCount: everyStringedNote(LEAD).length,
    })
  })

  it('works from nothing selected, since it is where you start', () => {
    edit.clearSelection()
    edit.clearRange()
    expect(edit.selectAll().ok).toBe(true)
    expect(edit.selectedRange.value.noteCount).toBeGreaterThan(0)
  })

  it('replaces a cursor, and rings every note it took', () => {
    clickAt(beatAt(0, 0).notes[0])
    expect(edit.cursor.value).not.toBeNull()

    edit.selectAll()
    expect(edit.cursor.value).toBeNull()
    expect(edit.selectedNoteRects.value.length).toBeGreaterThan(0)
  })

  it('and sets the loop range, like a drag over everything would', () => {
    edit.selectTrack(LEAD)
    edit.selectAll()
    expect(host.api.playbackRange).not.toBeNull()
    expect(host.api.appliedHighlights).toBeGreaterThan(0)
  })

  it('follows the track the panel is on, not always the first', () => {
    edit.selectTrack(BASS)
    expect(edit.selectAll().ok).toBe(true)
    expect(edit.selectedRange.value).toMatchObject({
      trackIndex: BASS,
      noteCount: everyStringedNote(BASS).length,
    })
  })

  it('so a batch edit then acts on the whole track', () => {
    edit.selectTrack(LEAD)
    edit.selectAll()
    const before = everyStringedNote(LEAD).map((n) => n.fret)

    expect(edit.nudgeSelectedFret(1).ok).toBe(true)
    expect(everyStringedNote(LEAD).map((n) => n.fret)).toEqual(before.map((f) => f + 1))
  })

  it('says why when a track has nothing a range can hold', () => {
    // A range is built from notes with a string and a fret, so percussion
    // yields none however much is written on it.
    edit.selectTrack(DRUMS)
    const result = edit.selectAll()
    expect(result.ok).toBe(false)
    expect(edit.editMessage.value.text).toMatch(/Percussion/)
    expect(edit.selectedRange.value).toBeNull()
  })

  it('still works while playing, because it writes nothing', () => {
    player.isPlaying.value = true
    edit.selectTrack(LEAD)
    expect(edit.selectAll().ok).toBe(true)
    expect(edit.selectedRange.value).not.toBeNull()
  })

  it('and survives the render that follows, without the range re-selecting itself', () => {
    edit.selectTrack(LEAD)
    edit.selectAll()
    const count = edit.selectedRange.value.noteCount

    host.api.replayPostRenderHighlight()
    expect(edit.selectedRange.value).toMatchObject({ noteCount: count })
  })
})

// Whole bars, which is the one thing the writing keys cannot reach: the right
// arrow only ever adds one at the END of the score.
describe('inserting and deleting bars', () => {
  function voiceAt(bar, track = LEAD) {
    return score.tracks[track].staves[0].bars[bar].voices[0]
  }
  function beatAt(bar, index, track = LEAD) {
    return voiceAt(bar, track).beats[index]
  }
  function fretsAt(bar) {
    return voiceAt(bar).beats.map((b) => b.notes[0]?.fret ?? null)
  }

  // ---- Ctrl+Insert ----

  it('inserts before the cursor bar, pushing the rest along', () => {
    clickAt(beatAt(2, 0).notes[0])
    const displaced = fretsAt(2)
    host.syncedScoreInfo = 0

    const result = edit.insertBar()
    expect(result).toMatchObject({ ok: true, changed: true, barIndex: 2 })
    expect(score.masterBars).toHaveLength(5)
    expect(voiceAt(2).isEmpty).toBe(true)
    expect(fretsAt(3)).toEqual(displaced)
    expect(host.syncedScoreInfo).toBe(1)
  })

  it('lands the cursor on the new bar, ready to write in it', () => {
    clickAt(beatAt(2, 0).notes[0])
    const string = edit.cursor.value.string
    const moves = edit.cursorMoves.value

    edit.insertBar()
    expect(edit.cursor.value).toMatchObject({
      barIndex: 2,
      beatIndex: 0,
      string,
      isUnwritten: true,
    })
    expect(edit.cursorBarFill.value).toMatchObject({ state: 'exact' })
    // The view follows, like any other cursor move.
    expect(edit.cursorMoves.value).toBe(moves + 1)
  })

  it('renders fully and rebuilds the midi now, since every later tick moved', () => {
    clickAt(beatAt(2, 0).notes[0])
    host.renders = []
    host.midiReloads = 0

    edit.insertBar()
    expect(host.renders).toEqual([{ reuseViewport: true }])
    expect(host.midiReloads).toBe(1)
    expect(host.dirty).toBe(true)
  })

  it('inserts before the FIRST bar of a dragged passage', () => {
    dragOver(beatAt(1, 0), beatAt(2, 3))
    expect(edit.selectedRange.value).toMatchObject({ startBar: 1, endBar: 2 })

    expect(edit.insertBar()).toMatchObject({ ok: true, barIndex: 1 })
    expect(voiceAt(1).isEmpty).toBe(true)
  })

  it('works on the very first bar, tempo included', () => {
    // `score.tempo` reads masterBars[0], so a new first bar has to carry the
    // automations or the whole score drops to the 120 fallback.
    const beforeTempo = score.tempo
    clickAt(beatAt(0, 0).notes[0])

    expect(edit.insertBar().ok).toBe(true)
    expect(score.tempo).toBe(beforeTempo)
    expect(score.masterBars[0].tempoAutomations.length).toBeGreaterThan(0)
  })

  it('and the undo takes it back out', () => {
    clickAt(beatAt(2, 0).notes[0])
    const frets = fretsAt(2)
    edit.insertBar()

    expect(edit.undo().ok).toBe(true)
    expect(score.masterBars).toHaveLength(4)
    expect(fretsAt(2)).toEqual(frets)
    expect(host.dirty).toBe(false)
  })

  // ---- Ctrl+Delete ----

  it('deletes the cursor bar and closes the gap', () => {
    clickAt(beatAt(1, 0).notes[0])
    const after = fretsAt(2)
    host.syncedAllTracks = 0

    const result = edit.removeBars()
    expect(result).toMatchObject({ ok: true, changed: true, barIndex: 1, barCount: 1 })
    expect(result.noteCount).toBeGreaterThan(0)
    expect(score.masterBars).toHaveLength(3)
    expect(fretsAt(1)).toEqual(after)
    // The panel's fret range and harmonic count are read off the notes.
    expect(host.syncedAllTracks).toBe(1)
  })

  it('lands the cursor on whatever moved up into the hole', () => {
    clickAt(beatAt(1, 0).notes[0])
    const string = edit.cursor.value.string
    edit.removeBars()
    expect(edit.cursor.value).toMatchObject({ barIndex: 1, beatIndex: 0, string })
  })

  it('and on the new LAST bar when the tail is what went', () => {
    clickAt(beatAt(3, 0).notes[0])
    edit.removeBars()
    expect(score.masterBars).toHaveLength(3)
    expect(edit.cursor.value).toMatchObject({ barIndex: 2 })
  })

  // The report that found this: "ctrl+del on a selection only deletes the first
  // bar". A range is built from NOTES, so a drag over bars that hold none - or
  // over a percussion staff, which `notesInTickRange` skips entirely - builds no
  // range at all, while alphaTab's band still paints the bars that were dragged.
  // The delete then fell back to the cursor and took one bar.
  it('deletes the bars a drag covered even when they hold no notes', () => {
    // Two empty bars at the end of the score, which is exactly what someone
    // deleting bars has just made.
    clickAt(beatAt(3, 3).notes[0])
    expect(edit.moveCursorBeat(1, { canWrite: true }).ok).toBe(true)
    expect(edit.moveCursorBeat(1, { canWrite: true }).ok).toBe(true)
    expect(score.masterBars).toHaveLength(6)

    const staff = score.tracks[LEAD].staves[0]
    dragOver(staff.bars[4].voices[0].beats[0], staff.bars[5].voices[0].beats[0])
    // No notes in them, so there is no note selection - and that must not mean
    // there is nothing selected.
    expect(edit.selectedRange.value).toBeNull()
    expect(edit.selectedBars.value).toMatchObject({ startBar: 4, endBar: 5 })

    const result = edit.removeBars()
    expect(result).toMatchObject({ ok: true, barIndex: 4, barCount: 2 })
    expect(score.masterBars).toHaveLength(4)
  })

  it('and on a percussion staff, which holds no note a range can take', () => {
    // `notesInTickRange` keeps only notes with a string and a fret, so a drag
    // anywhere on the drums yields none.
    const drums = score.tracks[DRUMS].staves[0]
    dragOver(drums.bars[1].voices[0].beats[0], drums.bars[2].voices[0].beats[0])
    expect(edit.selectedRange.value).toBeNull()
    expect(edit.selectedBars.value).toMatchObject({ startBar: 1, endBar: 2 })

    expect(edit.removeBars()).toMatchObject({ ok: true, barIndex: 1, barCount: 2 })
    expect(score.masterBars).toHaveLength(2)
  })

  it('and the KEY is armed by such a drag, or the fix never reaches it', () => {
    // `canEditBars` is what `appliesTo` asks. The arrows and the length keys
    // deliberately stay unarmed here: with no cursor and no note range they
    // would swallow the key for nothing.
    const drums = score.tracks[DRUMS].staves[0]
    dragOver(drums.bars[1].voices[0].beats[0], drums.bars[2].voices[0].beats[0])

    expect(edit.canEditBars.value).toBe(true)
    expect(edit.canNavigate.value).toBe(false)
    expect(edit.canChangeDuration.value).toBe(false)
  })

  it('and Ctrl+Insert goes before the first bar of such a drag too', () => {
    const drums = score.tracks[DRUMS].staves[0]
    dragOver(drums.bars[2].voices[0].beats[0], drums.bars[3].voices[0].beats[0])
    expect(edit.insertBar()).toMatchObject({ ok: true, barIndex: 2 })
    expect(score.masterBars).toHaveLength(5)
  })

  it('says how many bars went, since nothing on screen can', () => {
    clickAt(beatAt(1, 0).notes[0])
    expect(edit.removeBars().ok).toBe(true)
    expect(edit.editMessage.value).toMatchObject({ kind: 'ok', text: 'Bar 2 deleted.' })

    dragOver(beatAt(1, 0), beatAt(2, 3))
    expect(edit.removeBars().ok).toBe(true)
    expect(edit.editMessage.value.text).toBe('2 bars deleted (2 to 3).')
  })

  it('deletes every bar of a passage dragged as a real gesture', async () => {
    // Driven as a whole gesture, coordinates included, because that is what the
    // browser does and the event-only helper skips the mousedown entirely.
    host.api.boundsLookup.staffSystems = fakeStaffSystems(
      score.tracks[LEAD].staves[0].bars[0],
    )
    await host.api.dragOverBeats(
      [beatAt(0, 0), beatAt(1, 0), beatAt(2, 3)],
      { clientX: 160, clientY: 133 },
    )
    expect(edit.selectedRange.value, 'the range the drag built').toMatchObject({
      startBar: 0,
      endBar: 2,
    })

    const result = edit.removeBars()
    expect(result).toMatchObject({ ok: true, barIndex: 0, barCount: 3 })
    expect(score.masterBars).toHaveLength(1)
  })

  it('deletes every bar of a dragged passage', () => {
    dragOver(beatAt(1, 0), beatAt(2, 3))
    const result = edit.removeBars()
    expect(result).toMatchObject({ ok: true, barIndex: 1, barCount: 2 })
    expect(score.masterBars).toHaveLength(2)
    expect(edit.selectedRange.value).toBeNull()
  })

  it('refuses to empty the score, and says why', () => {
    dragOver(beatAt(0, 0), beatAt(3, 3))
    const result = edit.removeBars()
    expect(result.ok).toBe(false)
    expect(edit.editMessage.value).toMatchObject({ kind: 'error' })
    expect(edit.editMessage.value.text).toMatch(/cannot have none/)
    expect(score.masterBars).toHaveLength(4)
  })

  it('and the undo puts the bars and their notes back', () => {
    clickAt(beatAt(1, 0).notes[0])
    const frets = fretsAt(1)
    edit.removeBars()

    expect(edit.undo().ok).toBe(true)
    expect(score.masterBars).toHaveLength(4)
    expect(fretsAt(1)).toEqual(frets)
    expect(host.dirty).toBe(false)
  })

  // ---- both ----

  it('both refuse with nothing designated', () => {
    edit.clearSelection()
    expect(edit.insertBar().ok).toBe(false)
    expect(edit.removeBars().ok).toBe(false)
    expect(score.masterBars).toHaveLength(4)
  })

  it('and both stand down while playing', () => {
    clickAt(beatAt(1, 0).notes[0])
    player.isPlaying.value = true

    expect(edit.insertBar().ok).toBe(false)
    expect(edit.editMessage.value.text).toMatch(/Pause playback/)
    expect(edit.removeBars().ok).toBe(false)
    expect(score.masterBars).toHaveLength(4)
  })

  it('a bar inserted then deleted leaves the score as it was', () => {
    clickAt(beatAt(2, 0).notes[0])
    const frets = fretsAt(2)

    expect(edit.insertBar().ok).toBe(true)
    expect(edit.removeBars().ok).toBe(true)
    expect(score.masterBars).toHaveLength(4)
    expect(fretsAt(2)).toEqual(frets)
  })
})

// The right arrow is the key a passage is written with: it walks, and on the last
// beat of a bar that is not EXACTLY full it makes room.
// The whole mouse gesture, driven the way alphaTab drives it. Everything else
// about the range starts from `playbackRangeHighlightChanged`, which is halfway
// through the story: it is the mousedown at the START of the drag that broke it.
describe('click and drag, as a real gesture', () => {
  function beatAt(bar, index, track = LEAD) {
    return score.tracks[track].staves[0].bars[bar].voices[0].beats[index]
  }

  // The coordinates matter: they are what makes the mousedown place a CURSOR,
  // which is the thing that used to corrupt alphaTab's selection state.
  const ON_THE_TAB = { clientX: 160, clientY: 133 }

  beforeEach(() => {
    host.api.boundsLookup.staffSystems = fakeStaffSystems(
      score.tracks[LEAD].staves[0].bars[0],
    )
  })

  it('builds a range from a drag, and does not throw on mouseup', async () => {
    await host.api.dragOverBeats([beatAt(0, 0), beatAt(0, 1), beatAt(0, 3)], ON_THE_TAB)

    expect(edit.selectedRange.value).toMatchObject({ trackIndex: LEAD, startBar: 0, endBar: 0 })
    expect(edit.selectedRange.value.noteCount).toBeGreaterThan(1)
    // The loop range alphaTab applies on mouseup.
    expect(host.api.playbackRange).not.toBeNull()
  })

  it('and the rings mark every note the drag covers', async () => {
    await host.api.dragOverBeats([beatAt(0, 0), beatAt(0, 2)], ON_THE_TAB)
    expect(edit.selectedNoteRects.value.length).toBeGreaterThan(0)
    expect(edit.cursor.value).toBeNull()
  })

  it('a drag across bars keeps the track it started on', async () => {
    await host.api.dragOverBeats([beatAt(0, 2), beatAt(1, 1)], ON_THE_TAB)
    expect(edit.selectedRange.value).toMatchObject({ trackIndex: LEAD, startBar: 0, endBar: 1 })
  })

  it('a drag that starts where a range already was replaces it', async () => {
    await host.api.dragOverBeats([beatAt(0, 0), beatAt(0, 1)], ON_THE_TAB)
    const first = edit.selectedRange.value.noteCount
    await host.api.dragOverBeats([beatAt(2, 0), beatAt(3, 3)], ON_THE_TAB)
    expect(edit.selectedRange.value).toMatchObject({ startBar: 2, endBar: 3 })
    expect(edit.selectedRange.value.noteCount).not.toBe(first)
  })

  it('and a drag still works after the cursor has been moved by the keyboard', async () => {
    // The keyboard path is the one that DOES drop alphaTab's own selection, so
    // this is the order that has to keep working in both directions.
    clickAt(beatAt(0, 0).notes[0])
    expect(edit.moveCursorBeat(1).ok).toBe(true)

    await host.api.dragOverBeats([beatAt(1, 0), beatAt(1, 2)], ON_THE_TAB)
    expect(edit.selectedRange.value).toMatchObject({ startBar: 1 })
  })

  it('a plain click places the cursor and leaves no range behind', async () => {
    // One press and one release, which is what a click is. The coordinates
    // decide where the CURSOR goes: on this stub they land on beat 1 of bar 0.
    await host.api.dragOverBeats([beatAt(0, 2)], ON_THE_TAB)

    expect(edit.selectedRange.value).toBeNull()
    expect(edit.cursor.value).toMatchObject({ barIndex: 0, beatIndex: 1 })
    // The playhead moved to the beat alphaTab's own hit-test found under the
    // press, on its own mouseup - we no longer seek during the gesture.
    expect(host.api.seeks).toContain(beatAt(0, 2))
    expect(host.api.playbackRange).toBeNull()
  })

  it('and a click after a drag replaces the range with a cursor', async () => {
    await host.api.dragOverBeats([beatAt(0, 0), beatAt(0, 3)], ON_THE_TAB)
    expect(edit.selectedRange.value).not.toBeNull()

    await host.api.dragOverBeats([beatAt(0, 2)], ON_THE_TAB)
    expect(edit.selectedRange.value).toBeNull()
    expect(edit.cursor.value).not.toBeNull()
  })

  // alphaTab reads its own selection pair unguarded in BOTH directions - the
  // mouseup reads the start without checking it, the post-render echo reads the
  // end without checking it - so the state it is left in has to survive a render
  // whatever the last gesture was. The fake throws exactly where alphaTab does.
  it('leaves a state that survives a render, after every gesture', async () => {
    await host.api.dragOverBeats([beatAt(0, 0), beatAt(0, 2)], ON_THE_TAB)
    expect(() => host.api.replayPostRenderHighlight(), 'after a drag').not.toThrow()

    await host.api.dragOverBeats([beatAt(1, 1)], ON_THE_TAB)
    expect(() => host.api.replayPostRenderHighlight(), 'after a click').not.toThrow()

    expect(edit.moveCursorBeat(1).ok).toBe(true)
    expect(() => host.api.replayPostRenderHighlight(), 'after an arrow').not.toThrow()

    edit.clearSelection()
    expect(() => host.api.replayPostRenderHighlight(), 'after clearing').not.toThrow()
  })

  it('and a drag survives an edit rendering in the middle of the session', async () => {
    // The sequence the playhead work was written for: drag, move the cursor off
    // it with a key, then let an edit render. The range must not come back from
    // alphaTab's retained selection and wipe the cursor.
    await host.api.dragOverBeats([beatAt(0, 0), beatAt(0, 2)], ON_THE_TAB)
    expect(edit.moveCursorBeat(1).ok).toBe(true)
    expect(edit.selectedRange.value).toBeNull()

    host.api.replayPostRenderHighlight()
    expect(edit.selectedRange.value).toBeNull()
    expect(edit.cursor.value).not.toBeNull()
  })
})

describe('the right arrow makes room at the end of a bar', () => {
  function voiceAt(bar, track = LEAD) {
    return score.tracks[track].staves[0].bars[bar].voices[0]
  }
  function beatAt(bar, index, track = LEAD) {
    return voiceAt(bar, track).beats[index]
  }
  function lastBeat(track = LEAD) {
    const staff = score.tracks[track].staves[0]
    const voice = staff.bars[staff.bars.length - 1].voices[0]
    return voice.beats[voice.beats.length - 1]
  }
  // The arrow as the keyboard sends it: a single press, which may write.
  function pressRight() {
    return edit.moveCursorBeat(1, { canWrite: true })
  }

  // The four cases, in the order they come up while writing.

  it('a bar that is EXACTLY full: on to the next bar', () => {
    // The fixture's bars are four quarters in 4/4, so full.
    clickAt(beatAt(0, 3).notes[0])
    expect(edit.cursorBarFill.value.state).toBe('exact')

    expect(pressRight().ok).toBe(true)
    expect(edit.cursor.value).toMatchObject({ barIndex: 1, beatIndex: 0 })
    expect(voiceAt(0).beats).toHaveLength(4)
  })

  it('a bar that is INCOMPLETE: a rest is inserted after the cursor', () => {
    clickAt(beatAt(0, 3).notes[0])
    expect(edit.changeDuration(DURATION_SHORTER).ok).toBe(true)
    expect(edit.cursorBarFill.value.state).toBe('under')

    const result = pressRight()
    expect(result).toMatchObject({ ok: true, changed: true, inserted: true })
    expect(voiceAt(0).beats).toHaveLength(5)
    expect(edit.cursor.value).toMatchObject({ barIndex: 0, beatIndex: 4, hasNote: false })
    expect(voiceAt(0).beats[4].isRest).toBe(true)
    // The new rest takes the length of the beat it follows.
    expect(voiceAt(0).beats[4].duration).toBe(8)
  })

  it('a bar that is TOO full: a rest is inserted as well, since it is not exactly right', () => {
    clickAt(beatAt(0, 3).notes[0])
    expect(edit.changeDuration(DURATION_LONGER).ok).toBe(true)
    expect(edit.cursorBarFill.value.state).toBe('over')

    expect(pressRight()).toMatchObject({ ok: true, inserted: true })
    expect(voiceAt(0).beats).toHaveLength(5)
    expect(edit.cursor.value).toMatchObject({ barIndex: 0, beatIndex: 4 })
  })

  it('a bar nobody has written into: left alone, and on to the next one', () => {
    // Every voice empty is an implicit whole-bar rest, which reads as exactly
    // full - so the arrow moves on rather than writing into it. That is what
    // lets one press after another add bar after bar with nothing in them.
    clickAt(lastBeat().notes[0])
    const before = score.masterBars.length
    pressRight()
    expect(edit.cursor.value).toMatchObject({ barIndex: before, isUnwritten: true })

    expect(pressRight()).toMatchObject({ ok: true, barIndex: before + 1 })
    expect(score.masterBars).toHaveLength(before + 2)
    // Neither new bar had anything written into it.
    for (const index of [before, before + 1]) {
      expect(voiceAt(index).beats).toHaveLength(1)
      expect(voiceAt(index).isEmpty).toBe(true)
    }
  })

  it('walking mid-bar is plain navigation, whatever the bar holds', () => {
    clickAt(beatAt(0, 3).notes[0])
    edit.changeDuration(DURATION_SHORTER)
    // Back to the first beat: there are beats to the right, so nothing is
    // written even though the bar is now incomplete.
    clickAt(beatAt(0, 0).notes[0])
    expect(pressRight().ok).toBe(true)
    expect(edit.cursor.value).toMatchObject({ beatIndex: 1 })
    expect(voiceAt(0).beats).toHaveLength(4)
    expect(edit.undoDepth.value).toBe(1) // the duration change, and nothing else
  })

  // ---- adding a bar, which is still the end-of-score case ----

  it('past the last beat of the last bar it adds a bar everywhere', () => {
    clickAt(lastBeat().notes[0])
    const before = score.masterBars.length
    const string = edit.cursor.value.string
    const staffCount = score.tracks.reduce((n, t) => n + t.staves.length, 0)
    host.syncedScoreInfo = 0

    const result = pressRight()
    expect(result).toMatchObject({ ok: true, changed: true, barIndex: before, staffCount })
    expect(score.masterBars).toHaveLength(before + 1)
    for (const track of score.tracks) {
      for (const staff of track.staves) expect(staff.bars).toHaveLength(before + 1)
    }

    // On the first beat of the new bar, on the string the arrow was walking.
    expect(edit.cursor.value).toMatchObject({
      barIndex: before,
      beatIndex: 0,
      string,
      isUnwritten: true,
    })
    // The bar count in the document strip had to be re-read.
    expect(host.syncedScoreInfo).toBe(1)
  })

  it('a new bar reads as a whole-bar rest, not as an incomplete one', () => {
    clickAt(lastBeat().notes[0])
    pressRight()
    expect(edit.cursorBarFill.value).toMatchObject({ state: 'exact' })
  })

  it('and then Enter and a digit write into it', () => {
    clickAt(lastBeat().notes[0])
    pressRight()

    // Enter on a bar nobody has written into materialises the rest IN PLACE.
    const rest = edit.insertRest()
    expect(rest).toMatchObject({ ok: true, changed: true, inserted: false })
    expect(edit.cursor.value).toMatchObject({ beatIndex: 0, isUnwritten: false })
    expect(edit.cursorBarFill.value).toMatchObject({ state: 'under', beats: 1 })

    expect(edit.typeFret('7').ok).toBe(true)
    expect(edit.selectedNote.value).toMatchObject({ fret: 7 })
  })

  it('a digit alone writes into the untouched bar too, clearing the placeholder', () => {
    clickAt(lastBeat().notes[0])
    pressRight()

    expect(edit.typeFret('5')).toMatchObject({ ok: true, created: true })
    expect(edit.cursor.value.isUnwritten).toBe(false)
    expect(edit.cursorBarFill.value).toMatchObject({ state: 'under', beats: 1 })
  })

  it('and the arrow then fills that bar, one press at a time', () => {
    // The whole writing loop: a bar, a note, and the arrow making room for the
    // next one until the bar is exactly full.
    clickAt(lastBeat().notes[0])
    pressRight()
    edit.typeFret('5')

    for (const expected of [2, 3, 4]) {
      expect(pressRight().ok, `beat ${expected}`).toBe(true)
      expect(edit.cursor.value.beatIndex).toBe(expected - 1)
      expect(edit.cursorBarFill.value.beats).toBe(expected)
    }
    expect(edit.cursorBarFill.value.state).toBe('exact')

    // Full at last, so the next press moves on and adds the bar after it.
    const bars = score.masterBars.length
    expect(pressRight()).toMatchObject({ ok: true, barIndex: bars })
  })

  // ---- the guards ----

  it('never inserts a BAR in the middle, however the option is passed', () => {
    clickAt(beatAt(0, 3).notes[0])
    const before = score.masterBars.length
    expect(pressRight().ok).toBe(true)
    expect(edit.cursor.value).toMatchObject({ barIndex: 1, beatIndex: 0 })
    expect(score.masterBars).toHaveLength(before)
  })

  it('writes nothing on an auto-repeat: a held key only walks', () => {
    // `canWrite: false` is what the binding passes for `event.repeat`. On an
    // incomplete bar the arrow then crosses to the next bar instead of filling
    // this one at the keyboard's repeat rate.
    clickAt(beatAt(0, 3).notes[0])
    edit.changeDuration(DURATION_SHORTER)
    const depth = edit.undoDepth.value

    expect(edit.moveCursorBeat(1, { canWrite: false }).ok).toBe(true)
    expect(edit.cursor.value).toMatchObject({ barIndex: 1, beatIndex: 0 })
    expect(voiceAt(0).beats).toHaveLength(4)
    expect(edit.undoDepth.value).toBe(depth)
  })

  it('and at the end of the score a repeat stops rather than adding a bar', () => {
    clickAt(lastBeat().notes[0])
    const before = score.masterBars.length
    expect(edit.moveCursorBeat(1, { canWrite: false }).ok).toBe(false)
    expect(score.masterBars).toHaveLength(before)
  })

  it('the left arrow never writes, and never grows the score', () => {
    clickAt(beatAt(0, 0).notes[0])
    const before = score.masterBars.length
    expect(edit.moveCursorBeat(-1, { canWrite: true }).ok).toBe(false)
    expect(score.masterBars).toHaveLength(before)
  })

  // While playing it is a navigation key and nothing else. Refusing with "pause
  // playback to edit" on every incomplete bar would make the arrow useless
  // during playback, which is the one thing the bare arrows have always been
  // good for.
  it('only walks while playing, silently', () => {
    clickAt(beatAt(0, 3).notes[0])
    edit.changeDuration(DURATION_SHORTER)
    player.isPlaying.value = true

    expect(pressRight().ok).toBe(true)
    expect(edit.cursor.value).toMatchObject({ barIndex: 1, beatIndex: 0 })
    expect(voiceAt(0).beats).toHaveLength(4)
  })

  it('and cannot add a bar while playing either', () => {
    clickAt(lastBeat().notes[0])
    const before = score.masterBars.length
    player.isPlaying.value = true

    expect(pressRight().ok).toBe(false)
    expect(score.masterBars).toHaveLength(before)
    // Silent: no message, because nothing was refused - the arrow simply ran out
    // of score.
    expect(edit.editMessage.value).toBeNull()
  })

  // ---- undo ----

  it('takes an inserted beat back out', () => {
    clickAt(beatAt(0, 3).notes[0])
    edit.changeDuration(DURATION_SHORTER)
    pressRight()
    expect(voiceAt(0).beats).toHaveLength(5)

    expect(edit.undo().ok).toBe(true)
    expect(voiceAt(0).beats).toHaveLength(4)
    expect(voiceAt(0).beats.map((b) => b.index)).toEqual([0, 1, 2, 3])
  })

  it('and takes a whole added bar back out', () => {
    clickAt(lastBeat().notes[0])
    const before = score.masterBars.length
    pressRight()

    expect(edit.undo().ok).toBe(true)
    expect(score.masterBars).toHaveLength(before)
    for (const track of score.tracks) {
      for (const staff of track.staves) expect(staff.bars).toHaveLength(before)
    }
    expect(host.dirty).toBe(false)
  })
})
