/**
 * Pure decision behind a session's first `browser_navigate`: does this call
 * need a brand-new controlled tab, and if so, which http(s) destination?
 *
 * The caller's contract is the reason this lives on its own: the destination is
 * approved BEFORE `chrome.tabs.create` runs, so a denied or unanswered call
 * issues no network request. Keeping the decision free of Chrome APIs lets that
 * boundary be tested without a background-service stub.
 *
 * @module
 */

/** One `browser_navigate` call plus the session's current binding state. */
export interface UnboundNavigateInput {
  /** Tool name as it arrived over the bridge. */
  name: string
  /** Owning Agent session, absent in direct unit tests. */
  sessionId?: string
  /** Raw model arguments. */
  args: Record<string, unknown>
  /** URL of the tab this session is already bound to, when it has one. */
  boundUrl?: string
}

/**
 * Resolve the destination of an unbound-session navigate.
 *
 * @param input - the call and its session binding state.
 * @param isDshPage - predicate recognizing the dsh web page itself, which is
 *   never handed to a session (the user chats there, so it needs a fresh tab).
 * @returns the http(s) destination to approve and open, or undefined when the
 *   normal bound-tab path should handle this call instead.
 */
export function unboundNavigateDestination(
  input: UnboundNavigateInput,
  isDshPage: (url: string) => boolean,
): URL | undefined {
  const sessionId = input.sessionId
  if (sessionId === undefined || sessionId.trim() === '' || input.name !== 'browser_navigate') return undefined
  if (input.boundUrl !== undefined && !isDshPage(input.boundUrl)) return undefined
  const url = typeof input.args.url === 'string' ? input.args.url : ''
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return undefined
  }
  return target.protocol === 'http:' || target.protocol === 'https:' ? target : undefined
}
