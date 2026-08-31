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

  it('defaults to a depth justified by the memory measurements', () => {
    expect(DEFAULT_DEPTH).toBe(30)
    const h = createHistory()
    for (let i = 0; i < DEFAULT_DEPTH + 5; i += 1) h.push(`e${i}`, () => {})
    expect(h.size).toBe(DEFAULT_DEPTH)
  })
})
