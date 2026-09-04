import { describe, it, expect } from 'vitest'

// usePlayer reads the stored master volume at MODULE scope, so the import fails
// outright in a Node environment without this. A two-method stub is cheaper and
// more honest than pulling jsdom in for a suite that inspects one pure function.
globalThis.localStorage ??= {
  getItem: () => null,
  setItem: () => {},
}

const { restoreAfterMidiReload } = await import('@/composables/usePlayer')

// A synth stand-in that reproduces the ONE side effect this is written around:
// alphaTab's `set playbackRange` moves the playhead to the range's start.
//
//   set playbackRange(value) {
//     this.sequencer.mainPlaybackRange = value;
//     if (value) this.tickPosition = value.startTick;      // 1.8.4
function withRangeSideEffect(tick = 0) {
  const api = {
    tickPosition: tick,
    plays: 0,
    play() {
      this.plays += 1
    },
  }
  let range = null
  Object.defineProperty(api, 'playbackRange', {
    get: () => range,
    set(value) {
      range = value
      if (value) api.tickPosition = value.startTick
    },
    configurable: true,
  })
  return api
}

describe('restoring what a midi rebuild dropped', () => {
  // The bug: a rebuild replaces the sequencer's state object outright
  // (`loadMidi` does `this._mainState = this.createStateFromFile(midiFile)`),
  // and the playback range is a field of that state. So the loop range a drag
  // set was gone after any edit that rebuilt the midi - the sound ran past the
  // end of the selection as though nothing were selected - and because the
  // state is replaced rather than assigned through the setter, no
  // `playbackRangeChanged` fires to say so.
  it('puts the loop range back', () => {
    const api = withRangeSideEffect()
    restoreAfterMidiReload(api, { tick: 0, wasPlaying: false, range: { startTick: 100, endTick: 900 } })
    expect(api.playbackRange).toEqual({ startTick: 100, endTick: 900 })
  })

  it('and the RANGE goes first, or it decides where the playhead lands', () => {
    // Setting the range moves the tick to its start, so a tick restored before
    // the range would be thrown away. 500 is inside the range and is where the
    // playhead really was.
    const api = withRangeSideEffect()
    restoreAfterMidiReload(api, {
      tick: 500,
      wasPlaying: false,
      range: { startTick: 100, endTick: 900 },
    })
    expect(api.playbackRange).toEqual({ startTick: 100, endTick: 900 })
    expect(api.tickPosition).toBe(500)
  })

  it('resumes only if it was playing', () => {
    const playing = withRangeSideEffect()
    restoreAfterMidiReload(playing, { tick: 0, wasPlaying: true, range: null })
    expect(playing.plays).toBe(1)

    const paused = withRangeSideEffect()
    restoreAfterMidiReload(paused, { tick: 0, wasPlaying: false, range: null })
    expect(paused.plays).toBe(0)
  })

  it('leaves the range alone when there was none', () => {
    const api = withRangeSideEffect(0)
    restoreAfterMidiReload(api, { tick: 250, wasPlaying: false, range: null })
    expect(api.playbackRange).toBeNull()
    expect(api.tickPosition).toBe(250)
  })

  it('does not seek to zero, which would fight a fresh load', () => {
    // `tick > 0` guards this: a rebuild on a score that has never played has
    // nothing to put back, and seeking would be a needless synth call.
    const api = withRangeSideEffect(0)
    api.tickPosition = 42
    restoreAfterMidiReload(api, { tick: 0, wasPlaying: false, range: null })
    expect(api.tickPosition).toBe(42)
  })

  it('survives being called with nothing', () => {
    expect(() => restoreAfterMidiReload(null, { tick: 1 })).not.toThrow()
    expect(() => restoreAfterMidiReload(withRangeSideEffect(), null)).not.toThrow()
  })
})
