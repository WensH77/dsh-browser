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
 * driving the same tab keep their own grants, and a grant dies with the
 * session (unbind, tab close, handoff) or with the service worker, which is
 * what keeps it from becoming a durable permission by accident.
 */

/** One session's grant, as much of it as the panel needs to show the user. */
export interface SessionGrant {
  /** Tool name, for example `browser_network`. */
  action: string
  /** When the grant was given; the panel shows nothing older than the session. */
  grantedAt: number
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

  /** Record a grant under a grant key for one session. */
  remember(sessionId: string, key: string, action: string, now = Date.now()): void {
    const sid = sessionId.trim()
    if (sid === '' || key.trim() === '') return
    const grants = this.bySession.get(sid) ?? new Map<string, SessionGrant>()
    grants.set(key, { action, grantedAt: now })
    this.bySession.set(sid, grants)
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

  /** Drop one session's grants; true when it held any. */
  clear(sessionId: string): boolean {
    return this.bySession.delete(sessionId.trim())
  }

  /** Drop everything; used when the whole bridge session ends. */
  clearAll(): void {
    this.bySession.clear()
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
