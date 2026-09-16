/**
 * One owner for the `chrome.debugger` attach lifecycle.
 *
 * Two features need a CDP session on the same tab: the screenshot path (attach,
 * capture, detach) and the console/network buffers (a session that must stay
 * attached to see events). Chrome allows exactly one client per target *per
 * extension*, so when both attached independently the second call was rejected
 * with "Another debugger is already attached to the tab with id: N." — a string
 * that means "this same extension already holds it" (see
 * chrome/browser/extensions/api/debugger/debugger_api.cc, `kAlreadyAttachedError`
 * reached from `FindClientHost()`), while the extension reported it as if
 * DevTools were open. This module makes the two features share one
 * reference-counted session and translates the real refusals apart.
 *
 * @module
 */

/** CDP version this extension attaches with. */
const PROTOCOL_VERSION = '1.3'

/**
 * Why a debugging call failed. Callers branch on this instead of on message
 * text, so the copy can change without changing behavior.
 */
export type CdpFailureReason =
  /** This extension already holds the tab; the session is reusable. */
  | 'own-session'
  /** Another debugger client (DevTools) holds the tab. */
  | 'foreign-debugger'
  /** The page forbids debugging (chrome://, extension pages, protected pages). */
  | 'restricted-page'
  /** The session ended between two commands. */
  | 'detached'
  /** No `chrome.debugger` in this build (Firefox). */
  | 'unsupported'
  /** Anything else; the message carries Chrome's own text. */
  | 'unknown'

/** A capture/session failure the background projects onto a stable tool error code. */
export class CaptureError extends Error {
  readonly code: 'unsupported' | 'action-failed'

  constructor(
    code: 'unsupported' | 'action-failed',
    message: string,
    readonly reason: CdpFailureReason = 'unknown',
  ) {
    super(message)
    this.code = code
    this.name = 'CaptureError'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Translate a raw attach/detach/sendCommand failure into one actionable message. */
export function cdpFailure(error: unknown): CaptureError {
  const message = messageOf(error)
  if (/Another debugger is already attached/i.test(message)) {
    // Chrome only reports this when *this* extension already has a client host
    // for the target, so the existing session is ours to reuse.
    return new CaptureError('action-failed', 'This extension already holds a debugging session for this tab; reusing it.', 'own-session')
  }
  if (/Cannot access|Cannot attach to this target|chrome:\/\//i.test(message)) {
    return new CaptureError('unsupported', 'This page cannot be debugged: Chrome internal, extension, and protected pages do not allow it.', 'restricted-page')
  }
  if (/not attached/i.test(message)) {
    return new CaptureError('action-failed', 'The debugging session ended before the call completed (the user dismissed the debugging notice, or the session was released). Retry to start a new session.', 'detached')
  }
  return new CaptureError('action-failed', `The debugging call failed: ${message}`)
}

/** The refusal a foreign debugger client (DevTools) earns. */
function foreignDebuggerError(): CaptureError {
  return new CaptureError(
    'action-failed',
    'Another debugger (DevTools) is attached to this tab, so Chrome refuses a second one. Close DevTools for that tab and retry; debugging cannot share a tab with an open DevTools window.',
    'foreign-debugger',
  )
}

/** Whether this build can use `chrome.debugger` at all (Firefox cannot). */
export function visionAvailable(): boolean {
  return typeof chrome !== 'undefined' && chrome.debugger !== undefined
}

/** Domains a caller needs enabled on its session. */
export interface DebuggerDomains {
  runtime?: boolean
  log?: boolean
  network?: boolean
  page?: boolean
}

const DOMAIN_FLAGS: Array<[string, keyof DebuggerDomains]> = [
  ['Runtime', 'runtime'],
  ['Log', 'log'],
  ['Network', 'network'],
  ['Page', 'page'],
]

/** One tab's attach state, shared by every feature that needs CDP. */
interface TabSession {
  /** Outstanding holds (one per lease plus the buffer hold). */
  refs: number
  /** Domains this extension has enabled on the session. */
  domains: Set<string>
  /** Whether the debugger attachment currently held was opened by us. */
  attached: boolean
}

const sessions = new Map<number, TabSession>()
/** Serializes attach/enable/release per tab so two holders cannot race. */
const locks = new Map<number, Promise<unknown>>()
/** The persistent hold the console/network buffers keep, if any. */
const bufferHolds = new Map<number, DebuggerLease>()

function sessionFor(tabId: number): TabSession {
  let session = sessions.get(tabId)
  if (session === undefined) {
    session = { refs: 0, domains: new Set(), attached: false }
    sessions.set(tabId, session)
  }
  return session
}

/** Serialize a session mutation for one tab (never nest these calls). */
function withLock<T>(tabId: number, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(tabId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(run)
  locks.set(tabId, next)
  void next.catch(() => undefined).finally(() => {
    if (locks.get(tabId) === next) locks.delete(tabId)
  })
  return next
}

/** Whether `chrome.debugger.getTargets` reports a live client on this tab. */
async function foreignClientAttached(tabId: number): Promise<boolean> {
  const getTargets = (chrome.debugger as { getTargets?: () => Promise<chrome.debugger.TargetInfo[]> }).getTargets
  if (typeof getTargets !== 'function') return false
  try {
    const targets = await getTargets.call(chrome.debugger)
    return targets.some((target) => target.tabId === tabId && target.attached === true)
  } catch {
    return false
  }
}

/** Turn an attach refusal into the copy for whoever actually holds the tab. */
async function attachRefusal(tabId: number, error: unknown): Promise<CaptureError> {
  const failure = cdpFailure(error)
  if (failure.reason !== 'restricted-page') return failure
  // Chrome reports "Cannot attach to this target." both for protected pages and
  // for a tab another client holds. A live foreign attachment tells them apart.
  return await foreignClientAttached(tabId) ? foreignDebuggerError() : failure
}

/** Enable whatever domains the holder asked for on an attached session. */
async function enableDomains(tabId: number, session: TabSession, need: DebuggerDomains): Promise<void> {
  for (const [domain, flag] of DOMAIN_FLAGS) {
    if (need[flag] !== true || session.domains.has(domain)) continue
    await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`)
    session.domains.add(domain)
  }
}

/** A held debugging session; releasing it never detaches another holder's. */
export interface DebuggerLease {
  sendCommand<T = unknown>(method: string, params?: object): Promise<T>
  /** Drop this hold; the attachment closes when the last hold is gone. */
  release(): Promise<void>
}

/**
 * Attach to one tab (or reuse the session this extension already holds) and
 * return a lease. Domains the caller needs are enabled before it returns.
 *
 * @param tabId - the controlled tab.
 * @param need - domains to enable on the session.
 * @returns the lease; call `release()` when done.
 * @throws CaptureError when the tab cannot be debugged or someone else holds it.
 */
export async function acquireDebuggerSession(tabId: number, need: DebuggerDomains = {}): Promise<DebuggerLease> {
  if (!visionAvailable()) {
    throw new CaptureError('unsupported', 'This browser build has no chrome.debugger API (Firefox), so screenshots, console, network, and evaluation are unavailable.', 'unsupported')
  }
  await withLock(tabId, async () => {
    const session = sessionFor(tabId)
    const first = session.refs === 0
    if (first) {
      try {
        await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION)
        session.attached = true
      } catch (error: unknown) {
        const failure = await attachRefusal(tabId, error)
        if (failure.reason !== 'own-session') throw failure
        // A session this extension opened earlier (bookkeeping lost to a service
        // worker restart) is still usable; the domains it has enabled are unknown.
        session.attached = true
        session.domains.clear()
      }
    }
    session.refs += 1
    try {
      await enableDomains(tabId, session, need)
    } catch (error: unknown) {
      session.refs -= 1
      const failure = cdpFailure(error)
      // A reused session can be gone even though Chrome said it was ours; forget
      // it so the next holder attaches again instead of failing forever.
      if (failure.reason === 'detached' || session.refs === 0) {
        session.attached = false
        sessions.delete(tabId)
      }
      throw failure
    }
  })
  let released = false
  return {
    sendCommand: async <T = unknown>(method: string, params?: object): Promise<T> => {
      // Keep the no-params call identical to a bare command.
      return (params === undefined
        ? await chrome.debugger.sendCommand({ tabId }, method)
        : await chrome.debugger.sendCommand({ tabId }, method, params)) as T
    },
    release: async (): Promise<void> => {
      if (released) return
      released = true
      await withLock(tabId, async () => {
        const session = sessions.get(tabId)
        if (session === undefined) return
        // Exactly one decrement per lease, in whatever order leases release.
        session.refs = Math.max(0, session.refs - 1)
        await detachIfIdle(tabId, session)
      })
    },
  }
}

/** Detach when the last hold is gone and we are the ones who attached. */
async function detachIfIdle(tabId: number, session: TabSession): Promise<void> {
  if (session.refs > 0) return
  sessions.delete(tabId)
  if (!session.attached) return
  await chrome.debugger.detach({ tabId }).catch(() => undefined)
}

/**
 * Keep a session attached for the console/network buffers. Idempotent: repeat
 * calls only add the domains they need.
 *
 * @param tabId - the tab whose events should be buffered.
 * @param need - domains to enable.
 */
export async function holdDebuggerSession(tabId: number, need: DebuggerDomains = {}): Promise<void> {
  if (bufferHolds.has(tabId)) {
    await withLock(tabId, async () => {
      const session = sessions.get(tabId)
      if (session === undefined || session.refs === 0) return
      await enableDomains(tabId, session, need)
    })
    return
  }
  bufferHolds.set(tabId, await acquireDebuggerSession(tabId, need))
}

/** Release the buffer hold and detach if nothing else needs the session. */
export async function releaseDebuggerSession(tabId: number): Promise<void> {
  const hold = bufferHolds.get(tabId)
  bufferHolds.delete(tabId)
  if (hold !== undefined) await hold.release()
}

/** Whether this extension currently holds (or believes it holds) a session. */
export function debuggerSessionHeld(tabId: number): boolean {
  const session = sessions.get(tabId)
  return session !== undefined && session.refs > 0 && session.attached
}

/** Forget a session Chrome already detached (the user closed the notice, tab closed). */
export function forgetDebuggerSession(tabId: number): void {
  sessions.delete(tabId)
  bufferHolds.delete(tabId)
}

/**
 * Forget every session without touching Chrome. For tests (each spec stubs its
 * own `chrome.debugger`, and module state would otherwise leak between them).
 */
export function resetDebuggerSessionsForTest(): void {
  sessions.clear()
  locks.clear()
  bufferHolds.clear()
}
