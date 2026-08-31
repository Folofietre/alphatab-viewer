import { describe, it, expect } from 'vitest'

// usePlayer reads the stored master volume at MODULE scope, and useShortcuts
// imports it, so the import fails outright in a Node environment. A two-method
// stub is cheaper and more honest than pulling jsdom in for a suite that only
// inspects plain objects - nothing here touches a DOM.
globalThis.localStorage ??= {
  getItem: () => null,
  setItem: () => {},
}

const { BINDINGS, matchesModifiers } = await import('@/composables/useShortcuts')

// The keyboard half of the fret nudge, on its own.
//
// Worth pinning separately, because when "Alt + arrow does nothing" there are
// two independent suspects - the key never resolved to a binding, or the
// selection was empty - and only one of them is a keyboard problem. These tests
// take the keyboard one off the table.

// A KeyboardEvent stand-in with the four fields the resolver reads.
function key(code, { alt = false, ctrl = false, meta = false, shift = false } = {}) {
  return { code, altKey: alt, ctrlKey: ctrl, metaKey: meta, shiftKey: shift }
}

function resolve(event) {
  return BINDINGS.find((b) => b.code === event.code && matchesModifiers(b, event)) ?? null
}

describe('binding resolution', () => {
  it('Alt + arrow moves the note ACROSS THE STRINGS, keeping the pitch', () => {
    expect(resolve(key('ArrowUp', { alt: true }))?.label).toMatch(/up one string/)
    expect(resolve(key('ArrowDown', { alt: true }))?.label).toMatch(/down one string/)
  })

  it('Alt + Shift + arrow is the one that changes the PITCH, by a semitone', () => {
    expect(resolve(key('ArrowUp', { alt: true, shift: true }))?.label).toMatch(/semitone up/)
    expect(resolve(key('ArrowDown', { alt: true, shift: true }))?.label).toMatch(/semitone down/)
  })

  it('Shift is what separates the two, so neither is ambiguous', () => {
    // Four bindings share two key codes, so exactly one must match each
    // combination or Alt+Up would fire two actions.
    for (const shift of [false, true]) {
      for (const code of ['ArrowUp', 'ArrowDown']) {
        const matches = BINDINGS.filter(
          (b) => b.code === code && matchesModifiers(b, key(code, { alt: true, shift })),
        )
        expect(matches, `${code} shift=${shift}`).toHaveLength(1)
      }
    }
  })

  it('a BARE arrow key resolves to nothing, so scrolling still works', () => {
    expect(resolve(key('ArrowUp'))).toBeNull()
    expect(resolve(key('ArrowDown'))).toBeNull()
    expect(resolve(key('ArrowUp', { shift: true }))).toBeNull()
  })

  it('does NOT resolve when Ctrl or Meta is also held', () => {
    expect(resolve(key('ArrowUp', { alt: true, ctrl: true }))).toBeNull()
    expect(resolve(key('ArrowUp', { alt: true, meta: true }))).toBeNull()
    expect(resolve(key('ArrowUp', { alt: true, shift: true, ctrl: true }))).toBeNull()
  })

  it('lifting the exclusion for Alt did not open Space to modifiers', () => {
    expect(resolve(key('Space'))?.label).toBe('Play / pause')
    for (const mods of [{ alt: true }, { ctrl: true }, { meta: true }]) {
      expect(resolve(key('Space', mods))).toBeNull()
    }
    // And making Shift significant for the arrows did not make it significant
    // for Space: it declares no `shift`, so Shift+Space still plays.
    expect(resolve(key('Space', { shift: true }))).not.toBeNull()
  })
})

describe('binding options', () => {
  it('only the note nudges repeat on a held key', () => {
    for (const binding of BINDINGS) {
      const shouldRepeat = binding.code === 'ArrowUp' || binding.code === 'ArrowDown'
      expect(!!binding.allowRepeat).toBe(shouldRepeat)
    }
  })

  it('the note nudges still fire with focus in a text or number field', () => {
    // Load-bearing: alphaTab calls preventDefault() on its mousedown, so
    // clicking a note does NOT move focus out of the field the user last typed
    // in. Standing down here would make "type a tempo, click a note, Alt+arrow"
    // silently do nothing. No text field owns Alt+Up/Down anyway - word-wise
    // caret movement is Alt+Left/Right.
    const nudges = BINDINGS.filter((b) => b.modifiers?.alt)
    expect(nudges).toHaveLength(4)
    for (const binding of nudges) {
      expect(binding.appliesTo({ tagName: 'INPUT', type: 'text' })).toBe(true)
      expect(binding.appliesTo({ tagName: 'INPUT', type: 'number' })).toBe(true)
      expect(binding.appliesTo({ tagName: 'TEXTAREA' })).toBe(true)
      expect(binding.appliesTo({ tagName: 'BUTTON' })).toBe(true)
      expect(binding.appliesTo(null)).toBe(true)
    }
  })

  it('the note nudges DO stand down for a select, which owns Alt + Down', () => {
    for (const binding of BINDINGS.filter((b) => b.modifiers?.alt)) {
      expect(binding.appliesTo({ tagName: 'SELECT' })).toBe(false)
      expect(binding.appliesTo({ isContentEditable: true, tagName: 'DIV' })).toBe(false)
    }
  })

  it('Space still stands down for every element that owns typing keys', () => {
    const space = BINDINGS.find((b) => b.code === 'Space')
    for (const el of [
      { tagName: 'INPUT', type: 'text' },
      { tagName: 'INPUT', type: 'number' },
      { tagName: 'TEXTAREA' },
      { tagName: 'SELECT' },
    ]) {
      expect(space.appliesTo(el)).toBe(false)
    }
    expect(space.appliesTo({ tagName: 'BUTTON' })).toBe(true)
  })

  it('every binding declares the fields the resolver needs', () => {
    for (const binding of BINDINGS) {
      expect(typeof binding.code).toBe('string')
      expect(typeof binding.label).toBe('string')
      expect(typeof binding.appliesTo).toBe('function')
      expect(typeof binding.run).toBe('function')
    }
  })
})
