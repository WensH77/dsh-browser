/**
 * Session-scoped action grants, in memory only.
 *
 * "Allow in this session" exists for actions that cannot be scoped to one
 * origin and therefore have no persistent counterpart: JavaScript execution,
 * header rewriting, dialog answers, response mocking, history moves, and
 * navigations whose destination cannot be pinned down. Such an action runs
 * unprompted for the rest of one dsh session — and only that session.
 *
 * The scope is the pair (session, grant key), never the origin: two sessions
 * driving the same tab keep their own grants, and a grant dies with the binding
 * that defined it — the session is bound to another tab, that tab is closed or
 * replaced, or the user unbinds — or with the service worker. None of that is
 * durable, which is what keeps a grant from becoming a permission by accident.
 */

/** One session's grant, as much of it as the panel needs to show the user. */
export interface SessionGrant {
  /** Tool name, for example `browser_network`. */
  action: string
  /**
   * Grant key the grant is filed under, for example `browser_network#mock`.
   *
   * The panel lists keys rather than tool names, because the key is what a later
   * call is checked against: a bare list of names would show one `browser_network`
   * entry for two different powers and leave the user guessing which one they
   * still hold.
   */
  key: string
  /** When the grant was given; the panel shows nothing older than the session. */
  grantedAt: number
}

/** Why a session's grants went away. */
export type SessionGrantRevocationReason = 'rebind' | 'closed' | 'replaced' | 'unbound'

/** What one session lost, and why, so the panel can explain an empty list. */
export interface SessionGrantRevocation {
  reason: SessionGrantRevocationReason
  /** How many grants were dropped with it. */
  count: number
}

/**
 * Whether this session may run this grant key without asking again.
 *
 * The key is not always the tool name: `browser_network` that mocks a response
 * and `browser_network` that only lists requests share a name but not a power.
 * A grant given for one path must not silently cover the other, so callers key
 * a call with {@link scopeKeyForCall} and store/read the same string.
 */
export class SessionAllowance {
  private readonly bySession = new Map<string, Map<string, SessionGrant>>()
  /** Last revocation per session, until that session is granted something again. */
  private readonly revocations = new Map<string, SessionGrantRevocation>()

  /** Record a grant under a grant key for one session. */
  remember(sessionId: string, key: string, action: string, now = Date.now()): void {
    const sid = sessionId.trim()
    if (sid === '' || key.trim() === '') return
    const grants = this.bySession.get(sid) ?? new Map<string, SessionGrant>()
    grants.set(key, { action, key, grantedAt: now })
    this.bySession.set(sid, grants)
    // A new grant answers "why was I asked again": the old explanation is stale.
    this.revocations.delete(sid)
  }

  /** Whether the session already holds this grant key. */
  allows(sessionId: string | undefined, key: string): boolean {
    if (sessionId === undefined) return false
    return this.bySession.get(sessionId.trim())?.has(key) === true
  }

  /** Grants of one session, newest first; empty for an unknown session. */
  grantsFor(sessionId: string | undefined): SessionGrant[] {
    if (sessionId === undefined) return []
    return [...(this.bySession.get(sessionId.trim())?.values() ?? [])]
      .sort((a, b) => b.grantedAt - a.grantedAt)
  }

  /**
   * Drop one session's grants and keep the reason.
   *
   * The panel has no other way to tell a dropped grant from an expired one: it
   * only sees that the next call asks again, which reads as "the button did not
   * work". A session that held nothing records nothing — there is no loss to
   * explain, and an explanation with no loss would be noise.
   *
   * @param sessionId - the session whose binding went away.
   * @param reason - what happened to the controlled tab.
   * @returns what was dropped, or undefined when the session held no grant.
   */
  revoke(sessionId: string, reason: SessionGrantRevocationReason): SessionGrantRevocation | undefined {
    const count = this.grantsFor(sessionId).length
    const revoked = this.clear(sessionId)
    if (!revoked) return undefined
    const revocation: SessionGrantRevocation = { reason, count }
    this.revocations.set(sessionId.trim(), revocation)
    return revocation
  }

  /** The last revocation of one session, until it is granted something again. */
  revocationFor(sessionId: string | undefined): SessionGrantRevocation | undefined {
    if (sessionId === undefined) return undefined
    return this.revocations.get(sessionId.trim())
  }

  /** Drop one session's grants; true when it held any. */
  clear(sessionId: string): boolean {
    const sid = sessionId.trim()
    this.revocations.delete(sid)
    return this.bySession.delete(sid)
  }

  /** Drop everything; used when the whole bridge session ends. */
  clearAll(): void {
    this.bySession.clear()
    this.revocations.clear()
  }
}

/**
 * The grant key of one tool call.
 *
 * Response mocking rewrites what the page receives, so it is keyed apart from
 * the read paths that share the tool name — including `mockClear`, which is
 * the same rewrite power pointed at an override the user already allowed.
 */
export function scopeKeyForCall(action: string, args: Record<string, unknown>): string {
  if (action !== 'browser_network') return action
  return args.mock !== undefined || args.mockClear === true ? `${action}#mock` : action
}

/** Whether this action's approval card may offer a session grant at all. */
export function isSessionScopableAction(action: string): boolean {
  return SESSION_SCOPABLE_ACTIONS.has(action)
}

/**
 * Tool names whose approval card offers a session grant.
 *
 * `browser_navigate` is deliberately absent. Its prompt exists because the
 * destination is the risk, so one approved destination must not become
 * permission to navigate anywhere for the rest of the session; those prompts
 * are ended by trusting a site (when the destination is a single origin), or
 * by the explicit cross-domain setting, never by a session grant.
 */
export const SESSION_SCOPABLE_ACTIONS = new Set([
  'browser_network',
  'browser_headers',
  'browser_dialog',
  'browser_eval',
  'browser_back',
  'browser_forward',
])
