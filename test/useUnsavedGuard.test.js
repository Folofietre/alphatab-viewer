import { describe, it, expect } from 'vitest'

// usePlayer reads the stored master volume at module scope, and the guard imports
// it, so the import needs this stub in a Node environment.
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} }
const { guardUnload } = await import('@/composables/useUnsavedGuard')

// A BeforeUnloadEvent stand-in that records what was done to it.
function fakeEvent() {
  return {
    prevented: false,
    returnValue: undefined,
    preventDefault() {
      this.prevented = true
    },
  }
}

describe('guardUnload', () => {
  it('blocks the unload when there are unsaved edits', () => {
    const event = fakeEvent()
    expect(guardUnload(event, true)).toBe(true)
    expect(event.prevented).toBe(true)
  })

  it('sets returnValue too, for browsers that only look at that', () => {
    // Chrome and Firefox honour preventDefault(); older WebKit only reads
    // returnValue. Setting both costs a line.
    const event = fakeEvent()
    guardUnload(event, true)
    expect(event.returnValue).toBe('')
  })

  it('does NOTHING when the score is clean', () => {
    // A score that was only looked at, or has just been saved, or whose every
    // edit has been undone. Prompting there would train people to dismiss the
    // dialog without reading it.
    const event = fakeEvent()
    expect(guardUnload(event, false)).toBe(false)
    expect(event.prevented).toBe(false)
    expect(event.returnValue).toBeUndefined()
  })

  it('treats anything falsy as clean', () => {
    for (const value of [false, undefined, null, 0]) {
      const event = fakeEvent()
      expect(guardUnload(event, value)).toBe(false)
      expect(event.prevented).toBe(false)
    }
  })
})
