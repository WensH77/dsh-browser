/**
 * What the panel says about this session's "Allow in this session" grants.
 *
 * The panel used to show nothing about them, so a grant that a binding change
 * threw away looked identical to a grant that was never given: the next call
 * asked again and the button looked broken. Two things fix that — a list of what
 * the session holds, and a reason when the list went empty.
 *
 * The strings are passed in rather than read here, so this module stays
 * locale-free and testable, the same way `op-label.ts` and `approval-buttons.ts`
 * take their copy.
 *
 * @module
 */

import type { SessionGrant, SessionGrantRevocation } from '../security/session-allowance.ts'
import type { SessionGrantsPush } from '../shared/messages.ts'

/** Strings the grant lines need; supplied by the panel for the active locale. */
export interface SessionGrantCopy {
  /** Heading, including its own punctuation — Chinese and English differ here. */
  sessionGrants: string
  /** Stands in for the list when the session holds nothing. */
  sessionGrantsNone: string
  /** Between two grant keys in the list. */
  grantSeparator: string
  /** Reason lines, one per way the binding can go away. */
  revokedRebind: string
  revokedClosed: string
  revokedReplaced: string
  revokedUnbound: string
  /**
   * Wrapped around the dropped-grant count: English reads " (2 grant(s))",
   * Chinese "（2 项授权）".
   */
  revokedCountBefore: string
  revokedCountAfter: string
}

/** The grant fields one panel needs to render. */
export interface SessionGrantsView {
  grants: SessionGrant[]
  grantRevocation: SessionGrantRevocation | null
}

/** What a session holds, as one line: keys, because a key is what a call checks. */
export function grantsLine(view: SessionGrantsView, copy: SessionGrantCopy): string {
  if (view.grants.length === 0) return `${copy.sessionGrants}${copy.sessionGrantsNone}`
  // No backticks around the keys: this line is plain text in a small panel, so
  // markup punctuation would render as itself.
  return `${copy.sessionGrants}${view.grants.map((grant) => grant.key).join(copy.grantSeparator)}`
}

/** Why the previous grants are gone, as one line. */
export function revocationLine(revocation: SessionGrantRevocation, copy: SessionGrantCopy): string {
  const reason = revocation.reason === 'rebind'
    ? copy.revokedRebind
    : revocation.reason === 'closed'
      ? copy.revokedClosed
      : revocation.reason === 'replaced'
        ? copy.revokedReplaced
        : copy.revokedUnbound
  return `${reason}${copy.revokedCountBefore}${revocation.count}${copy.revokedCountAfter}`
}

/**
 * Fold one `push.session-grants` frame into the panel's view.
 *
 * A push names its session, and grants are per session: applying one that
 * belongs to a session nobody is looking at would replace the list on screen
 * with another session's, which is worse than ignoring it. A push without a
 * revocation means a grant was just given, so the previous explanation is stale
 * and goes away with it.
 *
 * @param push - the frame as it arrived.
 * @param viewedSessionId - the session the panel is showing, when it shows one.
 * @param current - the view before this frame.
 * @returns the view after it; `current` unchanged when the frame is unrelated.
 */
export function applySessionGrantsPush(
  push: SessionGrantsPush,
  viewedSessionId: string | undefined,
  current: SessionGrantsView,
): SessionGrantsView {
  if (viewedSessionId === undefined || push.sessionId !== viewedSessionId) return current
  return {
    grants: push.grants,
    grantRevocation: push.revocation ?? null,
  }
}
