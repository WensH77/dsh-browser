/**
 * Console, network, and page-evaluation access over `chrome.debugger`.
 *
 * Unlike a screenshot (attach, capture, detach), console and network are event
 * streams: the session must stay attached for the tab to buffer anything, so
 * one session per tab is kept alive, its domains enabled on demand, and its
 * ring buffers read on `cursor` deltas. Buffers are memory-only and drop with
 * the session (tab closed, user dismissed the debugging notice, DevTools opened).
 *
 * @module
 */

import { bytesToBase64 } from '../shared/base64.ts'
import { pageBufferText } from './buffer-text.ts'
import {
  CaptureError,
  cdpFailure,
  debuggerSessionHeld,
  forgetDebuggerSession,
  holdDebuggerSession,
  releaseDebuggerSession,
} from './debugger-session.ts'
import { dropJsDebug } from './js-debug.ts'
import { shorten } from '../shared/text.ts'
import { recordDebugEvent } from './debug-log.ts'

/** Console entries retained per tab. */
const CONSOLE_BUFFER_MAX = 300
/** Network entries retained per tab. */
const NETWORK_BUFFER_MAX = 200
/** Characters kept per console argument or exception line. */
const ENTRY_TEXT_MAX = 500
/** Characters kept per response body before truncation. */
const BODY_MAX = 20_000

/** One buffered console message. */
interface ConsoleEntry {
  seq: number
  level: string
  text: string
  at: number
}

/** One buffered network request. */
interface NetworkEntry {
  seq: number
  requestId: string
  url: string
  method: string
  resourceType?: string
  status?: number
  failed?: string
  at: number
  endedAt?: number
}

/** One installed response-override rule (Fetch interception). */
interface MockRule {
  pattern: string
  status?: number
  headers?: Array<{ name: string; value: string }>
  body?: string
  fail?: boolean
}

/** Live CDP bookkeeping for one tab (the attach state lives in `debugger-session.ts`). */
interface TabSession {
  console: ConsoleEntry[]
  network: NetworkEntry[]
  networkIndex: Map<string, NetworkEntry>
  consoleSeq: number
  networkSeq: number
  attach?: Promise<void>
  mocks: MockRule[]
  /** Last dialog the page opened, kept so a handler can report what it closed. */
  dialog?: { message: string; type: string }
}

const sessions = new Map<number, TabSession>()

function sessionFor(tabId: number): TabSession {
  let session = sessions.get(tabId)
  if (session === undefined) {
    session = {
      console: [],
      network: [],
      networkIndex: new Map(),
      consoleSeq: 0,
      networkSeq: 0,
      mocks: [],
    }
    sessions.set(tabId, session)
  }
  return session
}

/** Drop every buffer; the attach state is forgotten by the session module. */
function resetSession(tabId: number): void {
  const session = sessions.get(tabId)
  if (session === undefined) return
  session.console = []
  session.network = []
  session.networkIndex.clear()
  session.mocks = []
}

function truncate(value: string, max: number = ENTRY_TEXT_MAX): string {
  return shorten(value, max)
}

/** Render one CDP remote object the way a console line reads. */
function describeRemote(value: unknown): string {
  if (typeof value !== 'object' || value === null) return String(value)
  const object = value as { value?: unknown; unserializableValue?: unknown; description?: unknown; type?: unknown }
  if (object.unserializableValue !== undefined) return String(object.unserializableValue)
  if (typeof object.value === 'string') return object.value
  if (object.value !== undefined) {
    try {
      const json = JSON.stringify(object.value)
      if (json !== undefined) return json
    } catch {
      // Fall through to the description for cyclic values.
    }
  }
  if (typeof object.description === 'string') return object.description
  return typeof object.type === 'string' ? object.type : 'unknown'
}

function pushConsole(tabId: number, level: string, text: string): void {
  const session = sessionFor(tabId)
  session.consoleSeq += 1
  session.console.push({ seq: session.consoleSeq, level, text: truncate(text), at: Date.now() })
  if (session.console.length > CONSOLE_BUFFER_MAX) session.console.splice(0, session.console.length - CONSOLE_BUFFER_MAX)
}

function pushNetwork(tabId: number, patch: Partial<NetworkEntry> & { requestId: string }): void {
  const session = sessionFor(tabId)
  const existing = session.networkIndex.get(patch.requestId)
  if (existing !== undefined) {
    Object.assign(existing, patch)
    return
  }
  session.networkSeq += 1
  const entry: NetworkEntry = {
    seq: session.networkSeq,
    requestId: patch.requestId,
    url: patch.url ?? '',
    method: patch.method ?? 'GET',
    at: patch.at ?? Date.now(),
    ...patch.resourceType === undefined ? {} : { resourceType: patch.resourceType },
    ...patch.status === undefined ? {} : { status: patch.status },
    ...patch.failed === undefined ? {} : { failed: patch.failed },
    ...patch.endedAt === undefined ? {} : { endedAt: patch.endedAt },
  }
  session.network.push(entry)
  session.networkIndex.set(entry.requestId, entry)
  if (session.network.length > NETWORK_BUFFER_MAX) {
    const dropped = session.network.splice(0, session.network.length - NETWORK_BUFFER_MAX)
    for (const dead of dropped) session.networkIndex.delete(dead.requestId)
  }
}

/** Route one CDP event into the owning tab's buffers. */
function onCdpEvent(source: chrome.debugger.Debuggee, method: string, params?: object): void {
  const tabId = source.tabId
  if (tabId === undefined) return
  const session = sessions.get(tabId)
  if (session === undefined) return
  const event = (params ?? {}) as Record<string, unknown>
  switch (method) {
    case 'Runtime.consoleAPICalled': {
      const type = typeof event.type === 'string' ? event.type : 'log'
      const args = Array.isArray(event.args) ? event.args : []
      pushConsole(tabId, type, args.map(describeRemote).join(' '))
      return
    }
    case 'Runtime.exceptionThrown': {
      const details = event.exceptionDetails as { text?: unknown; exception?: { description?: unknown } } | undefined
      const text = typeof details?.exception?.description === 'string'
        ? details.exception.description
        : typeof details?.text === 'string' ? details.text : 'Uncaught error'
      pushConsole(tabId, 'error', text)
      return
    }
    case 'Log.entryAdded': {
      const entry = event.entry as { level?: unknown; text?: unknown } | undefined
      const level = typeof entry?.level === 'string' ? entry.level : 'info'
      pushConsole(tabId, level === 'verbose' ? 'debug' : level, typeof entry?.text === 'string' ? entry.text : '')
      return
    }
    case 'Network.requestWillBeSent': {
      const request = event.request as { url?: unknown; method?: unknown } | undefined
      pushNetwork(tabId, {
        requestId: String(event.requestId ?? ''),
        url: typeof request?.url === 'string' ? request.url : '',
        method: typeof request?.method === 'string' ? request.method : 'GET',
        ...typeof event.type === 'string' ? { resourceType: event.type } : {},
        at: Date.now(),
      })
      return
    }
    case 'Network.responseReceived': {
      const response = event.response as { status?: unknown } | undefined
      pushNetwork(tabId, {
        requestId: String(event.requestId ?? ''),
        ...typeof response?.status === 'number' ? { status: response.status } : {},
        ...typeof event.type === 'string' ? { resourceType: event.type } : {},
      })
      return
    }
    case 'Network.loadingFailed':
      pushNetwork(tabId, {
        requestId: String(event.requestId ?? ''),
        failed: typeof event.errorText === 'string' ? event.errorText : 'failed',
        endedAt: Date.now(),
      })
      return
    case 'Network.loadingFinished':
      pushNetwork(tabId, { requestId: String(event.requestId ?? ''), endedAt: Date.now() })
      return
    case 'Page.javascriptDialogOpening': {
      const type = typeof event.type === 'string' ? event.type : 'alert'
      const message = typeof event.message === 'string' ? event.message : ''
      session.dialog = { message, type }
      // A dialog freezes the page's JS: nothing else can run until it is handled.
      pushConsole(tabId, 'warning', `[dialog:${type}] ${message}`)
      // A `beforeunload` dialog is the page asking whether a navigation may
      // discard its state. Chrome's own dialog is browser UI, not page DOM, so
      // no extension can click it; `chrome.debugger` is the only way to answer
      // it, and leaving it open stalls the navigation the bridge just asked for
      // and every later call behind the frozen renderer. Answer it the way
      // "leave" does. alert/confirm/prompt are deliberately left alone: the
      // model gets to read them and decide with browser_dialog.
      if (type === 'beforeunload') {
        void chrome.debugger
          .sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept: true })
          .then(() => {
            pushConsole(tabId, 'warning', '[dialog:beforeunload] answered "leave" so the navigation could proceed.')
          })
          .catch((error: unknown) => {
            // The tab may have gone away between the event and this command.
            const reason = error instanceof Error ? error.message : String(error)
            pushConsole(tabId, 'warning', `[dialog:beforeunload] could not be answered automatically: ${reason}`)
          })
      }
      return
    }
    case 'Page.javascriptDialogClosed':
      session.dialog = undefined
      return
    case 'Fetch.requestPaused':
      void answerPausedRequest(tabId, event)
      return
    default:
      return
  }
}

/** Convert one model-supplied pattern into a CDP `Fetch` urlPattern glob. */
function toUrlPattern(pattern: string): string {
  return pattern.includes('*') ? pattern : `*${pattern}*`
}

/**
 * Fulfil, fail, or release one paused request according to the installed rules.
 *
 * The most recently installed matching rule wins. Overlapping patterns are
 * normal — a broad prefix pattern installed first, then a narrower one for a
 * single route — and first-match would answer those with the older, broader
 * rule while the tool reported the newer one as active.
 */
async function answerPausedRequest(tabId: number, event: Record<string, unknown>): Promise<void> {
  const requestId = typeof event.requestId === 'string' ? event.requestId : undefined
  if (requestId === undefined) return
  const request = event.request as { url?: unknown } | undefined
  const url = typeof request?.url === 'string' ? request.url : ''
  const session = sessions.get(tabId)
  const rule = lastMatchingRule(session?.mocks ?? [], url)
  try {
    if (rule === undefined) {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId })
      return
    }
    if (rule.fail === true) {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.failRequest', { requestId, errorReason: 'Failed' })
      return
    }
    const body = rule.body ?? ''
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
      requestId,
      responseCode: rule.status ?? 200,
      responseHeaders: (rule.headers ?? [{ name: 'content-type', value: 'text/plain; charset=utf-8' }])
        .map((header) => ({ name: header.name, value: header.value })),
      body: bytesToBase64(new TextEncoder().encode(body)),
    })
  } catch (error: unknown) {
    // A failed *fulfil* must not leave the request paused: the page would wait on
    // it forever (measured: a fetch that never settles). Release it, and keep the
    // reason — this catch used to be silent, which is what hid a body encoder
    // that threw on every mock for weeks.
    console.warn('[dsh-browser] network override could not be applied; releasing the request', error)
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId })
    } catch {
      // The session went away as well; there is nothing left to release.
    }
  }
}

/** Whether one URL matches a model-supplied pattern (substring, or `*` glob). */
function matchesPattern(url: string, pattern: string): boolean {
  if (!pattern.includes('*')) return url.includes(pattern)
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  try {
    return new RegExp(escaped).test(url)
  } catch {
    return url.includes(pattern)
  }
}

/**
 * The last-installed rule matching one URL, or undefined when none does.
 *
 * Installed order is the precedence order: a rule installed later was the
 * user's (or the model's) latest word on that request, so it answers first.
 * Written as a reverse scan rather than `Array.prototype.findLast` because this
 * package compiles against the ES2022 lib.
 */
function lastMatchingRule(mocks: readonly MockRule[], url: string): MockRule | undefined {
  for (let index = mocks.length - 1; index >= 0; index -= 1) {
    const candidate = mocks[index]
    if (candidate !== undefined && matchesPattern(url, candidate.pattern)) return candidate
  }
  return undefined
}

let listenerInstalled = false

function installListener(): void {
  if (listenerInstalled || typeof chrome === 'undefined' || chrome.debugger === undefined) return
  listenerInstalled = true
  chrome.debugger.onEvent.addListener(onCdpEvent)
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId !== undefined) {
      // The one fact a remote report cannot supply any other way: Chrome's own
      // reason for ending the session (canceled_by_user when the debugging
      // notice is dismissed, target_closed, replaced_with_devtools, …).
      recordDebugEvent('detach', `tab ${source.tabId} detached by Chrome: ${reason}`)
      // Chrome detached us (notice dismissed, tab closed): drop the shared
      // bookkeeping so the next call attaches again instead of trusting it.
      // (The JavaScript debugger's own state is cleared by its own listener.)
      forgetDebuggerSession(source.tabId)
      resetSession(source.tabId)
    }
  })
}

/** Domains one call needs enabled; `Runtime` also carries console events. */
interface Domains {
  runtime?: boolean
  log?: boolean
  network?: boolean
  page?: boolean
}

/**
 * Keep one session attached for this tab's event buffers.
 *
 * The attach itself is owned by `debugger-session.ts` so a screenshot taken on
 * the same tab reuses this hold instead of asking Chrome for a second client
 * (which it refuses with a message that reads like DevTools).
 */
async function holdSession(tabId: number, need: Domains): Promise<void> {
  if (typeof chrome === 'undefined' || chrome.debugger === undefined) {
    throw new CaptureError('unsupported', 'This extension has no chrome.debugger API, so console, network, and evaluation tools are unavailable. Reload the extension from chrome://extensions.', 'unsupported')
  }
  installListener()
  // Events route into this tab's buffer record, so it must exist before the
  // first event arrives.
  sessionFor(tabId)
  await holdDebuggerSession(tabId, need)
}

/** Serialize per-tab session work so two calls cannot race the same attach. */
const tabLocks = new Map<number, Promise<unknown>>()

function withTabLock<T>(tabId: number, run: () => Promise<T>): Promise<T> {
  const previous = tabLocks.get(tabId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(run)
  tabLocks.set(tabId, next)
  void next.catch(() => undefined).finally(() => {
    if (tabLocks.get(tabId) === next) tabLocks.delete(tabId)
  })
  return next
}

function answerError(error: unknown): { ok: false; error: { code: 'unsupported' | 'action-failed'; message: string } } {
  const failure = error instanceof CaptureError ? error : cdpFailure(error)
  return { ok: false, error: { code: failure.code, message: failure.message } }
}

/**
 * Open the console and network buffers for a tab before the model asks.
 *
 * Priming exists so the buffers cover what the page itself loaded — a submit
 * request made on load, an early console error — instead of starting at the
 * model's first read. Best effort: callers swallow failures (DevTools open on
 * that tab, a protected page, or a build without `chrome.debugger`).
 *
 * `Page` is part of the set for its events, not for screenshots: Chrome only
 * emits `Page.javascriptDialogOpening` while that domain is enabled, and a
 * `beforeunload` dialog would otherwise arrive unseen and stall navigation.
 *
 * @param tabId - the controlled tab to prime.
 */
export async function primeSession(tabId: number): Promise<void> {
  await withTabLock(tabId, () => holdSession(tabId, { runtime: true, log: true, network: true, page: true }))
}

/** Whether this tab still holds a live debugging session. */
export function isSessionAttached(tabId: number): boolean {
  return debuggerSessionHeld(tabId)
}

/** Detach and forget one tab's session (tab closed, or the bridge session ended). */
export async function detachDevtoolsSession(tabId: number): Promise<void> {
  // Before the detach, while commands still answer: let a paused page go and
  // drop the breakpoints, so closing the session cannot leave either behind.
  await dropJsDebug(tabId)
  await releaseDebuggerSession(tabId)
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Read buffered console output as text, with a cursor for the next call. */
export async function readConsole(
  tabId: number,
  args: Record<string, unknown>,
  budgetChars: number,
): Promise<{ ok: boolean; result?: { text: string }; error?: { code: 'unsupported' | 'action-failed'; message: string } }> {
  try {
    await withTabLock(tabId, () => holdSession(tabId, { runtime: true, log: true }))
    const session = sessionFor(tabId)
    const cursor = numberArg(args, 'cursor') ?? 0
    const limit = Math.min(Math.max(numberArg(args, 'limit') ?? 50, 1), 300)
    const level = stringArg(args, 'level')
    const needle = stringArg(args, 'text')?.toLowerCase()
    const matched = session.console.filter((entry) =>
      entry.seq > cursor
      && (level === undefined || entry.level === level)
      && (needle === undefined || entry.text.toLowerCase().includes(needle)))
    const items = matched.slice(0, limit)
    const lines = items.map((entry) => `[${entry.seq}] ${entry.level}: ${entry.text}`)
    const head = `console entries ${items.length === 0 ? '(none new)' : `(buffer holds ${session.console.length})`}`
    const next = items.length === 0 ? Math.max(cursor, session.consoleSeq) : items[items.length - 1]!.seq
    return { ok: true, result: { text: pageBufferText(head, lines, next, budgetChars) } }
  } catch (error: unknown) {
    return answerError(error)
  }
}

/**
 * Install one response-override rule for the controlled tab and start the
 * `Fetch` interception domain. Matching requests are answered from memory:
 * a synthetic status/headers/body, or an outright failure — this is the only
 * path that can replace response *content* (DNR cannot).
 *
 * @param tabId - the controlled tab.
 * @param rule - pattern plus the synthetic response to serve.
 * @returns rule count for the tab.
 */
export async function installMock(tabId: number, rule: MockRule): Promise<number> {
  await withTabLock(tabId, async () => {
    await holdSession(tabId, {})
    const session = sessionFor(tabId)
    // Mocking one pattern again replaces its response instead of appending a
    // rule the matcher may never reach. Distinct patterns keep their install
    // order, and the most recently installed match answers a request
    // (`lastMatchingRule`), so retrying a mock with corrected CORS headers — or
    // narrowing a broad pattern after it — takes effect.
    const installed = session.mocks.findIndex((candidate) => candidate.pattern === rule.pattern)
    if (installed === -1) session.mocks.push(rule)
    else session.mocks[installed] = rule
    // `Fetch.enable` replaces the pattern set rather than adding to it, so every
    // installed rule has to travel in this one call: sending only the newest
    // pattern silently disabled the earlier ones while the tool still counted
    // them (measured: "2 rule(s)" with only the last one intercepting).
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
      patterns: session.mocks.map((installed) => ({
        urlPattern: toUrlPattern(installed.pattern),
        requestStage: 'Request',
      })),
    })
  })
  return sessionFor(tabId).mocks.length
}

/**
 * Accept or dismiss the JavaScript dialog the page is showing.
 *
 * An `alert`/`confirm`/`prompt` freezes the renderer's main thread, so every
 * other tool (content script, `Runtime.evaluate`) blocks behind it. Handling it
 * over CDP is the only way out without the user clicking the browser's own
 * dialog; the tool reports the message it closed.
 *
 * @param tabId - the controlled tab.
 * @param args - `{ action: 'accept' | 'dismiss', text? }`.
 * @returns the tool answer.
 */
export async function handleDialog(
  tabId: number,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: { text: string }; error?: { code: 'unsupported' | 'action-failed'; message: string } }> {
  const action = args.action
  if (action !== 'accept' && action !== 'dismiss') {
    return { ok: false, error: { code: 'action-failed', message: 'browser_dialog requires action: "accept" or "dismiss".' } }
  }
  try {
    await withTabLock(tabId, () => holdSession(tabId, { page: true }))
    const session = sessionFor(tabId)
    const seen = session.dialog
    const promptText = typeof args.text === 'string' ? args.text : undefined
    await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', {
      accept: action === 'accept',
      ...promptText === undefined ? {} : { promptText },
    })
    session.dialog = undefined
    const described = seen === undefined ? '' : ` It said: "${truncate(seen.message, 300)}" (${seen.type}).`
    return { ok: true, result: { text: `Dialog ${action === 'accept' ? 'accepted' : 'dismissed'}.${described}` } }
  } catch (error: unknown) {
    const failure = error instanceof CaptureError ? error : cdpFailure(error)
    if (/No dialog is showing|no dialog/i.test(failure.message)) {
      // Chrome is the authority on whether a dialog exists: it answered the
      // event stream once, but the dialog is gone now (answered by the user
      // while this tab was detached, or the entry was left behind). Drop it,
      // because `pendingDialog` refuses page-facing calls while it is set.
      const stale = sessions.get(tabId)
      if (stale !== undefined) stale.dialog = undefined
      return { ok: false, error: { code: 'action-failed', message: 'No JavaScript dialog is open on this tab right now, so there is nothing to answer.' } }
    }
    return { ok: false, error: { code: failure.code, message: failure.message } }
  }
}

/**
 * The JavaScript dialog this tab is showing right now, if any.
 *
 * `alert`/`confirm`/`prompt` are browser UI, not DOM: while one is open the
 * tab's renderer is frozen, so a page-facing call waits on it with nothing to
 * show for the wait (measured on d15a: an app-raised `alert` held a
 * `browser_type` for 69s and a `browser_get_text` for 80s, against a 90s
 * per-call budget). Dispatch reads this first and hands the model the dialog
 * instead of the wait; the answer travels over CDP (`handleDialog`), which
 * works while the page is frozen.
 *
 * @param tabId - the controlled tab.
 * @returns the dialog's message and type, or undefined when none is open.
 */
export function pendingDialog(tabId: number): { message: string; type: string } | undefined {
  return sessions.get(tabId)?.dialog
}

/** Drop every response-override rule for one tab and stop intercepting. */
export async function clearMocks(tabId: number): Promise<number> {
  const session = sessions.get(tabId)
  const removed = session?.mocks.length ?? 0
  if (session !== undefined) session.mocks = []
  if (session !== undefined && debuggerSessionHeld(tabId)) {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable').catch(() => undefined)
  }
  return removed
}

/**
 * Validate the model's `mock` argument.
 *
 * @param value - raw argument value.
 * @returns the parsed rule, or undefined when the shape is unusable.
 */
export function parseMockRule(value: unknown): MockRule | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { pattern?: unknown; status?: unknown; headers?: unknown; body?: unknown; fail?: unknown }
  if (typeof candidate.pattern !== 'string' || candidate.pattern.trim() === '') return undefined
  const headers: Array<{ name: string; value: string }> = []
  if (candidate.headers !== undefined) {
    if (!Array.isArray(candidate.headers)) return undefined
    for (const item of candidate.headers) {
      if (typeof item !== 'object' || item === null) return undefined
      const header = item as { name?: unknown; value?: unknown }
      if (typeof header.name !== 'string' || typeof header.value !== 'string') return undefined
      headers.push({ name: header.name, value: header.value })
    }
  }
  return {
    pattern: candidate.pattern,
    ...typeof candidate.status === 'number' && Number.isInteger(candidate.status) ? { status: candidate.status } : {},
    ...headers.length === 0 ? {} : { headers },
    ...typeof candidate.body === 'string' ? { body: candidate.body } : {},
    ...candidate.fail === true ? { fail: true } : {},
  }
}

/** Read buffered network activity, or one response body by request id. */
export async function readNetwork(
  tabId: number,
  args: Record<string, unknown>,
  budgetChars: number,
): Promise<{ ok: boolean; result?: { text: string }; error?: { code: 'unsupported' | 'action-failed'; message: string } }> {
  try {
    await withTabLock(tabId, () => holdSession(tabId, { network: true }))
    const session = sessionFor(tabId)
    const requestId = stringArg(args, 'requestId')
    if (requestId !== undefined) {
      const entry = session.networkIndex.get(requestId)
      if (entry === undefined) {
        return { ok: false, error: { code: 'action-failed', message: `No captured request has id ${requestId}. Call browser_network first and use an id from its list.` } }
      }
      const raw = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId }) as { body?: unknown; base64Encoded?: unknown }
      if (typeof raw.body !== 'string') {
        return { ok: false, error: { code: 'action-failed', message: `Chrome returned no body for ${entry.url} (redirects, streams, and served-from-cache responses may have none).` } }
      }
      const body = raw.base64Encoded === true ? '(binary body, base64 omitted)' : raw.body
      const truncated = body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}\n…(body truncated)` : body
      return { ok: true, result: { text: `${entry.method} ${entry.url}\nstatus: ${entry.status ?? 'unknown'}\n---\n${truncated}` } }
    }
    const cursor = numberArg(args, 'cursor') ?? 0
    const limit = Math.min(Math.max(numberArg(args, 'limit') ?? 50, 1), 200)
    const needle = stringArg(args, 'url')?.toLowerCase()
    const resourceType = stringArg(args, 'resourceType')
    const minStatus = numberArg(args, 'minStatus')
    const matched = session.network.filter((entry) =>
      entry.seq > cursor
      && (needle === undefined || entry.url.toLowerCase().includes(needle))
      && (resourceType === undefined || entry.resourceType === resourceType)
      && (minStatus === undefined || (entry.status ?? 0) >= minStatus))
    const items = matched.slice(0, limit)
    const lines = items.map((entry) => {
      const status = entry.failed !== undefined ? `FAILED ${entry.failed}` : String(entry.status ?? 'pending')
      const ms = entry.endedAt === undefined ? '' : ` ${entry.endedAt - entry.at}ms`
      return `[${entry.seq}] id=${entry.requestId} ${entry.method} ${status}${ms} ${entry.resourceType ?? ''} ${entry.url}`.trimEnd()
    })
    const head = `network entries ${items.length === 0 ? '(none new)' : `(buffer holds ${session.network.length})`}`
    const next = items.length === 0 ? Math.max(cursor, session.networkSeq) : items[items.length - 1]!.seq
    return { ok: true, result: { text: pageBufferText(head, lines, next, budgetChars) } }
  } catch (error: unknown) {
    return answerError(error)
  }
}

/** Evaluate an expression in the page's own world and return its value as text. */
export async function evaluateInPage(
  tabId: number,
  args: Record<string, unknown>,
  budgetChars: number,
): Promise<{ ok: boolean; result?: { text: string }; error?: { code: 'unsupported' | 'action-failed'; message: string } }> {
  const expression = stringArg(args, 'expression')
  if (expression === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'browser_eval requires a non-empty expression.' } }
  }
  // `Runtime.evaluate` runs in the tab's main-frame context: no `contextId` is
  // passed, and none could be honoured without tracking execution contexts.
  // A `frame` argument therefore cannot change what executes, so refuse it
  // rather than let the approval boundary (which does read `args.frame`) and
  // the executing context disagree -- that mismatch could show the user one
  // origin's name while the code ran in another's.
  if (args.frame !== undefined && args.frame !== 0) {
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: 'browser_eval only runs in the main frame of the controlled page. '
          + 'Drop the frame argument, or use browser_eval without a frame; to act inside an iframe use browser_click / '
          + 'browser_type / browser_get_text, which accept a frame index.',
      },
    }
  }
  try {
    await withTabLock(tabId, () => holdSession(tabId, {}))
    const awaited = args.awaitPromise !== false
    const raw = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression,
      awaitPromise: awaited,
      returnByValue: true,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: true,
    }) as { result?: unknown; exceptionDetails?: { text?: unknown; exception?: { description?: unknown } } }
    if (raw.exceptionDetails !== undefined) {
      const details = raw.exceptionDetails
      const text = typeof details.exception?.description === 'string'
        ? details.exception.description
        : typeof details.text === 'string' ? details.text : 'evaluation threw'
      return { ok: true, result: { text: `exception: ${truncate(text, 2_000)}`.slice(0, budgetChars) } }
    }
    const value = describeRemote(raw.result)
    return { ok: true, result: { text: `result: ${truncate(value, 8_000)}`.slice(0, budgetChars) } }
  } catch (error: unknown) {
    return answerError(error)
  }
}
