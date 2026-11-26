/**
 * Session-scoped action grants, in memory only.
 *
 * "Allow in this session" exists for actions that cannot be scoped to one
 * origin and therefore have no persistent counterpart: JavaScript execution,
 * header rewriting, dialog answers, cookie reads and writes, response mocking,
 * history moves, and navigations whose destination cannot be pinned down. Such
 * an action runs unprompted for the rest of one dsh session — and only that
 * session.
 *
 * The scope is the pair (session, grant key). The key names the action and,
 * when the call can be pinned to one site, that site too — a grant given on a
 * test site must not silence the same action everywhere. Two sessions driving
 * the same tab keep their own grants, and a grant dies with the binding that
 * defined it — the session is bound to another tab, that tab is closed or
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
 *
 * `browser_debug` is deliberately *not* keyed per action, although one call is
 * "list the scripts" and another is "evaluate in a paused frame". Keying it that
 * way was tried and reverted: a debugging round is five or six calls, so the
 * user got five or six cards in a row, each asking about the same tab — while
 * `browser_eval` has always let one grant cover every later evaluation in the
 * page's own context, which is the more powerful thing. The card still names the
 * action being approved; the grant is for the debugger on this page's session.
 *
 * The optional `scope` is the site {@link scopeLabelForCall} resolved; with it
 * the key covers that site only. Without it (a call whose site cannot be pinned
 * down) the key stays action-wide, as it was before scoping existed.
 */
export function scopeKeyForCall(action: string, args: Record<string, unknown>, scope?: string): string {
  const base = action !== 'browser_network'
    ? action
    : args.mock !== undefined || args.mockClear === true ? `${action}#mock` : action
  return scope === undefined || scope === '' ? base : `${base}@${scope}`
}

/**
 * The actions whose session grant can be narrowed to one site.
 *
 * These are the calls whose effect stays inside the page they were approved
 * on: JavaScript evaluated in one frame, a dialog answer, the debugger on this
 * page, and cookie access, which names its own `url` or `domain`. A grant on a
 * test site covers that site and nothing else.
 *
 * Everything else keeps the action-wide grant it always had, because its effect
 * is not bounded by one site: a header or block `pattern` matches any host the
 * tab requests, `browser_back`/`browser_forward` land on a destination nobody
 * named, and a mocked response is keyed by pattern. Narrowing those would mean
 * inventing a boundary the card never promised.
 */
export const SITE_SCOPABLE_ACTIONS = new Set([
  'browser_eval',
  'browser_dialog',
  'browser_debug',
  'browser_cookies',
])

/**
 * The one site a call can be pinned to, for a session grant.
 *
 * A session grant used to be per action, so allowing `browser_cookies` on one
 * test site also silenced it on every other site for the rest of the session.
 * For the actions in {@link SITE_SCOPABLE_ACTIONS} a grant now covers one site:
 * the `url` the call names, the `domain` a cookie call names, or the single
 * origin the approval card named — in that order.
 *
 * When the call is not site-scopable, or no single site can be established (a
 * tab with frames from several origins), this returns undefined and the grant
 * stays action-wide, exactly as before. The session grant itself is unchanged:
 * the card still offers "Allow in this session"; only its reach narrows.
 *
 * @param action - tool name.
 * @param args - the call's own arguments.
 * @param origins - origins the approval card named.
 */
export function scopeLabelForCall(action: string, args: Record<string, unknown>, origins: readonly string[] = []): string | undefined {
  if (!SITE_SCOPABLE_ACTIONS.has(action)) return undefined
  const namedUrl = typeof args.url === 'string' ? args.url.trim() : ''
  if (namedUrl !== '') {
    try {
      const origin = new URL(namedUrl).origin
      if (origin !== 'null') return origin
    } catch {
      // A malformed url is not a scope; fall through to the card's origins.
    }
  }
  if (action === 'browser_cookies') {
    const domain = typeof args.domain === 'string' ? args.domain.trim().toLowerCase().replace(/^\./, '') : ''
    if (domain !== '') return `domain:${domain}`
  }
  return origins.length === 1 ? origins[0] : undefined
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
  // Debugging is a conversation, not a single call: reading a pause, looking at
  // a frame and resuming are three calls, and each one asking again makes the
  // feature unusable. One grant covers the whole debugger for the session.
  'browser_debug',
  // Cookies are the login state, so they are never trustable — but one swap is
  // at least a read and a write, and a test round is many of both. Asking on
  // every call made the tool unusable for the one job it exists for, which is
  // the same trade `browser_eval` already makes: a session-only grant, dead
  // when the session rebinds, closes the tab, or unbinds.
  'browser_cookies',
  'browser_back',
  'browser_forward',
])
