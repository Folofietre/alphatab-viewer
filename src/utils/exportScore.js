import * as alphaTab from '@coderline/alphatab'

// Saving the edited score back out as a Guitar Pro 7 file.
//
// `Gp7Exporter` writes the data model, so everything the edits in
// scoreEdits.js wrote is in the output by construction - there is no separate
// "apply changes" step. Verified end to end in Node against a real 118-bar
// .gpx: import, edit, export, re-import, and the edits were still there. The
// test suite asserts that round trip for every operation.
//
// Cost worth knowing: the export is synchronous and took ~400ms on that
// 118-bar score, so it blocks the main thread. That is acceptable for a
// deliberate one-shot action, but callers should show a busy state rather than
// leave the button looking dead.

// Characters that break a filename on at least one of the platforms this app
// runs on, plus the C0 control range.
const UNSAFE_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g

// The edited file is NEVER offered under the original name.
//
// A .gp round trip is lossy in ways nothing here controls: alphaTab imports
// what it understands and the exporter writes what it holds, so anything it
// does not model is gone. Handing the user back "song.gp" would invite them to
// overwrite an original they cannot get back.
const EDITED_SUFFIX = ' (edited)'

// Build the download name from the score title, falling back to the name of the
// file that was opened. Both can be missing - a score built from alphaTex has
// no file - hence the last resort.
export function exportFileName(score, sourceFileName) {
  const fromTitle = score?.title?.trim() || ''
  const fromFile = stripExtension(String(sourceFileName ?? '').trim())
  const base = sanitize(fromTitle || fromFile) || 'score'
  return `${base}${EDITED_SUFFIX}.gp`
}

function stripExtension(name) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function sanitize(name) {
  return name.replace(UNSAFE_FILENAME, '-').replace(/\s+/g, ' ').trim().slice(0, 120)
}

// The bytes of the current model as a .gp file. Separate from the download so
// the tests can assert on the bytes without a DOM.
export function exportScoreToGp(score, settings) {
  if (!score) throw new Error('No score to export.')
  return new alphaTab.exporter.Gp7Exporter().export(score, settings ?? null)
}

// Hand the file to the browser.
//
// The object URL is revoked on the next macrotask rather than immediately:
// revoking it in the same tick as the synthetic click cancels the download in
// some browsers, and leaving it un-revoked leaks the whole blob for the life of
// the document.
export function downloadScoreAsGp(score, settings, sourceFileName) {
  const fileName = exportFileName(score, sourceFileName)
  const bytes = exportScoreToGp(score, settings)
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))

  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.rel = 'noopener'
  // Firefox only honours a click on a link that is in the document.
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)

  return { fileName, byteLength: bytes.length }
}

// ---------------------------------------------------------------------------
// Save as: choosing the name and the folder
// ---------------------------------------------------------------------------

// Whether this browser can offer a real save dialog.
//
// `showSaveFilePicker` is the File System Access API, and it is Chromium-only -
// Firefox and Safari have neither shipped it nor said they will. It also needs a
// secure context, which localhost and the deployed https page both are.
//
// Exported so the menu can say which of the two things its item will do, rather
// than promising a folder picker and quietly producing a download.
export function canPickSaveLocation() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
}

// Save, letting the user choose the name and the folder.
//
// Falls back to the ordinary download where the API is missing, which is the
// same thing `Save` does: the user still gets the file, they just do not get to
// say where it lands. `picked` reports which of the two happened.
//
// Returns null when the user CANCELS the dialog, which is not an error and must
// not be reported as one - it is the most likely outcome of opening a save
// dialog by accident.
//
// The picker is opened BEFORE the export runs, and that order matters twice.
// `showSaveFilePicker` must be called from a user gesture, and an await before
// it would spend that gesture; and the export is synchronous and cost ~400ms on
// a 118-bar score, so exporting first would freeze the window before the dialog
// even appeared.
export async function saveScoreAsGp(score, settings, sourceFileName) {
  const suggestedName = exportFileName(score, sourceFileName)
  if (!score) throw new Error('No score to export.')

  if (!canPickSaveLocation()) {
    return { ...downloadScoreAsGp(score, settings, sourceFileName), picked: false }
  }

  let handle
  try {
    handle = await window.showSaveFilePicker({
      suggestedName,
      types: [
        {
          description: 'Guitar Pro 7',
          accept: { 'application/octet-stream': ['.gp'] },
        },
      ],
    })
  } catch (error) {
    if (error?.name === 'AbortError') return null
    throw error
  }

  const bytes = exportScoreToGp(score, settings)
  const writable = await handle.createWritable()
  await writable.write(bytes)
  await writable.close()

  return { fileName: handle.name || suggestedName, byteLength: bytes.length, picked: true }
}
