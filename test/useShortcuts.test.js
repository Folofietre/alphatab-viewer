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

const { BINDINGS, matchesKey, matchesModifiers } = await import('@/composables/useShortcuts')

// The keyboard half of the fret nudge, on its own.
//
// Worth pinning separately, because when "Alt + arrow does nothing" there are
// two independent suspects - the key never resolved to a binding, or the
// selection was empty - and only one of them is a keyboard problem. These tests
// take the keyboard one off the table.

// A KeyboardEvent stand-in.
//
// `code` is the physical key, `key` is the character it produces. They only
// agree on a US layout, which is why `types` exists: it is how a test says "the
// key at THIS position produces THAT character", the situation every non-QWERTY
// layout is in.
function key(code, { alt = false, ctrl = false, meta = false, shift = false, types } = {}) {
  const letter = /^Key([A-Z])$/.exec(code)
  return {
    code,
    key: types ?? (letter ? letter[1].toLowerCase() : code),
    altKey: alt,
    ctrlKey: ctrl,
    metaKey: meta,
    shiftKey: shift,
  }
}

function resolve(event) {
  return BINDINGS.find((b) => matchesKey(b, event) && matchesModifiers(b, event)) ?? null
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

describe('Delete replaces the selection with silence', () => {
  it('claims both Delete and Backspace', () => {
    expect(resolve(key('Delete'))?.label).toMatch(/silence/)
    expect(resolve(key('Backspace'))?.label).toMatch(/silence/)
  })

  it('leaves them to the browser under a modifier', () => {
    // Ctrl+Backspace deletes a word in a field, Alt+Backspace navigates back on
    // some platforms. Neither is ours.
    for (const mods of [{ ctrl: true }, { alt: true }, { meta: true }]) {
      expect(resolve(key('Delete', mods))).toBeNull()
      expect(resolve(key('Backspace', mods))).toBeNull()
    }
  })

  it('stands down wherever the key is the text-editing one', () => {
    for (const code of ['Delete', 'Backspace']) {
      const binding = resolve(key(code))
      for (const el of [
        { tagName: 'INPUT', type: 'text' },
        { tagName: 'INPUT', type: 'number' },
        { tagName: 'TEXTAREA' },
        { tagName: 'SELECT' },
        { isContentEditable: true, tagName: 'DIV' },
      ]) {
        expect(binding.appliesTo(el), `${code} on ${el.tagName}`).toBe(false)
      }
      expect(binding.appliesTo({ tagName: 'BUTTON' })).toBe(true)
      expect(binding.appliesTo(null)).toBe(true)
    }
  })

  it('does not repeat: the delete clears the selection anyway', () => {
    for (const code of ['Delete', 'Backspace']) {
      expect(!!resolve(key(code)).allowRepeat).toBe(false)
    }
  })

  it('calls deleteSelection and nothing else', () => {
    const calls = []
    const edit = {
      deleteSelection: () => calls.push('delete'),
      download: () => calls.push('download'),
    }
    resolve(key('Delete')).run({}, {}, edit)
    resolve(key('Backspace')).run({}, {}, edit)
    expect(calls).toEqual(['delete', 'delete'])
  })
})

describe('Ctrl+Z undoes', () => {
  const undoKey = (mods) => resolve(key('KeyZ', mods))

  it('claims Ctrl+Z and Cmd+Z', () => {
    expect(undoKey({ ctrl: true })?.label).toMatch(/Undo/)
    expect(undoKey({ meta: true })?.label).toMatch(/Undo/)
  })

  it('leaves a bare Z alone', () => {
    expect(undoKey({})).toBeNull()
  })

  it('leaves Ctrl+Shift+Z alone, because redo is not implemented', () => {
    // Aliasing redo to undo would be worse than not answering the key.
    expect(undoKey({ ctrl: true, shift: true })).toBeNull()
    expect(undoKey({ meta: true, shift: true })).toBeNull()
  })

  it('applies with focus in a text field', () => {
    const player = { isScoreLoaded: { value: true } }
    expect(undoKey({ ctrl: true }).appliesTo({ tagName: 'INPUT', type: 'text' }, player)).toBe(true)
  })

  it('stands down with no score open', () => {
    expect(undoKey({ ctrl: true }).appliesTo(null, { isScoreLoaded: { value: false } })).toBe(false)
  })

  it('does not repeat, so a held key cannot unwind the whole stack', () => {
    expect(!!undoKey({ ctrl: true }).allowRepeat).toBe(false)
  })

  it('calls undo and nothing else', () => {
    const calls = []
    const edit = { undo: () => calls.push('undo'), download: () => calls.push('download') }
    undoKey({ ctrl: true }).run({}, {}, edit)
    undoKey({ meta: true }).run({}, {}, edit)
    expect(calls).toEqual(['undo', 'undo'])
  })
})

describe('binding options', () => {
  it('the letter shortcuts match the CHARACTER, not the QWERTY position', () => {
    // The bug this guards: `code: 'KeyZ'` is the position QWERTY gives to Z,
    // which on AZERTY is the key labelled W. Declared by code, Ctrl+Z would fire
    // for Ctrl+W on a French keyboard and not for Ctrl+Z at all.
    for (const binding of BINDINGS) {
      const isLetter = binding.label.match(/Save the score|Undo the last edit/)
      if (isLetter) expect(binding.code, binding.label).toBeUndefined()
      else expect(binding.key, binding.label).toBeUndefined()
    }
  })

  it('Ctrl+Z works on an AZERTY keyboard, where Z sits at the QWERTY W', () => {
    // The physical key reports KeyW; the character it types is z.
    expect(resolve(key('KeyW', { ctrl: true, types: 'z' }))?.label).toMatch(/Undo/)
    // And the key labelled W on that same keyboard must NOT undo, even though it
    // sits where QWERTY puts Z.
    expect(resolve(key('KeyZ', { ctrl: true, types: 'w' }))).toBeNull()
  })

  it('Ctrl+S works on AZERTY too, where S happens not to move', () => {
    expect(resolve(key('KeyS', { ctrl: true, types: 's' }))?.label).toMatch(/Save/)
    expect(resolve(key('KeyQ', { ctrl: true, types: 's' }))?.label).toMatch(/Save/)
  })

  it('and an uppercase character still matches', () => {
    // Nothing declares Shift for these, but a stray capital must not break them.
    expect(matchesKey({ key: 'z' }, { key: 'Z' })).toBe(true)
  })

  it('a binding with neither code nor key matches nothing', () => {
    expect(matchesKey({}, key('KeyZ'))).toBe(false)
  })

  it('only the document-wide bindings consult the player', () => {
    // appliesTo(element, player). Save and Undo stand down when no score is
    // open, so they need the player; every other binding only looks at the
    // focused element and must not break when the second argument is absent.
    // Keyed on the character, since these two are the letter bindings.
    const NEEDS_PLAYER = new Set(['s', 'z'])
    for (const binding of BINDINGS) {
      const name = binding.code ?? binding.key
      const call = () => binding.appliesTo({ tagName: 'BUTTON' })
      if (NEEDS_PLAYER.has(binding.key)) expect(call, name).toThrow()
      else expect(call, name).not.toThrow()
    }
    // And with the player, all of them answer.
    const player = { isScoreLoaded: { value: true } }
    for (const binding of BINDINGS) {
      expect(typeof binding.appliesTo({ tagName: 'BUTTON' }, player)).toBe('boolean')
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
      // Either a physical key or a character, never neither.
      expect(typeof (binding.code ?? binding.key), binding.label).toBe('string')
      expect(typeof binding.label).toBe('string')
      expect(typeof binding.appliesTo).toBe('function')
      expect(typeof binding.run).toBe('function')
    }
  })
})
