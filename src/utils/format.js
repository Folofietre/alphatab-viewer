// Format a millisecond duration as m:ss (or h:mm:ss past an hour).
export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const total = Math.floor(ms / 1000)
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (n) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

// alphaTab stores stereo balance as 0-16 with 8 = centre. Show it the way a
// mixer does: C in the middle, L1-L8 and R1-R8 either side.
export function formatBalance(balance) {
  if (!Number.isFinite(balance)) return 'C'
  const offset = Math.round(balance) - 8
  if (offset === 0) return 'C'
  return (offset < 0 ? 'L' : 'R') + Math.abs(offset)
}
