// A bounded undo stack of RESTORE RECORDS.
//
// Not snapshots. A whole-score snapshot through `JsonConverter` costs 96-152ms
// and 9.4-18.6MB on the two real test scores, so thirty levels would be
// 282-559MB - which is why the plan ruled it out before any of this was built.
// A record here captures only the fields the operation is about to touch:
// 0.3-0.9ms and 8-28KB for the worst case (one fret per note of the biggest
// track), or 233-849KB for thirty levels. About a thousand times less memory.
//
// Several operations need NO captured state at all, because they are a constant
// shift: the inverse of "every fret +2" is "every fret -2", so those records
// hold a closure and nothing else.
//
// Each record is produced by the edit function itself, in scoreEdits.js. That is
// the only place that knows what a given operation touched, and keeping the
// capture next to the write is what stops the two drifting apart.
//
// REDO costs almost nothing here, and the reason is that a record's `restore` is
// a SWAP: calling it exchanges the saved state with the live one, so calling it
// again re-applies the edit. So redo is not a second closure per operation - it
// is the same record, moved to the other stack and called again. That also side-
// steps the trap a "re-run the original operation" redo would hit: an undo has
// already cleared the selection, so anything rebuilt from ambient state would
// refuse.

// Thirty is chosen from the memory above, not from taste: even thirty
// whole-track transpositions of the largest test score stay under a megabyte.
export const DEFAULT_DEPTH = 30

export function createHistory(depth = DEFAULT_DEPTH) {
  // Oldest first, so the newest record is at the end.
  let records = []

  // Records that have been undone. Same objects, waiting to be called again.
  let undone = []

  // True once the bound has thrown a record away.
  //
  // Load-bearing for "is the score back to how it was loaded": an empty stack
  // normally means every edit has been undone, but after 40 edits and 30 undos
  // the stack is also empty while ten edits remain applied. Without this flag
  // the score would be reported clean when it is not.
  let dropped = false

  return {
    // `label` is what the UI offers to undo; `restore` swaps the model back.
    //
    // A NEW edit invalidates everything that had been undone: the branch it would
    // have replayed no longer follows from the current state. That is the
    // standard behaviour of every editor, and getting it wrong would let a redo
    // reapply an edit on top of a model it was never captured against.
    push(label, restore) {
      if (typeof restore !== 'function') return false
      records.push({ label, restore })
      undone = []
      while (records.length > depth) {
        records.shift()
        dropped = true
      }
      return true
    },

    // Undo the most recent edit. Returns its label, or null if there is nothing
    // to undo. The record moves to the redo side whether or not `restore` throws,
    // so a broken record cannot wedge either stack.
    undo() {
      const record = records.pop()
      if (!record) return null
      undone.push(record)
      record.restore()
      return record.label
    },

    // Re-apply the most recently undone edit, by calling the same swap again.
    // Pushes back onto the undo side directly rather than through `push`, which
    // would clear the very stack being consumed.
    redo() {
      const record = undone.pop()
      if (!record) return null
      records.push(record)
      record.restore()
      return record.label
    },

    clear() {
      records = []
      undone = []
      dropped = false
    },

    get size() {
      return records.length
    },

    get redoSize() {
      return undone.length
    },

    // The label of the edit that would be undone next.
    get nextLabel() {
      return records.length > 0 ? records[records.length - 1].label : null
    },

    // The label of the edit that would be redone next.
    get nextRedoLabel() {
      return undone.length > 0 ? undone[undone.length - 1].label : null
    },

    // Every edit has been undone AND none was silently dropped off the end, so
    // the model really is back to how it was loaded.
    get isClean() {
      return records.length === 0 && !dropped
    },

    get hasDropped() {
      return dropped
    },
  }
}
