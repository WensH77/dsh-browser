/**
 * Shared rendering for one page of a ring buffer.
 *
 * Console, network and the pause buffer all page the same way: a one-line head,
 * one line per entry, and a `nextCursor` footer the model feeds back to page
 * on. The footer is the reason this lives on its own rather than in each
 * caller — a truncated page that loses its cursor cannot be continued from.
 *
 * @module
 */

/**
 * Render a paged buffer read so the `nextCursor` line always survives.
 *
 * Entries are capped per read, but the whole page still has to fit the budget,
 * and a plain `slice` at the end used to cut the cursor off — leaving the model
 * with a page it could not page past, and no sign that anything was dropped.
 * The tail is reserved first and only the entries give way.
 *
 * @param head - one-line summary of what this page holds.
 * @param lines - rendered entries, one per line.
 * @param next - cursor to continue from.
 * @param budgetChars - character ceiling for this read.
 * @returns the text to hand back to the model.
 */
export function pageBufferText(head: string, lines: string[], next: number, budgetChars: number): string {
  const footer = `\nnextCursor: ${next}`
  const budget = Math.max(1, Math.floor(budgetChars))
  // The cursor line is the payload that makes the read useful: a page the model
  // cannot continue from is worse than a page with a clipped summary. When the
  // two cannot both fit, the summary gives way, not the cursor.
  if (head.length + footer.length >= budget) {
    return footer.length >= budget ? footer.slice(0, budget) : `${head.slice(0, budget - footer.length)}${footer}`
  }
  const bodyBudget = budget - head.length - footer.length
  if (lines.length === 0) return `${head}${footer}`
  const omittedNotice = (dropped: number): string =>
    dropped > 0 ? `\n(${dropped} further entr${dropped === 1 ? 'y' : 'ies'} omitted: raise maxChars)…` : ''
  // Space for the "N omitted" line is reserved before any entry is kept, so
  // reporting the drop cannot itself push the text past the ceiling.
  const reserve = omittedNotice(lines.length).length
  const entryBudget = Math.max(0, bodyBudget - reserve)
  // Each line after the first costs its characters plus the newline before it;
  // the footer already carries the newline that separates it from the last one.
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const cost = line.length + (kept.length === 0 ? 0 : 1)
    if (used + cost > entryBudget) break
    kept.push(line)
    used += cost
  }
  if (kept.length === 0) {
    const minimal = '\n(entries omitted: raise maxChars)'
    const room = bodyBudget - minimal.length
    return room >= 0
      ? `${head}${minimal}${omittedNotice(lines.length)}${footer}`
      : `${head.slice(0, Math.max(0, budget - footer.length))}${footer}`
  }
  return `${head}\n${kept.join('\n')}${omittedNotice(lines.length - kept.length)}${footer}`
}
