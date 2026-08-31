import { describe, it, expect, vi } from 'vitest'

// usePlayer reads the stored master volume at MODULE scope, and useShortcuts
// imports it, so the import fails outright in a Node environment. A two-method
// stub is cheaper and more honest than pulling jsdom in for a suite that only
// inspects plain objects.
//
// `document` is deliberately NOT stubbed here: Vue's runtime-dom probes
// `document.createElement` at import time, so a partial global document breaks
// the import outright. The one test that needs a document stubs it locally.
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

describe('Ctrl+S saves the score', () => {
  const save = (mods) => resolve(key('KeyS', mods))

  it('claims Ctrl+S and Cmd+S, taking them from the browser', () => {
    expect(save({ ctrl: true })?.label).toMatch(/Save the score/)
    expect(save({ meta: true })?.label).toMatch(/Save the score/)
  })

  it('leaves a bare S alone, so it can still be typed', () => {
    expect(save({})).toBeNull()
  })

  it('leaves Ctrl+Shift+S alone: that is Firefox responsive design mode', () => {
    expect(save({ ctrl: true, shift: true })).toBeNull()
    expect(save({ meta: true, shift: true })).toBeNull()
  })

  it('does not resolve with both Ctrl and Meta held', () => {
    expect(save({ ctrl: true, meta: true })).toBeNull()
  })

  it('applies with focus in a text field: no field owns Ctrl+S', () => {
    const binding = save({ ctrl: true })
    const player = { isScoreLoaded: { value: true } }
    for (const el of [
      { tagName: 'INPUT', type: 'text' },
      { tagName: 'INPUT', type: 'number' },
      { tagName: 'SELECT' },
      { tagName: 'BUTTON' },
      null,
    ]) {
      expect(binding.appliesTo(el, player)).toBe(true)
    }
  })

  it('stands down with no score open, leaving Save-page to the browser', () => {
    const binding = save({ ctrl: true })
    expect(binding.appliesTo(null, { isScoreLoaded: { value: false } })).toBe(false)
  })

  it('BLURS the focused field first, so a half-typed name is committed', () => {
    // The edit panels commit text and number fields on `change`, which fires on
    // blur. Without this, typing a new track name and hitting Ctrl+S would
    // export the old one. `change` is dispatched synchronously by blur(), so the
    // order below is the whole guarantee.
    const order = []
    vi.stubGlobal('document', {
      activeElement: { blur: () => order.push('blur') },
    })
    try {
      save({ ctrl: true }).run({}, {}, { download: () => order.push('download') })
      expect(order).toEqual(['blur', 'download'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('saves even with nothing focused', () => {
    let saved = 0
    vi.stubGlobal('document', { activeElement: null })
    try {
      save({ ctrl: true }).run({}, {}, { download: () => (saved += 1) })
      expect(saved).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('binding options', () => {
  it('the save bindings are the only ones that consult the player', () => {
    // appliesTo(element, player): most bindings only look at the focused
    // element, so they must not break when the second argument is absent.
    for (const binding of BINDINGS.filter((b) => b.code !== 'KeyS')) {
      expect(() => binding.appliesTo({ tagName: 'BUTTON' })).not.toThrow()
    }
  })

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
