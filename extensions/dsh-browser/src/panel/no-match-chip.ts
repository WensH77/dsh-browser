/**
 * The operation feed's "no match" chip.
 *
 * A read that succeeded and found nothing is drawn exactly like a read that
 * came back with content: green dot, `done`. The chip is the only thing that
 * says the answer held nothing, so it stays text-only and grey — the red dot
 * and the error colour belong to operations that actually failed.
 *
 * Kept out of the JSX so the rule can be tested without rendering React.
 *
 * @module
 */

import type { RecentOp } from '../shared/messages.ts'

/** The strings the chip needs; supplied by the panel so this stays locale-free. */
export interface NoMatchCopy {
  opNoMatch: string
}

/**
 * The chip label for one operation.
 *
 * @param op - the recorded operation, or the fields of one.
 * @param copy - localized chip text.
 * @returns the label, or undefined for every operation that found something.
 */
export function noMatchLabel(
  op: Pick<RecentOp, 'state' | 'noMatch'>,
  copy: NoMatchCopy,
): string | undefined {
  // `state` is checked as well: the mark is written only by a successful
  // settle, and a chip on a failed operation would contradict its red state.
  if (op.noMatch !== true || op.state !== 'done') return undefined
  return copy.opNoMatch
}
