import { describe, it, expect, vi } from 'vitest'
import { createHistory, DEFAULT_DEPTH } from '@/utils/scoreHistory'

describe('createHistory', () => {
  it('undoes the most recent record first', () => {
    const order = []
    const h = createHistory()
    h.push('one', () => order.push('one'))
    h.push('two', () => order.push('two'))

    expect(h.undo()).toBe('two')
    expect(h.undo()).toBe('one')
    expect(order).toEqual(['two', 'one'])
  })

  it('reports nothing to undo when empty', () => {
    const h = createHistory()
    expect(h.undo()).toBeNull()
    expect(h.size).toBe(0)
    expect(h.nextLabel).toBeNull()
  })

  it('names the edit that would go next', () => {
    const h = createHistory()
    h.push('rename', () => {})
    h.push('tempo', () => {})
    expect(h.nextLabel).toBe('tempo')
    h.undo()
    expect(h.nextLabel).toBe('rename')
  })

  it('drops the OLDEST record past the bound', () => {
    const h = createHistory(3)
    const kept = []
    for (const label of ['a', 'b', 'c', 'd']) h.push(label, () => kept.push(label))

    expect(h.size).toBe(3)
    // 'a' fell off the bottom, so it can never be undone again.
    expect([h.undo(), h.undo(), h.undo(), h.undo()]).toEqual(['d', 'c', 'b', null])
    expect(kept).toEqual(['d', 'c', 'b'])
  })

  it('knows the score is clean only when nothing was dropped', () => {
    const h = createHistory(2)
    expect(h.isClean).toBe(true)

    h.push('a', () => {})
    h.push('b', () => {})
    h.undo()
    h.undo()
    // Two edits, two undos, nothing dropped: really back to the start.
    expect(h.isClean).toBe(true)
    expect(h.hasDropped).toBe(false)

    h.clear()
    for (const label of ['a', 'b', 'c']) h.push(label, () => {})
    h.undo()
    h.undo()
    // The stack is empty, but 'a' was dropped and is STILL applied. Reporting
    // clean here would lose the user's warning before closing the score.
    expect(h.size).toBe(0)
    expect(h.hasDropped).toBe(true)
    expect(h.isClean).toBe(false)
  })

  it('clear() forgets the drop flag too', () => {
    const h = createHistory(1)
    h.push('a', () => {})
    h.push('b', () => {})
    expect(h.hasDropped).toBe(true)
    h.clear()
    expect(h.isClean).toBe(true)
    expect(h.size).toBe(0)
  })

  it('ignores a record with no restore function', () => {
    const h = createHistory()
    expect(h.push('bad', null)).toBe(false)
    expect(h.push('bad', 'not a function')).toBe(false)
    expect(h.size).toBe(0)
  })

  it('drops a record even if its restore throws, so the stack cannot wedge', () => {
    const h = createHistory()
    h.push('good', () => {})
    h.push('broken', () => {
      throw new Error('nope')
    })
    expect(() => h.undo()).toThrow('nope')
    // The broken record is gone, and the one under it is still reachable.
    expect(h.size).toBe(1)
    expect(h.undo()).toBe('good')
  })

  it('moves an undone record to the redo side and back', () => {
    const calls = []
    const h = createHistory()
    h.push('edit', () => calls.push('swap'))

    expect(h.redoSize).toBe(0)
    expect(h.undo()).toBe('edit')
    expect(h.size).toBe(0)
    expect(h.redoSize).toBe(1)
    expect(h.nextRedoLabel).toBe('edit')

    expect(h.redo()).toBe('edit')
    expect(h.size).toBe(1)
    expect(h.redoSize).toBe(0)
    // The SAME swap ran both times: that is the whole of redo.
    expect(calls).toEqual(['swap', 'swap'])
  })

  it('reports nothing to redo when nothing has been undone', () => {
    const h = createHistory()
    h.push('edit', () => {})
    expect(h.redo()).toBeNull()
    expect(h.nextRedoLabel).toBeNull()
  })

  it('a NEW edit throws away the redo branch', () => {
    // The standard rule, and not cosmetic: a redone edit would be re-applied on
    // top of a model it was never captured against.
    const h = createHistory()
    h.push('first', () => {})
    h.undo()
    expect(h.redoSize).toBe(1)

    h.push('second', () => {})
    expect(h.redoSize).toBe(0)
    expect(h.redo()).toBeNull()
  })

  it('a redo does NOT throw away the branch it is walking', () => {
    const h = createHistory()
    h.push('a', () => {})
    h.push('b', () => {})
    h.undo()
    h.undo()
    expect(h.redoSize).toBe(2)

    expect(h.redo()).toBe('a')
    // Pushing back onto the undo side must not clear what is left to redo.
    expect(h.redoSize).toBe(1)
    expect(h.redo()).toBe('b')
    expect(h.redoSize).toBe(0)
  })

  it('walks a whole stack down and back up in order', () => {
    const order = []
    const h = createHistory()
    for (const label of ['a', 'b', 'c']) h.push(label, () => order.push(label))

    expect([h.undo(), h.undo(), h.undo()]).toEqual(['c', 'b', 'a'])
    expect([h.redo(), h.redo(), h.redo()]).toEqual(['a', 'b', 'c'])
    expect(order).toEqual(['c', 'b', 'a', 'a', 'b', 'c'])
  })

  it('clear() empties both sides', () => {
    const h = createHistory()
    h.push('a', () => {})
    h.undo()
    h.clear()
    expect(h.size).toBe(0)
    expect(h.redoSize).toBe(0)
  })

  it('defaults to a depth justified by the memory measurements', () => {
    expect(DEFAULT_DEPTH).toBe(30)
    const h = createHistory()
    for (let i = 0; i < DEFAULT_DEPTH + 5; i += 1) h.push(`e${i}`, () => {})
    expect(h.size).toBe(DEFAULT_DEPTH)
  })
})
