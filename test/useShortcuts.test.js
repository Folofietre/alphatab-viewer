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

const { BINDINGS, describeBinding, matchesKey, matchesModifiers, shortcutHelp } = await import(
  '@/composables/useShortcuts'
)

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
    expect(resolve(key('ArrowUp', { alt: true, shift: true }))?.label).toMatch(/Up one semitone/)
    expect(resolve(key('ArrowDown', { alt: true, shift: true }))?.label).toMatch(/Down one semitone/)
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

  it('a BARE arrow key now moves the CURSOR, not the note', () => {
    expect(resolve(key('ArrowUp'))?.label).toMatch(/cursor up one string/)
    expect(resolve(key('ArrowDown'))?.label).toMatch(/cursor down one string/)
    expect(resolve(key('ArrowLeft'))?.label).toMatch(/previous beat/)
    expect(resolve(key('ArrowRight'))?.label).toMatch(/Next beat/)
  })

  it('and it still leaves the page scrolling when there is no cursor', () => {
    // This is the whole reason taking the bare arrows is acceptable. The
    // decision has to be reachable from `appliesTo`, because the handler calls
    // preventDefault() BEFORE run - deciding inside run would have killed the
    // scroll either way.
    const idle = { canNavigate: { value: false } }
    const armed = { canNavigate: { value: true } }
    for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      const binding = resolve(key(code))
      expect(binding.appliesTo({ tagName: 'BUTTON' }, null, idle), code).toBe(false)
      expect(binding.appliesTo({ tagName: 'BUTTON' }, null, armed), code).toBe(true)
    }
  })

  it('Shift does not turn a bare arrow into something else', () => {
    // `shift: false` on the two vertical ones keeps them distinct from
    // Alt+Shift+arrow; the horizontal pair declares nothing and ignores it.
    expect(resolve(key('ArrowUp', { shift: true }))).toBeNull()
    expect(resolve(key('ArrowRight', { shift: true }))?.label).toMatch(/Next beat/)
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

describe('redo', () => {
  const redoKey = (mods) => resolve(key('KeyY', mods))

  it('claims Ctrl+Y and Cmd+Y', () => {
    expect(redoKey({ ctrl: true })?.label).toMatch(/Redo/)
    expect(redoKey({ meta: true })?.label).toMatch(/Redo/)
  })

  it('also answers Ctrl+Shift+Z, the other convention', () => {
    expect(resolve(key('KeyZ', { ctrl: true, shift: true }))?.label).toMatch(/Redo/)
  })

  it('leaves a bare Y alone', () => {
    expect(redoKey({})).toBeNull()
  })

  it('matches the CHARACTER, which matters most for Y', () => {
    // On a German QWERTZ layout the key labelled Y sits where QWERTY puts Z.
    expect(resolve(key('KeyZ', { ctrl: true, types: 'y' }))?.label).toMatch(/Redo/)
    // And the key labelled Z on that keyboard undoes, as it should.
    expect(resolve(key('KeyY', { ctrl: true, types: 'z' }))?.label).toMatch(/Undo/)
  })

  it('never resolves to the same binding as undo', () => {
    for (const shift of [false, true]) {
      for (const char of ['y', 'z']) {
        const matches = BINDINGS.filter(
          (b) => matchesKey(b, key('KeyX', { ctrl: true, shift, types: char }))
            && matchesModifiers(b, key('KeyX', { ctrl: true, shift, types: char })),
        )
        expect(matches.length, `${char} shift=${shift}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('does not repeat, so a held key cannot replay the whole stack', () => {
    expect(!!redoKey({ ctrl: true }).allowRepeat).toBe(false)
  })

  it('calls redo and nothing else', () => {
    const calls = []
    const edit = { redo: () => calls.push('redo'), undo: () => calls.push('undo') }
    redoKey({ ctrl: true }).run({}, {}, edit)
    resolve(key('KeyZ', { ctrl: true, shift: true })).run({}, {}, edit)
    expect(calls).toEqual(['redo', 'redo'])
  })
})

describe('Delete replaces the selection with silence', () => {
  it('claims both Delete and Backspace', () => {
    expect(resolve(key('Delete'))?.label).toMatch(/silence/)
    expect(resolve(key('Backspace'))?.label).toMatch(/silence/)
  })

  it('leaves them to the browser under a modifier that is not ours', () => {
    // Ctrl+Backspace deletes a word in a field, Alt+Backspace navigates back on
    // some platforms. Neither is ours - and neither is Alt+Delete.
    for (const mods of [{ ctrl: true }, { alt: true }, { meta: true }]) {
      expect(resolve(key('Backspace', mods))).toBeNull()
    }
    expect(resolve(key('Delete', { alt: true }))).toBeNull()
    // Ctrl+Shift+Delete stays the browser's clear-browsing-data.
    expect(resolve(key('Delete', { ctrl: true, shift: true }))).toBeNull()
  })

  it('but Ctrl+Delete is a different, bigger delete: the whole bar', () => {
    // The pair the modifier separates: the bare key is note-sized, the Ctrl one
    // is bar-sized. The modifier match is exact, so they never collide.
    expect(resolve(key('Delete'))?.label).toMatch(/silence/i)
    expect(resolve(key('Delete', { ctrl: true }))?.label).toBe('Delete this bar')
    expect(resolve(key('Delete', { meta: true }))?.label).toBe('Delete this bar')
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

  it('hands Ctrl+Shift+Z to REDO, not to undo', () => {
    // Distinct actions, and `shift: false` on the undo entries is what keeps the
    // two from both matching.
    expect(undoKey({ ctrl: true, shift: true })?.label).toMatch(/Redo/)
    expect(undoKey({ meta: true, shift: true })?.label).toMatch(/Redo/)
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

describe('the generated help', () => {
  it('names a plain key, a modifier combination and an arrow', () => {
    expect(describeBinding({ code: 'Space' })).toBe('Space')
    expect(describeBinding({ key: 's', modifiers: { ctrl: true } })).toBe('Ctrl/Cmd + S')
    expect(describeBinding({ key: 'z', modifiers: { meta: true } })).toBe('Ctrl/Cmd + Z')
    expect(describeBinding({ code: 'ArrowUp', modifiers: { alt: true } })).toBe('Alt + \u2191')
    expect(
      describeBinding({ code: 'ArrowDown', modifiers: { alt: true, shift: true } }),
    ).toBe('Alt + Shift + \u2193')
  })

  it('does not show a shift the binding merely EXCLUDES', () => {
    // `shift: false` keeps Ctrl+Shift+S off the binding; it is not a key to press.
    expect(describeBinding({ key: 's', modifiers: { ctrl: true, shift: false } })).toBe(
      'Ctrl/Cmd + S',
    )
  })

  it('falls back to the raw code for a key with no display name', () => {
    expect(describeBinding({ code: 'F7' })).toBe('F7')
  })

  it('covers every binding, with no empty cell', () => {
    const rows = shortcutHelp()
    for (const row of rows) {
      expect(row.label.length, JSON.stringify(row)).toBeGreaterThan(0)
      expect(row.keys.length).toBeGreaterThan(0)
      for (const keys of row.keys) expect(keys.length).toBeGreaterThan(0)
    }
    // Every distinct action is listed exactly once.
    expect(new Set(BINDINGS.map((b) => b.label)).size).toBe(rows.length)
  })

  it('shows Ctrl and Cmd as ONE token, since they always come in pairs', () => {
    const rows = shortcutHelp()
    expect(rows.find((r) => r.label.match(/Save the score/)).keys).toEqual(['Ctrl/Cmd + S'])
    expect(rows.find((r) => r.label.match(/Undo/)).keys).toEqual(['Ctrl/Cmd + Z'])
    expect(rows.find((r) => r.label.match(/Redo/)).keys).toEqual([
      'Ctrl/Cmd + Y',
      'Ctrl/Cmd + Shift + Z',
    ])
    expect(rows.find((r) => r.label.match(/silence/)).keys).toEqual(['Delete', 'Backspace'])
  })

  it('and that token is only truthful because every Ctrl has a Cmd twin', () => {
    // The display says both work, so both must exist. Without this, adding a
    // Ctrl-only shortcut would make the help lie.
    const sig = (b) => `${b.key ?? b.code}|${!!b.modifiers?.alt}|${!!b.modifiers?.shift}`
    const ctrl = new Set(BINDINGS.filter((b) => b.modifiers?.ctrl).map(sig))
    const meta = new Set(BINDINGS.filter((b) => b.modifiers?.meta).map(sig))
    expect([...ctrl].sort()).toEqual([...meta].sort())
    expect(ctrl.size).toBeGreaterThan(0)
  })

  it('lists undo before redo, the order they are used in', () => {
    const labels = shortcutHelp().map((r) => r.label)
    expect(labels.findIndex((l) => l.match(/Undo/))).toBeLessThan(
      labels.findIndex((l) => l.match(/Redo/)),
    )
  })

  it('lists one row per distinct action', () => {
    const rows = shortcutHelp()
    expect(new Set(rows.map((r) => r.label)).size).toBe(rows.length)
  })

  it('includes the help key itself, so the modal explains how it opened', () => {
    const rows = shortcutHelp()
    expect(rows.find((r) => r.keys.includes('?'))).toBeDefined()
  })
})

describe('the help modal takes the keyboard', () => {
  it('the "?" binding stands down in a text field, where it is a character', () => {
    const help = BINDINGS.find((b) => b.key === '?')
    expect(help.appliesTo({ tagName: 'INPUT', type: 'text' })).toBe(false)
    expect(help.appliesTo({ tagName: 'TEXTAREA' })).toBe(false)
    expect(help.appliesTo({ tagName: 'BUTTON' })).toBe(true)
  })

  it('resolves whatever combination produces "?" on the layout', () => {
    // Shift is not declared, so it is ignored: US Shift+/ and AZERTY Shift+,
    // both arrive as key "?".
    expect(resolve(key('Slash', { shift: true, types: '?' }))?.label).toMatch(/shortcuts/)
    expect(resolve(key('Comma', { shift: true, types: '?' }))?.label).toMatch(/shortcuts/)
  })

  it('does not resolve under Ctrl, Alt or Meta', () => {
    for (const mods of [{ ctrl: true }, { alt: true }, { meta: true }]) {
      expect(resolve(key('Slash', { ...mods, shift: true, types: '?' }))).toBeNull()
    }
  })
})

// The keys that put something into the score, and the first ones in the table
// that are plain characters.
describe('the writing keys', () => {
  const armed = {
    canNavigate: { value: true },
    canWriteNote: { value: true },
    canChangeDuration: { value: true },
    canEditBars: { value: true },
    DURATION_SHORTER: 'shorter',
    DURATION_LONGER: 'longer',
  }
  const idle = {
    canNavigate: { value: false },
    canWriteNote: { value: false },
    canChangeDuration: { value: false },
    canEditBars: { value: false },
  }

  function digit(character) {
    return { code: `Digit${character}`, key: character, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
  }

  it('all ten digits resolve to ONE action, not ten', () => {
    const labels = new Set()
    for (const character of '0123456789') {
      const binding = resolve(digit(character))
      expect(binding, character).not.toBeNull()
      labels.add(binding.label)
    }
    expect(labels.size).toBe(1)
    expect([...labels][0]).toMatch(/fret/)
  })

  it('and the help says "0-9" rather than listing them', () => {
    const row = shortcutHelp().find((r) => /fret at the cursor/.test(r.label))
    expect(row.keys).toEqual(['0-9'])
  })

  it('the digit that was typed is the one written', () => {
    const edit = { ...armed, typeFret: vi.fn() }
    resolve(digit('7')).run(null, digit('7'), edit)
    expect(edit.typeFret).toHaveBeenCalledWith('7')
  })

  it('a digit under a modifier is left to the browser', () => {
    expect(resolve({ ...digit('5'), ctrlKey: true })).toBeNull()
    expect(resolve({ ...digit('5'), altKey: true })).toBeNull()
  })

  it('plus shortens and minus lengthens, matched by character so the keypad works too', () => {
    const shorter = { ...armed, changeDuration: vi.fn() }
    resolve(key('Equal', { types: '+' })).run(null, null, shorter)
    expect(shorter.changeDuration).toHaveBeenCalledWith('shorter')

    // The numeric keypad reports a different `code` and the same character.
    const alsoShorter = { ...armed, changeDuration: vi.fn() }
    resolve(key('NumpadAdd', { types: '+' })).run(null, null, alsoShorter)
    expect(alsoShorter.changeDuration).toHaveBeenCalledWith('shorter')

    const longer = { ...armed, changeDuration: vi.fn() }
    resolve(key('Minus', { types: '-' })).run(null, null, longer)
    expect(longer.changeDuration).toHaveBeenCalledWith('longer')
  })

  it('Shift is ignored on "+", which needs it on most layouts', () => {
    expect(resolve(key('Equal', { types: '+', shift: true }))?.label).toBe('Shorter note')
  })

  it('Enter is the checkbox toggle on a checkbox and the rest everywhere else', () => {
    // Both bindings match the key; the RESOLVER is what separates them, by
    // asking appliesTo as part of the search. See onKeyDown.
    const both = BINDINGS.filter((b) => b.code === 'Enter')
    expect(both).toHaveLength(2)

    const checkbox = { tagName: 'INPUT', type: 'checkbox' }
    expect(both[0].appliesTo(checkbox)).toBe(true)
    expect(both[1].appliesTo(checkbox, null, armed)).toBe(true)
    // On anything else only the second one applies, which is why it has to come
    // after the first and why appliesTo has to be part of the search.
    expect(both[0].appliesTo({ tagName: 'BUTTON' })).toBe(false)
    // Including a focused BUTTON, which therefore loses its native Enter - the
    // same trade Space already makes, and deliberate: alphaTab's preventDefault
    // keeps focus on whatever was last clicked.
    expect(both[1].appliesTo({ tagName: 'BUTTON' }, null, armed)).toBe(true)
  })

  it('every writing key stands down with no cursor, leaving the character alone', () => {
    for (const event of [digit('4'), key('Equal', { types: '+' }), key('Minus', { types: '-' })]) {
      const binding = resolve(event)
      expect(binding.appliesTo({ tagName: 'BUTTON' }, null, idle), String(event.key)).toBe(false)
    }
    const rest = BINDINGS.filter((b) => b.code === 'Enter')[1]
    expect(rest.appliesTo({ tagName: 'BUTTON' }, null, idle)).toBe(false)
  })

  // The strictest bindings in the table, and they have to be: a digit typed into
  // a tempo field is a digit.
  it('and stands down for every element that owns typing keys', () => {
    const fields = [
      { tagName: 'INPUT', type: 'text' },
      { tagName: 'INPUT', type: 'number' },
      { tagName: 'TEXTAREA' },
      { tagName: 'SELECT' },
      { isContentEditable: true, tagName: 'DIV' },
    ]
    const writers = BINDINGS.filter(
      (b) => Array.isArray(b.key) || b.key === '+' || b.key === '-' ||
        b.label === 'Add a rest, or step along the bar',
    )
    expect(writers).toHaveLength(4)
    for (const binding of writers) {
      for (const field of fields) {
        expect(binding.appliesTo(field, null, armed), `${binding.label} / ${field.tagName}`).toBe(false)
      }
    }
  })

  it('none of them repeats, because each one finishes the score', () => {
    for (const binding of BINDINGS) {
      const writes =
        Array.isArray(binding.key) || binding.key === '+' || binding.key === '-' ||
        binding.label === 'Add a rest, or step along the bar'
      if (writes) expect(!!binding.allowRepeat, binding.label).toBe(false)
    }
  })

  it('Ctrl+Insert and Ctrl+Delete act on whole bars', () => {
    const insert = { ...armed, insertBar: vi.fn() }
    resolve(key('Insert', { ctrl: true })).run(null, null, insert)
    expect(insert.insertBar).toHaveBeenCalled()

    const remove = { ...armed, removeBars: vi.fn() }
    resolve(key('Delete', { ctrl: true })).run(null, null, remove)
    expect(remove.removeBars).toHaveBeenCalled()
  })

  it('and both stand down with nothing designated, or in a text field', () => {
    for (const event of [key('Insert', { ctrl: true }), key('Delete', { ctrl: true })]) {
      const binding = resolve(event)
      expect(binding.appliesTo({ tagName: 'BUTTON' }, null, idle)).toBe(false)
      // Ctrl+Delete in a field is delete-word-forward, which is somebody's.
      expect(binding.appliesTo({ tagName: 'INPUT', type: 'number' }, null, armed)).toBe(false)
      expect(binding.appliesTo({ tagName: 'BUTTON' }, null, armed)).toBe(true)
    }
  })

  it('the help shows them as one row each, under Ctrl/Cmd', () => {
    const rows = shortcutHelp()
    expect(rows.find((r) => r.label === 'Insert a bar before this one').keys)
      .toEqual(['Ctrl/Cmd + Insert'])
    expect(rows.find((r) => r.label === 'Delete this bar').keys)
      .toEqual(['Ctrl/Cmd + Delete'])
  })

  it('the right arrow only writes when the key is NOT repeating', () => {
    // A held arrow walks. Without this it would insert a beat, or append a bar,
    // at the keyboard's repeat rate for as long as the finger is down.
    const binding = resolve(key('ArrowRight'))
    const edit = { ...armed, moveCursorBeat: vi.fn() }

    binding.run(null, { ...key('ArrowRight'), repeat: false }, edit)
    expect(edit.moveCursorBeat).toHaveBeenLastCalledWith(1, { canWrite: true })

    binding.run(null, { ...key('ArrowRight'), repeat: true }, edit)
    expect(edit.moveCursorBeat).toHaveBeenLastCalledWith(1, { canWrite: false })
  })

  it('and the left arrow never writes at all', () => {
    const edit = { ...armed, moveCursorBeat: vi.fn() }
    resolve(key('ArrowLeft')).run(null, key('ArrowLeft'), edit)
    expect(edit.moveCursorBeat).toHaveBeenLastCalledWith(-1)
  })
})

describe('binding options', () => {
  it('declares exactly one of code or key, never both and never neither', () => {
    for (const binding of BINDINGS) {
      expect(Boolean(binding.code) !== Boolean(binding.key), binding.label).toBe(true)
    }
  })

  it('never declares a CHARACTER key by its QWERTY position', () => {
    // The bug this guards, for any shortcut added later: `code: 'KeyZ'` is the
    // position QWERTY gives to Z, which on AZERTY is the key labelled W.
    for (const binding of BINDINGS.filter((b) => b.code)) {
      expect(/^(Key[A-Z]|Digit\d)$/.test(binding.code), binding.label).toBe(false)
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

  it('each binding consults only the arguments it declares a reason for', () => {
    // appliesTo(element, player, edit). Save and Undo stand down when no score
    // is open, so they need the player. The four bare arrows stand down when
    // there is no cursor, and so do the writing keys, so they need the edit
    // state. Everything else looks at the focused element only and must not
    // break when the rest is absent.
    const NEEDS_PLAYER = new Set(['s', 'z', 'y'])
    const NEEDS_EDIT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
    // The three writing keys, which need a cursor: the digits, the two duration
    // keys, and Enter - whose FIRST binding is the checkbox toggle and needs
    // nothing.
    const WRITES = new Set(['+', '-'])
    for (const binding of BINDINGS) {
      const name = String(binding.code ?? binding.key)
      const call = () => binding.appliesTo({ tagName: 'BUTTON' })
      // The bare arrows are the ones with no Alt: Alt+arrow needs nothing.
      const needsEdit =
        (NEEDS_EDIT.has(binding.code) && !binding.modifiers?.alt) ||
        Array.isArray(binding.key) ||
        WRITES.has(binding.key) ||
        binding.label === 'Add a rest, or step along the bar' ||
        // The two bar keys, which need a bar to act on.
        binding.code === 'Insert' ||
        (binding.code === 'Delete' && !!binding.modifiers?.ctrl) ||
        (binding.code === 'Delete' && !!binding.modifiers?.meta)
      if (NEEDS_PLAYER.has(binding.key) || needsEdit) expect(call, name).toThrow()
      else expect(call, name).not.toThrow()
    }
    // And given both, all of them answer.
    const player = { isScoreLoaded: { value: true } }
    const edit = {
      canNavigate: { value: true },
      canWriteNote: { value: true },
      canChangeDuration: { value: true },
      canEditBars: { value: true },
    }
    for (const binding of BINDINGS) {
      expect(typeof binding.appliesTo({ tagName: 'BUTTON' }, player, edit)).toBe('boolean')
    }
  })

  it('the keys that walk somewhere repeat, and no others', () => {
    // Moving a note across the neck, moving the cursor along a line, jumping an
    // octave: all three are gestures someone holds the key for. Play/pause,
    // save, undo and delete are not.
    const WALKS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'])
    for (const binding of BINDINGS) {
      expect(!!binding.allowRepeat, binding.label).toBe(WALKS.has(binding.code))
    }
  })

  it('the note nudges still fire with focus in a text or number field', () => {
    // Load-bearing: alphaTab calls preventDefault() on its mousedown, so
    // clicking a note does NOT move focus out of the field the user last typed
    // in. Standing down here would make "type a tempo, click a note, Alt+arrow"
    // silently do nothing. No text field owns Alt+Up/Down anyway - word-wise
    // caret movement is Alt+Left/Right.
    // Four arrows and the two octave keys.
    const nudges = BINDINGS.filter((b) => b.modifiers?.alt)
    expect(nudges).toHaveLength(6)
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
      // Either a physical key, a character, or a LIST of characters - the digits
      // are one action rather than ten - and never neither.
      const named = binding.code ?? binding.key
      const shape = Array.isArray(named)
        ? named.every((k) => typeof k === 'string' && k.length === 1)
        : typeof named === 'string'
      expect(shape, binding.label).toBe(true)
      // A binding matching several characters has to name itself, or the help
      // table would print one token per character.
      if (Array.isArray(named)) expect(typeof binding.keyName, binding.label).toBe('string')
      expect(typeof binding.label).toBe('string')
      expect(typeof binding.appliesTo).toBe('function')
      expect(typeof binding.run).toBe('function')
    }
  })
})
