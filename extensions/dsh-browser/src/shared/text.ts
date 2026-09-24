/**
 * One-line shortening, shared by the side panel and the service worker.
 *
 * Both halves show page-authored strings in a bounded space — the panel in its
 * operation feed, the worker in console/network entries — and each had its own
 * copy of this function, character for character. Two copies of a display rule
 * is how one of them quietly gains a different ellipsis or a different trim.
 *
 * @module
 */

/**
 * Collapse whitespace and cut to `max` characters, ending with an ellipsis.
 *
 * The ellipsis is included in `max`, so the result never exceeds the budget
 * (the earlier copies appended it to a full-length slice and returned `max + 1`).
 * Counting is by code point, so the common CJK string shortens by visible
 * character rather than by UTF-16 unit.
 *
 * @param value - the text to shorten.
 * @param max - maximum characters in the result.
 * @returns the shortened text.
 */
export function shorten(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  const points = [...flat]
  if (points.length <= max) return flat
  return `${points.slice(0, Math.max(0, max - 1)).join('')}…`
}
