// The formats alphaTab reads from a binary or text blob.
//
// Shared rather than declared twice: the File menu's picker and the drag-and-drop
// zone must accept exactly the same set, and two lists would drift the first time
// one of them gained a format.
export const SCORE_FILE_ACCEPT = '.gp,.gp3,.gp4,.gp5,.gpx,.xml,.musicxml'
