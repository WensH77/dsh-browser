/**
 * JavaScript debugging over the CDP `Debugger` domain: breakpoints, pausing,
 * stepping, and reading a paused call frame.
 *
 * This is the one capability that can *stop* the page. Everything else the
 * bridge does leaves the renderer running, so the failure mode here is new: a
 * paused renderer cannot answer a content-script call at all, and every
 * page-facing tool would sit on it until the per-call budget ran out (measured
 * on the dialog freeze, `session-dab21a53`: 69s and 80s hangs against a 90s
 * budget). Two things keep that from becoming a trap:
 *
 * - `pausedAtBreakpoint` lets the dispatcher refuse page-facing calls *before*
 *   the approval prompt, naming the pause and `browser_debug { action: "resume" }`
 *   as the way out, exactly as the dialog hold does.
 * - The pause state lives in the background, not in the page, so the refusal
 *   and the pause buffer keep working while the renderer is frozen.
 *
 * Sessions are the shared per-tab one (`debugger-session.ts`): this module asks
 * for the `Debugger` domain on it and never attaches on its own. Breakpoints
 * live as long as the session does — closing the tab, dismissing the debugging
 * notice, switching the debugging capability off, or `unbreak { all: true }`
 * clears them.
 *
 * @module
 */

import { pageBufferText } from './buffer-text.ts'
import { CaptureError, cdpFailure, holdDebuggerSession, releaseDebuggerDomain } from './debugger-session.ts'
import { recordDebugEvent } from './debug-log.ts'
import { shorten } from '../shared/text.ts'

/** Scripts retained per tab (newest win; a page can parse thousands). */
const SCRIPT_BUFFER_MAX = 300
/** Pauses retained per tab. */
const PAUSE_BUFFER_MAX = 20
/** Call frames rendered per pause. */
const FRAME_MAX = 40
/** Scope objects rendered for a frame (innermost first). */
const SCOPE_MAX = 4
/** Variables rendered per scope. */
const VARIABLE_MAX = 12
/** Characters kept per variable value. */
const VALUE_MAX = 160
/** Characters kept per expression handed to a call frame. */
const EXPRESSION_MAX = 4_000
/** Script URLs listed by one `scripts` read. */
const SCRIPT_LIST_MAX = 60
/** Characters kept per script URL. */
const SCRIPT_URL_MAX = 200
/** Longest a `wait` may block for the next pause. */
const WAIT_MAX_MS = 20_000
/** Listeners rendered per chain level by one `listeners` read. */
const LISTENER_MAX = 20
/**
 * Levels one `listeners` read walks before `document` is fetched directly.
 *
 * A ceiling on the walk, not a target — it stops early at `document`. Raised from 12 to 24
 * after the first real page it ran on: a preference checkbox sat 12 wrappers deep, so the
 * walk stopped exactly one level short of the level this action exists to read. The direct
 * `document` fetch below is what makes the ceiling safe; this number only decides how much
 * of the middle gets listed.
 */
const LISTENER_CHAIN_MAX = 24
/** Characters kept per listener's script URL. */
const LISTENER_URL_MAX = 160
/**
 * The sentence that keeps a level's "none" from reading as a verdict.
 *
 * A framework can keep its handlers on `document` and dispatch by event target:
 * legacy React 15 does exactly that, in the capture phase because `blur` and
 * `focus` do not bubble. So an input with no listener of its own still submits
 * on blur, and a bare "none" would be a false negative — the failure mode this
 * action exists to avoid, because the alternative was probing with a real
 * interaction that can have side effects on a live product.
 */
const LISTENERS_DELEGATION_NOTE = 'Note: a "none" level is not a verdict. A framework can keep its handlers on document and dispatch by event target — legacy React 15 does exactly that, in the capture phase because blur and focus do not bubble — so an element with no listeners of its own can still respond, and a field can still submit on blur. Watch a real interaction with browser_console or browser_network before concluding that an event does nothing.'

/** One remote object reference, as CDP reports a scope. */
interface ScopeRef {
  type?: unknown
  object?: { objectId?: unknown }
}

/** One parsed script, as `Debugger.scriptParsed` reported it. */
interface ScriptEntry {
  /** Monotonic discovery order, so `scripts` can be read as a cursor. */
  seq: number
  scriptId: string
  url: string
  bytes?: number
}

/** One call frame, kept in the shape the pause report renders. */
interface FrameEntry {
  functionName: string
  /** `Debugger.CallFrame.url`; empty for some frames, hence `scriptId` too. */
  url: string
  /** The script this frame runs in, used to resolve the url when it is empty. */
  scriptId?: string
  line: number
  column: number
  /** CDP handle for this frame; only valid while this pause is the current one. */
  callFrameId: string
  /** Scope chain as reported, used to read variables on demand. */
  scopes: ScopeRef[]
}

/** One buffered pause. */
interface PauseEntry {
  seq: number
  reason: string
  hitBreakpoints: string[]
  frames: FrameEntry[]
  framesOmitted: number
}

/** The tab's current pause, when the renderer is stopped right now. */
interface PausedState {
  seq: number
  reason: string
  frame: FrameEntry
  hitBreakpoints: string[]
}

/** A breakpoint this extension installed, keyed by the id reported to the model. */
interface BreakpointRecord {
  kind: 'line' | 'xhr'
  /** The id the model passes back to `unbreak`. */
  id: string
  label: string
  /** For `xhr` breakpoints: the URL substring CDP matches. */
  url?: string
  condition?: string
}

/** Live JavaScript-debug state for one tab. */
interface TabJsDebug {
  scripts: ScriptEntry[]
  scriptIds: Set<string>
  scriptSeq: number
  pauses: PauseEntry[]
  pauseSeq: number
  breakpoints: Map<string, BreakpointRecord>
  paused?: PausedState
  /** Resolvers waiting for the next pause (`wait` with a timeout). */
  waiters: Array<() => void>
}

const tabs = new Map<number, TabJsDebug>()
let listenerInstalled = false

/**
 * Subscribe to the debugger's events, once.
 *
 * This module keeps its own listeners rather than sharing the console/network
 * router: that router drops events for tabs it has no buffer record for, and a
 * pause must be visible to the dispatcher even on a tab that was never primed.
 * Installing before `Debugger.enable` matters — the enable command replays the
 * script inventory, and those events arrive like any other.
 */
function ensureListener(): void {
  if (listenerInstalled || typeof chrome === 'undefined' || chrome.debugger === undefined) return
  listenerInstalled = true
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined || !method.startsWith('Debugger.')) return
    recordJsDebugEvent(source.tabId, method, (params ?? {}) as Record<string, unknown>)
  })
  // A detach takes the breakpoints and any pause with it, so only this module's
  // copy is left to clear. Owned here, not by the buffer router: `browser_debug`
  // can be the first debugging call on a tab, and a stale pause would refuse
  // every page tool with no way to explain why.
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) forgetJsDebug(source.tabId)
  })
}

/** Tool answer shape, matching the other background handlers. */
type Answer = { ok: boolean; result?: { text: string }; error?: { code: 'unsupported' | 'action-failed'; message: string } }

function stateFor(tabId: number): TabJsDebug {
  let state = tabs.get(tabId)
  if (state === undefined) {
    state = { scripts: [], scriptIds: new Set(), scriptSeq: 0, pauses: [], pauseSeq: 0, breakpoints: new Map(), waiters: [] }
    tabs.set(tabId, state)
  }
  return state
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function answerError(error: unknown): Answer {
  const failure = error instanceof CaptureError ? error : cdpFailure(error)
  return { ok: false, error: { code: failure.code, message: failure.message } }
}

/**
 * The URL of one frame's script.
 *
 * Chrome leaves `Debugger.CallFrame.url` empty for some frames — measured live
 * on a plain `http://127.0.0.1` script, where the pause rendered as
 * `(anonymous script):3:18` — so the frame's `scriptId` is resolved against the
 * inventory built from `Debugger.scriptParsed`, which has the URL. Only a frame
 * whose script is not (or no longer) in that buffer stays anonymous.
 */
function frameUrl(state: TabJsDebug | undefined, frame: FrameEntry): string {
  if (frame.url !== '') return frame.url
  if (frame.scriptId === undefined || state === undefined) return ''
  const script = state.scripts.find((candidate) => candidate.scriptId === frame.scriptId)
  return script?.url ?? ''
}

function locationText(state: TabJsDebug | undefined, frame: FrameEntry): string {
  const url = frameUrl(state, frame)
  const where = url === '' ? '(anonymous script)' : shorten(url, SCRIPT_URL_MAX)
  return `${where}:${frame.line}:${frame.column}`
}

/**
 * Is this tab's renderer stopped at a breakpoint right now?
 *
 * @param tabId - the tab to ask about.
 * @returns a one-line description of the pause, or undefined when it is running.
 */
export function pausedAtBreakpoint(tabId: number): string | undefined {
  const state = tabs.get(tabId)
  const paused = state?.paused
  if (paused === undefined) return undefined
  return `paused at ${locationText(state, paused.frame)} (reason ${paused.reason})`
}

function toFrame(frame: Record<string, unknown>): FrameEntry {
  const location = (frame.location ?? {}) as { lineNumber?: unknown; columnNumber?: unknown; scriptId?: unknown }
  const scopeChain = Array.isArray(frame.scopeChain) ? frame.scopeChain as ScopeRef[] : []
  const scriptId = typeof location.scriptId === 'string' ? location.scriptId : undefined
  return {
    functionName: typeof frame.functionName === 'string' && frame.functionName !== '' ? frame.functionName : '(anonymous)',
    url: typeof frame.url === 'string' ? frame.url : '',
    ...scriptId === undefined ? {} : { scriptId },
    line: typeof location.lineNumber === 'number' ? location.lineNumber : 0,
    column: typeof location.columnNumber === 'number' ? location.columnNumber : 0,
    callFrameId: typeof frame.callFrameId === 'string' ? frame.callFrameId : '',
    scopes: scopeChain.slice(0, SCOPE_MAX),
  }
}

/**
 * Record one `Debugger.*` event.
 *
 * Called by this module's own `chrome.debugger.onEvent` listener (see
 * `ensureListener`): the console/network router drops events for tabs it keeps
 * no buffer record for, and the pause state has to be visible to the dispatcher
 * even for a tab that was never primed.
 *
 * @param tabId - the tab the event came from.
 * @param method - the CDP method name.
 * @param params - the event payload.
 */
export function recordJsDebugEvent(tabId: number, method: string, params: Record<string, unknown>): void {
  switch (method) {
    case 'Debugger.scriptParsed': {
      const scriptId = typeof params.scriptId === 'string' ? params.scriptId : undefined
      if (scriptId === undefined) return
      const state = stateFor(tabId)
      if (state.scriptIds.has(scriptId)) return
      state.scriptIds.add(scriptId)
      const url = typeof params.url === 'string' ? params.url : ''
      const length = typeof params.length === 'number' ? params.length : undefined
      state.scriptSeq += 1
      state.scripts.push({ seq: state.scriptSeq, scriptId, url, ...length === undefined ? {} : { bytes: length } })
      if (state.scripts.length > SCRIPT_BUFFER_MAX) {
        const dropped = state.scripts.splice(0, state.scripts.length - SCRIPT_BUFFER_MAX)
        for (const dead of dropped) state.scriptIds.delete(dead.scriptId)
      }
      return
    }
    case 'Debugger.paused': {
      const state = stateFor(tabId)
      const frames = Array.isArray(params.callFrames) ? params.callFrames as Array<Record<string, unknown>> : []
      const rendered = frames.slice(0, FRAME_MAX).map(toFrame)
      const hit = Array.isArray(params.hitBreakpoints)
        ? params.hitBreakpoints.filter((id): id is string => typeof id === 'string')
        : []
      const reason = typeof params.reason === 'string' ? params.reason : 'other'
      state.pauseSeq += 1
      state.pauses.push({
        seq: state.pauseSeq,
        reason,
        hitBreakpoints: hit,
        frames: rendered,
        framesOmitted: Math.max(0, frames.length - rendered.length),
      })
      if (state.pauses.length > PAUSE_BUFFER_MAX) state.pauses.splice(0, state.pauses.length - PAUSE_BUFFER_MAX)
      const top = rendered[0]
      state.paused = top === undefined ? undefined : { seq: state.pauseSeq, reason, frame: top, hitBreakpoints: hit }
      const waiters = state.waiters
      state.waiters = []
      for (const wake of waiters) wake()
      return
    }
    case 'Debugger.resumed': {
      const state = tabs.get(tabId)
      if (state !== undefined) state.paused = undefined
      return
    }
    default:
      return
  }
}

/**
 * Forget one tab's pauses and breakpoints without touching Chrome.
 *
 * Called when the session is already gone (`onDetach`), where sending
 * `Debugger.disable` would only produce a "not attached" failure.
 *
 * @param tabId - the tab to forget.
 */
export function forgetJsDebug(tabId: number): void {
  const state = tabs.get(tabId)
  tabs.delete(tabId)
  wakeWaiters(state)
}

function wakeWaiters(state: TabJsDebug | undefined): void {
  if (state === undefined || state.waiters.length === 0) return
  const waiters = state.waiters
  state.waiters = []
  for (const wake of waiters) wake()
}

function describeValue(value: unknown): string {
  if (typeof value !== 'object' || value === null) return shorten(String(value), VALUE_MAX)
  const object = value as { value?: unknown; unserializableValue?: unknown; description?: unknown; type?: unknown }
  if (object.unserializableValue !== undefined) return String(object.unserializableValue)
  if (object.value !== undefined) {
    try {
      const json = JSON.stringify(object.value)
      if (json !== undefined) return shorten(json, VALUE_MAX)
    } catch {
      // Cyclic or otherwise unprintable: fall through to the preview.
    }
  }
  if (typeof object.description === 'string') return shorten(object.description, VALUE_MAX)
  return typeof object.type === 'string' ? object.type : 'unknown'
}

/**
 * Read one frame's innermost scope variables.
 *
 * Read on demand rather than at pause time: a page that pauses in a loop would
 * otherwise pay a `Runtime.getProperties` round trip per hit for values nobody
 * reads. Only the *current* pause can answer this — scope object ids stop being
 * valid the moment the page resumes.
 */
async function scopeLines(tabId: number, frame: FrameEntry): Promise<string[]> {
  const lines: string[] = []
  for (const scope of frame.scopes) {
    const type = typeof scope.type === 'string' ? scope.type : 'scope'
    const objectId = scope.object?.objectId
    if (typeof objectId !== 'string') continue
    const properties = await chrome.debugger.sendCommand({ tabId }, 'Runtime.getProperties', {
      objectId,
      ownProperties: true,
      accessorPropertiesOnly: false,
      generatePreview: false,
    }).catch(() => undefined) as { result?: Array<{ name?: unknown; value?: unknown; get?: unknown }> } | undefined
    if (properties === undefined) {
      // An empty list is a real answer (nothing in scope); a failed read is not,
      // and silently printing nothing would read as "no variables".
      lines.push(`      ${type}: (could not be read)`)
      continue
    }
    const entries = (properties.result ?? [])
      .filter((property) => typeof property.name === 'string' && property.get === undefined)
      .slice(0, VARIABLE_MAX)
      .map((property) => `${String(property.name)}=${describeValue(property.value)}`)
    if (entries.length > 0) lines.push(`      ${type}: ${entries.join(', ')}`)
  }
  return lines
}

/** Resolve a model-supplied URL to the one script it names, or report the ambiguity. */
function resolveScriptUrl(scripts: readonly ScriptEntry[], url: string): { url: string; note?: string } | { error: string } {
  if (scripts.some((script) => script.url === url)) return { url }
  const matches = scripts.filter((script) => script.url !== '' && script.url.includes(url))
  if (matches.length === 0) {
    return { url, note: 'No buffered script matches this url yet; the breakpoint still applies if that script loads later.' }
  }
  const unique = [...new Set(matches.map((script) => script.url))]
  if (unique.length === 1) return { url: unique[0]!, note: `Resolved to ${unique[0]}` }
  const listed = unique.slice(0, 5).map((candidate) => `  ${shorten(candidate, SCRIPT_URL_MAX)}`).join('\n')
  return { error: `"${url}" matches ${unique.length} loaded scripts; pass the exact url or a urlRegex instead:\n${listed}` }
}

function breakpointSummary(record: BreakpointRecord): string {
  const condition = record.condition === undefined ? '' : ` condition: ${record.condition}`
  return `id=${record.id} ${record.kind} ${record.label}${condition}`
}

/** `scripts`: list parsed script URLs, newest first, with an optional filter. */
function scriptsAnswer(tabId: number, args: Record<string, unknown>, budgetChars: number): Answer {
  const state = stateFor(tabId)
  const needle = stringArg(args, 'url')?.toLowerCase()
  const cursor = numberArg(args, 'cursor') ?? 0
  const limit = Math.min(Math.max(numberArg(args, 'limit') ?? SCRIPT_LIST_MAX, 1), SCRIPT_BUFFER_MAX)
  // Page forward from the cursor like the console buffer does — an entry this
  // read leaves out must be reachable by the next one — and print the page
  // newest first, which is the order the model is looking for a file in.
  const page = state.scripts
    .filter((script) => script.seq > cursor && (needle === undefined || script.url.toLowerCase().includes(needle)))
    .slice(0, limit)
  const lines = [...page].reverse().map((script) => {
    const size = script.bytes === undefined ? '' : ` (${script.bytes} bytes)`
    return `${script.url === '' ? '(anonymous script)' : shorten(script.url, SCRIPT_URL_MAX)}${size}`
  })
  const head = page.length === 0
    ? `scripts (none new; buffer holds ${state.scripts.length})`
    : `scripts (buffer holds ${state.scripts.length}; newest of this page first)`
  const next = page.length === 0 ? Math.max(cursor, state.scriptSeq) : page[page.length - 1]!.seq
  return { ok: true, result: { text: pageBufferText(head, lines, next, budgetChars) } }
}

async function removeBreakpoint(tabId: number, record: BreakpointRecord): Promise<void> {
  if (record.kind === 'xhr') {
    await chrome.debugger.sendCommand({ tabId }, 'DOMDebugger.removeXHRBreakpoint', { url: record.url ?? '' }).catch(() => undefined)
    return
  }
  await chrome.debugger.sendCommand({ tabId }, 'Debugger.removeBreakpoint', { breakpointId: record.id }).catch(() => undefined)
}

/** `break`: install a line or XHR/fetch breakpoint. */
async function breakAnswer(tabId: number, args: Record<string, unknown>): Promise<Answer> {
  const state = stateFor(tabId)
  const kind = stringArg(args, 'kind') ?? 'line'
  if (kind === 'xhr') {
    const url = stringArg(args, 'url')
    if (url === undefined) {
      return { ok: false, error: { code: 'action-failed', message: 'browser_debug kind "xhr" needs a url: the substring of the request URL to stop on.' } }
    }
    // XHR/fetch breakpoints live in `DOMDebugger`, not `Debugger` — measured
    // live: `Debugger.setXHRBreakpoint` answers -32601 "wasn't found".
    await chrome.debugger.sendCommand({ tabId }, 'DOMDebugger.setXHRBreakpoint', { url })
    const id = `xhr:${url}`
    const record: BreakpointRecord = { kind: 'xhr', id, label: `any XHR/fetch whose URL contains "${url}"`, url }
    state.breakpoints.set(id, record)
    return { ok: true, result: { text: `Breakpoint set: ${breakpointSummary(record)}. The page stops before such a request is sent.` } }
  }
  if (kind !== 'line') {
    return { ok: false, error: { code: 'action-failed', message: `browser_debug kind must be "line" or "xhr", not "${kind}".` } }
  }
  const urlArg = stringArg(args, 'url')
  const urlRegex = stringArg(args, 'urlRegex')
  const lineNumber = numberArg(args, 'lineNumber')
  if (urlArg === undefined && urlRegex === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'browser_debug needs url (exact, or a substring unique among loaded scripts) or urlRegex, plus lineNumber. Action "scripts" lists what is loaded.' } }
  }
  if (lineNumber === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'browser_debug needs lineNumber for a line breakpoint (0-based, the number Chrome stack traces print).' } }
  }
  const condition = stringArg(args, 'condition')
  const columnNumber = numberArg(args, 'columnNumber')
  let url: string | undefined = urlArg
  let note: string | undefined
  if (urlArg !== undefined && urlRegex === undefined) {
    const resolved = resolveScriptUrl(state.scripts, urlArg)
    if ('error' in resolved) return { ok: false, error: { code: 'action-failed', message: resolved.error } }
    url = resolved.url
    note = resolved.note
  }
  const raw = await chrome.debugger.sendCommand({ tabId }, 'Debugger.setBreakpointByUrl', {
    lineNumber,
    ...url === undefined ? {} : { url },
    ...urlRegex === undefined ? {} : { urlRegex },
    ...columnNumber === undefined ? {} : { columnNumber },
    ...condition === undefined ? {} : { condition },
  }) as { breakpointId?: unknown; locations?: Array<{ lineNumber?: unknown; columnNumber?: unknown; scriptId?: unknown }> }
  const id = typeof raw.breakpointId === 'string' ? raw.breakpointId : undefined
  if (id === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'Chrome returned no breakpoint id, so the breakpoint was not installed.' } }
  }
  const label = urlRegex !== undefined
    ? `/ ${urlRegex} / line ${lineNumber}`
    : `${shorten(String(url ?? ''), SCRIPT_URL_MAX)}:${lineNumber}`
  const record: BreakpointRecord = {
    kind: 'line',
    id,
    label,
    ...condition === undefined ? {} : { condition },
  }
  state.breakpoints.set(id, record)
  const locations = (raw.locations ?? []).map((location) => `${location.scriptId ?? '?'}:${location.lineNumber ?? '?'}:${location.columnNumber ?? '?'}`)
  const resolvedText = locations.length === 0
    ? 'No location resolved yet (the script may not be parsed).'
    : `Locations ${locations.join(', ')}.`
  return { ok: true, result: { text: `Breakpoint set: ${breakpointSummary(record)}\n${resolvedText}${note === undefined ? '' : `\n${note}`}` } }
}

/** `unbreak`: remove one breakpoint, or every breakpoint this extension set. */
async function unbreakAnswer(tabId: number, args: Record<string, unknown>): Promise<Answer> {
  const state = stateFor(tabId)
  if (args.all === true) {
    const removed = [...state.breakpoints.values()]
    for (const record of removed) await removeBreakpoint(tabId, record)
    state.breakpoints.clear()
    return {
      ok: true,
      result: { text: removed.length === 0 ? 'No breakpoints were installed for this tab.' : `Removed ${removed.length} breakpoint(s).` },
    }
  }
  const id = stringArg(args, 'id')
  if (id === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'browser_debug needs id (from action "break" or "list"), or all: true to remove every breakpoint.' } }
  }
  const record = state.breakpoints.get(id)
  if (record === undefined) {
    return { ok: false, error: { code: 'action-failed', message: `No breakpoint with id ${id} is installed for this tab. Action "list" shows the ids.` } }
  }
  await removeBreakpoint(tabId, record)
  state.breakpoints.delete(id)
  return { ok: true, result: { text: `Removed ${breakpointSummary(record)}.` } }
}

/** `list`: what is installed, and whether the page is stopped right now. */
function listAnswer(tabId: number): Answer {
  const state = stateFor(tabId)
  const records = [...state.breakpoints.values()]
  const pause = pausedAtBreakpoint(tabId)
  const head = pause === undefined ? 'Breakpoints (page is running)' : `Breakpoints (page is ${pause})`
  if (records.length === 0) return { ok: true, result: { text: `${head}\n(none installed)` } }
  return { ok: true, result: { text: `${head}\n${records.map((record) => `- ${breakpointSummary(record)}`).join('\n')}` } }
}

/** `pause` / `resume` / `step`: move the debugger's execution control. */
async function controlAnswer(tabId: number, action: string, args: Record<string, unknown>): Promise<Answer> {
  if (action === 'pause') {
    await chrome.debugger.sendCommand({ tabId }, 'Debugger.pause')
    return { ok: true, result: { text: 'Pause requested: the tab stops at its next JavaScript statement. Action "wait" reads where it stopped — be aware that the next statement can belong to a script another extension injected into the page (measured live), so a breakpoint on a known url is more precise when you need one particular file.' } }
  }
  if (action === 'resume') {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Debugger.resume')
    } catch (error: unknown) {
      // Chrome's own words here are "Can only perform operation while paused",
      // which reads as a failure when the truth is "already running".
      if (/while paused/i.test(error instanceof Error ? error.message : String(error))) {
        return { ok: true, result: { text: 'The page was not paused, so there was nothing to resume; it is running, and page-facing tools work.' } }
      }
      throw error
    }
    return { ok: true, result: { text: 'Resumed: the page is running again, so page-facing tools work from here.' } }
  }
  const kind = stringArg(args, 'kind') ?? 'over'
  if (kind !== 'over' && kind !== 'into' && kind !== 'out') {
    return { ok: false, error: { code: 'action-failed', message: `browser_debug step kind must be "over", "into" or "out", not "${kind}".` } }
  }
  const method = kind === 'over' ? 'Debugger.stepOver' : kind === 'into' ? 'Debugger.stepInto' : 'Debugger.stepOut'
  await chrome.debugger.sendCommand({ tabId }, method)
  return { ok: true, result: { text: `Step ${kind} requested. Action "wait" reads the new position.` } }
}

/** `eval`: evaluate an expression in a paused call frame. */
async function evalAnswer(tabId: number, args: Record<string, unknown>): Promise<Answer> {
  const state = stateFor(tabId)
  const paused = state.paused
  if (paused === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'The page is not paused, so there is no call frame to evaluate in. Set a breakpoint and call action "wait", or use browser_eval on a running page.' } }
  }
  const expression = stringArg(args, 'expression')
  if (expression === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'browser_debug action "eval" needs an expression.' } }
  }
  if (expression.length > EXPRESSION_MAX) {
    return { ok: false, error: { code: 'action-failed', message: `The expression is longer than ${EXPRESSION_MAX} characters; keep it to the value you need.` } }
  }
  const entry = state.pauses.find((candidate) => candidate.seq === paused.seq)
  const frameIndex = numberArg(args, 'frameIndex') ?? 0
  const frame = entry?.frames[frameIndex]
  if (frame === undefined) {
    return { ok: false, error: { code: 'action-failed', message: `This pause has no frame ${frameIndex}. Action "wait" lists the frames.` } }
  }
  // `Debugger.evaluateOnCallFrame` has no `awaitPromise` (that parameter belongs
  // to `Runtime.evaluate`): a promise comes back as an object. That is the right
  // answer here anyway — a paused page cannot settle one, because the microtask
  // queue only drains on resume.
  const raw = await chrome.debugger.sendCommand({ tabId }, 'Debugger.evaluateOnCallFrame', {
    callFrameId: frame.callFrameId,
    expression,
    returnByValue: true,
    silent: false,
  }) as { result?: unknown; exceptionDetails?: { text?: unknown; exception?: { description?: unknown } } }
  if (raw.exceptionDetails !== undefined) {
    const text = typeof raw.exceptionDetails.exception?.description === 'string'
      ? raw.exceptionDetails.exception.description
      : typeof raw.exceptionDetails.text === 'string' ? raw.exceptionDetails.text : 'evaluation threw'
    return { ok: true, result: { text: `exception in ${frame.functionName}: ${shorten(text, 2_000)}` } }
  }
  return { ok: true, result: { text: `result: ${shorten(describeValue(raw.result), 8_000)}` } }
}

/** `wait`: read buffered pauses, optionally waiting for the next one. */
async function waitAnswer(tabId: number, args: Record<string, unknown>, budgetChars: number): Promise<Answer> {
  const state = stateFor(tabId)
  const cursor = numberArg(args, 'cursor') ?? 0
  const timeoutMs = Math.min(Math.max(numberArg(args, 'timeoutMs') ?? 0, 0), WAIT_MAX_MS)
  const limit = Math.min(Math.max(numberArg(args, 'limit') ?? 5, 1), PAUSE_BUFFER_MAX)
  if (timeoutMs > 0 && !state.pauses.some((entry) => entry.seq > cursor)) {
    await new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        state.waiters = state.waiters.filter((candidate) => candidate !== wake)
        resolve()
      }, timeoutMs)
      state.waiters.push(wake)
    })
  }
  // Oldest first, like the console and network reads: `nextCursor` is the last
  // pause actually returned, so a pause this page omits is the next page's first.
  const matched = state.pauses.filter((entry) => entry.seq > cursor).slice(0, limit)
  const lines: string[] = []
  for (const entry of matched) {
    const current = state.paused?.seq === entry.seq
    const hits = entry.hitBreakpoints.length === 0 ? '' : ` hit ${entry.hitBreakpoints.join(', ')}`
    lines.push(`[${entry.seq}] ${entry.reason}${hits} — ${entry.frames.length} frame(s)${current ? '' : ' (not the current pause: frame ids are stale, eval will not work)'}`)
    entry.frames.forEach((frame, index) => {
      lines.push(`    [${index}] ${frame.functionName} @ ${locationText(state, frame)}`)
    })
    if (entry.framesOmitted > 0) lines.push(`    (${entry.framesOmitted} deeper frame(s) omitted)`)
    const top = entry.frames[0]
    if (current && top !== undefined) lines.push(...await scopeLines(tabId, top))
  }
  const pause = pausedAtBreakpoint(tabId)
  const head = matched.length === 0
    ? `pauses (none new; buffer holds ${state.pauses.length})`
    : pause === undefined
      ? `pauses (buffer holds ${state.pauses.length}; page is running)`
      : `pauses (buffer holds ${state.pauses.length}; page is ${pause})`
  const next = matched.length === 0 ? Math.max(cursor, state.pauseSeq) : matched[matched.length - 1]!.seq
  return { ok: true, result: { text: pageBufferText(head, lines, next, budgetChars) } }
}

/** One listener as `DOMDebugger.getEventListeners` reports it. */
interface ListenerEntry {
  type: string
  useCapture: boolean
  passive: boolean
  once: boolean
  scriptId: string
  lineNumber: number
  columnNumber: number
}

/** One level of the chain, with the listeners found on it. */
interface ChainLevel {
  label: string
  listeners: ListenerEntry[]
}

/** A live remote node handle, plus CDP's own one-line description of it. */
interface NodeHandle {
  objectId: string
  /** e.g. `input#email.form-input`; empty when Chrome offers none. */
  description: string
  /** e.g. `HTMLInputElement`, `HTMLDocument`; empty when Chrome offers none. */
  className: string
}

/** What one expression resolved to. */
type NodeLookup =
  | { kind: 'node'; node: NodeHandle }
  | { kind: 'threw'; message: string }
  /** The expression produced no handle: `querySelector` found nothing. */
  | { kind: 'empty' }

function toNodeHandle(raw: { result?: { objectId?: unknown; description?: unknown; className?: unknown } }): NodeHandle | undefined {
  const objectId = raw.result?.objectId
  if (typeof objectId !== 'string' || objectId === '') return undefined
  return {
    objectId,
    description: typeof raw.result?.description === 'string' ? raw.result.description : '',
    className: typeof raw.result?.className === 'string' ? raw.result.className : '',
  }
}

/**
 * Resolve one expression on the running page to a live node handle.
 *
 * `silent: true` keeps an invalid selector's `SyntaxError` out of the page's own
 * console — this is a diagnostic, and the page should not log for it. The
 * response still carries `exceptionDetails` (silent only mutes the console
 * report and the pause-on-exception), so a bad selector is reported from there.
 */
async function evaluateNode(tabId: number, expression: string): Promise<NodeLookup> {
  const raw = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue: false,
    silent: true,
  }) as {
    result?: { objectId?: unknown; description?: unknown; className?: unknown }
    exceptionDetails?: { text?: unknown; exception?: { description?: unknown } }
  }
  if (raw.exceptionDetails !== undefined) {
    const details = raw.exceptionDetails
    const message = typeof details.exception?.description === 'string'
      ? details.exception.description
      : typeof details.text === 'string' ? details.text : 'the expression threw'
    return { kind: 'threw', message }
  }
  const node = toNodeHandle(raw)
  return node === undefined ? { kind: 'empty' } : { kind: 'node', node }
}

/**
 * The parent of one chain level, or undefined at the top.
 *
 * `document.parentElement` is undefined, and `documentElement`'s is `document`,
 * so the walk ends by itself; no global is written into the page.
 */
async function parentNode(tabId: number, objectId: string): Promise<NodeHandle | undefined> {
  const raw = await chrome.debugger.sendCommand({ tabId }, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function () { return this.parentElement || null }',
    returnByValue: false,
  }) as { result?: { objectId?: unknown; description?: unknown; className?: unknown } }
  return toNodeHandle(raw)
}

/**
 * Parse the `type` argument into the set of event types to report.
 *
 * Comma-separated, so one string covers `blur,focus` — the pair a field's commit path
 * usually rides on. An empty or absent value means no filter: that is the discovery mode,
 * everything on every level, capped per level.
 */
function parseListenerTypes(value: string | undefined): Set<string> | undefined {
  if (value === undefined) return undefined
  const types = value.split(',').map((part) => part.trim().toLowerCase()).filter((part) => part !== '')
  return types.length === 0 ? undefined : new Set(types.slice(0, 8))
}

/**
 * The listeners registered on exactly one node, optionally narrowed to named types.
 *
 * `depth: 0` is deliberate. Chrome's own default (1) also reports the node's
 * direct children — blink's `InspectorDOMAgent::CollectNodes` walks one level
 * down and keeps every child that has listeners — which would print a child's
 * listener on this level's line, and the whole point here is which level owns
 * what.
 *
 * `pierce` is off, and that is a change from this action's first cut. It reports
 * listeners from every execution context, which on a real page meant the isolated worlds
 * of other extensions: the document level came back with 1390 listeners, most of them
 * foreign, and a `blur capture @ chrome-extension://…` sat next to the page's own blur
 * handler as if the page had registered both. The question this action answers is what
 * the page registered.
 */
async function nodeListeners(tabId: number, objectId: string, wanted: Set<string> | undefined): Promise<ListenerEntry[]> {
  const raw = await chrome.debugger.sendCommand({ tabId }, 'DOMDebugger.getEventListeners', {
    objectId,
    depth: 0,
    // Not `pierce`: that also reports the isolated worlds of other extensions, and a
    // "blur capture @ chrome-extension://…" sitting next to the page's own blur handler
    // reads as if the page registered both. Measured on the real page: the document level
    // carried 1390 listeners, most of them other extensions'.
    pierce: false,
  }) as { listeners?: Array<Record<string, unknown>> }
  const listeners: ListenerEntry[] = []
  for (const entry of raw.listeners ?? []) {
    if (typeof entry.type !== 'string' || entry.type === '') continue
    // Filtering here rather than at the render step keeps the per-level counts honest:
    // "document: 2" has to mean two listeners of the type the caller asked about.
    if (wanted !== undefined && !wanted.has(entry.type.toLowerCase())) continue
    listeners.push({
      type: entry.type,
      useCapture: entry.useCapture === true,
      passive: entry.passive === true,
      once: entry.once === true,
      scriptId: typeof entry.scriptId === 'string' ? entry.scriptId : '',
      lineNumber: typeof entry.lineNumber === 'number' ? entry.lineNumber : 0,
      columnNumber: typeof entry.columnNumber === 'number' ? entry.columnNumber : 0,
    })
  }
  return listeners
}

/** How one chain level names itself in the answer. */
function levelLabel(node: NodeHandle, first: boolean): string {
  if (node.className === 'HTMLDocument') return 'document'
  const role = first ? 'element' : 'parent'
  const name = node.description !== '' ? node.description : node.className
  return name === '' ? role : `${role} <${shorten(name, 80)}>`
}

/**
 * One listener line: what fires, in which phase, and where the handler lives.
 *
 * CDP reports a listener's script as a `scriptId` only, so the URL comes from
 * the `Debugger.scriptParsed` inventory this module already keeps. A listener
 * whose script that buffer no longer holds is named by its id rather than
 * dropped — it is a real listener either way.
 */
function listenerLine(state: TabJsDebug, listener: ListenerEntry): string {
  const script = state.scripts.find((candidate) => candidate.scriptId === listener.scriptId)
  const where = script === undefined
    ? `(script ${listener.scriptId === '' ? '?' : listener.scriptId} is not in the script buffer)`
    : script.url === '' ? '(anonymous script)' : shorten(script.url, LISTENER_URL_MAX)
  const flags = [listener.passive ? 'passive' : '', listener.once ? 'once' : ''].filter((flag) => flag !== '').join(', ')
  const phase = listener.useCapture ? 'capture' : 'bubble'
  return `${listener.type} ${phase}${flags === '' ? '' : ` (${flags})`} @ ${where}:${listener.lineNumber}:${listener.columnNumber}`
}

/**
 * Join the chain under the character budget without losing the delegation note.
 *
 * The note is the part that stops "none" from reading as "the field ignores
 * this", and a plain tail truncation would cut exactly that. Listener lines
 * give way instead, with a marker that says how many did.
 */
function listenersText(head: string, lines: string[], note: string, budgetChars: number): string {
  const budget = Math.max(1, Math.floor(budgetChars))
  const suffix = `\n${note}`
  if (head.length + suffix.length >= budget) return `${head}${suffix}`.slice(0, budget)
  const marker = (omitted: number): string => `(${omitted} more line${omitted === 1 ? '' : 's'} omitted: raise maxChars)`
  const kept: string[] = []
  let room = budget - head.length - suffix.length - 1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const cost = line.length + 1
    if (room - cost < 0) {
      const omitted = marker(lines.length - index)
      if (room >= omitted.length) kept.push(omitted)
      break
    }
    kept.push(line)
    room -= cost
  }
  return `${head}\n${kept.join('\n')}${suffix}`
}

/**
 * `listeners`: what is registered on an element and up its ancestor chain.
 *
 * A diagnostic, not a verdict — and that shapes the output. The page's
 * framework may attach a single handler to `document` and dispatch by event
 * target (legacy React 15 does, in the capture phase because `blur` does not
 * bubble), so asking the input node returns nothing while the field does submit
 * on blur. The chain is therefore walked to `document` and every level is
 * printed, including the empty ones, and the answer always carries
 * `LISTENERS_DELEGATION_NOTE`. This is what makes "look first" possible where
 * the alternative was a probing interaction with real side effects.
 */
async function listenersAnswer(tabId: number, args: Record<string, unknown>, budgetChars: number): Promise<Answer> {
  const state = stateFor(tabId)
  const pause = pausedAtBreakpoint(tabId)
  if (pause !== undefined) {
    // The element lookup is a `Runtime.evaluate`, and a stopped renderer cannot
    // answer one: this action would sit on the per-call budget instead of
    // reporting. Refuse, and name the way out.
    return { ok: false, error: { code: 'action-failed', message: `The page is ${pause}, so nothing on it can be looked up right now. Action "resume" lets it run again; action "eval" reads the paused frame.` } }
  }
  const selector = stringArg(args, 'selector')
  const quoted = selector === undefined ? 'document' : `"${shorten(selector, SCRIPT_URL_MAX)}"`
  // The question is nearly always "does anything here handle blur?", and a real document
  // carries a thousand listeners. Narrowing to the types the caller names is what turns
  // this from a dump into an answer; the counts then mean what they say.
  const wantedTypes = parseListenerTypes(stringArg(args, 'type'))
  const typeNote = wantedTypes === undefined ? '' : ` of type ${[...wantedTypes].map((type) => `"${type}"`).join(', ')}`
  const objectIds: string[] = []
  try {
    // `Runtime` is asked for here rather than for every action, and after the
    // pause guard above: it is the domain this action reads the page through,
    // and nothing else in this module evaluates on a running page.
    await holdDebuggerSession(tabId, { runtime: true })
    const start = await evaluateNode(tabId, selector === undefined ? 'document' : `document.querySelector(${JSON.stringify(selector)})`)
    if (start.kind === 'threw') {
      return { ok: false, error: { code: 'action-failed', message: `${quoted} is not a usable CSS selector: ${shorten(start.message, 400)}` } }
    }
    if (start.kind === 'empty') {
      return { ok: false, error: { code: 'action-failed', message: `Nothing on this page matches ${quoted}. Use browser_dom_query or browser_snapshot for a verified selector, or drop selector to read document.` } }
    }
    const levels: ChainLevel[] = []
    let current: NodeHandle | undefined = start.node
    let reachedDocument = false
    let truncated = false
    for (let index = 0; current !== undefined; index += 1) {
      if (index >= LISTENER_CHAIN_MAX) {
        truncated = true
        break
      }
      const node = current
      objectIds.push(node.objectId)
      levels.push({ label: levelLabel(node, index === 0), listeners: await nodeListeners(tabId, node.objectId, wantedTypes) })
      if (node.className === 'HTMLDocument') {
        reachedDocument = true
        break
      }
      current = await parentNode(tabId, node.objectId)
    }
    // `document` is the level this action exists to compare the element against — a
    // framework keeps its delegated handlers there — so it is never skipped. It is also
    // unreachable by walking: `parentElement` only ever returns an Element and `document`
    // is not one, so the chain always stops at `<html>` (measured on the real page: the
    // walk ended there with a null parent). This fetch is therefore the only path to that
    // level, not a fallback for deep pages — do not delete it as redundant with the loop's
    // `HTMLDocument` check, which only fires when the start itself is `document`. The
    // ceiling decides how much of the middle gets listed.
    if (!reachedDocument) {
      const root = await evaluateNode(tabId, 'document')
      if (root.kind === 'node') {
        objectIds.push(root.node.objectId)
        levels.push({
          label: `document (reached directly; ${truncated ? `the ${LISTENER_CHAIN_MAX}-level walk stopped before it` : 'the walk ended before it'})`,
          listeners: await nodeListeners(tabId, root.node.objectId, wantedTypes),
        })
        reachedDocument = true
      }
    }
    const lines: string[] = []
    let total = 0
    levels.forEach((level, index) => {
      total += level.listeners.length
      lines.push(level.listeners.length === 0 ? `[${index + 1}] ${level.label}: none` : `[${index + 1}] ${level.label}: ${level.listeners.length}`)
      for (const listener of level.listeners.slice(0, LISTENER_MAX)) lines.push(`    ${listenerLine(state, listener)}`)
      if (level.listeners.length > LISTENER_MAX) lines.push(`    (${level.listeners.length - LISTENER_MAX} more on this level omitted)`)
    })
    const span = `${levels.length} level${levels.length === 1 ? '' : 's'}`
    const end = reachedDocument ? 'document' : 'the top of the walk'
    const head = total === 0
      ? `event listeners${typeNote} on ${quoted} up the ancestor chain (${span}): none found, on that node or any level up to ${end}${truncated ? ' (the walk was cut short before document)' : ''}`
      : `event listeners${typeNote} on ${quoted} up the ancestor chain (${span}, up to ${end}); script line numbers are CDP 0-based, as action "break" wants`
    return { ok: true, result: { text: listenersText(head, lines, LISTENERS_DELEGATION_NOTE, budgetChars) } }
  } finally {
    // Remote handles live until released; nothing else owns these.
    for (const objectId of objectIds) {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.releaseObject', { objectId }).catch(() => undefined)
    }
  }
}

/**
 * One `browser_debug` call.
 *
 * @param tabId - the controlled tab.
 * @param args - the model's arguments (`action` plus that action's own fields).
 * @param budgetChars - character ceiling for paged reads.
 * @returns the answer to hand back over the bridge.
 */
export async function jsDebugAnswer(tabId: number, args: Record<string, unknown>, budgetChars: number): Promise<Answer> {
  const action = stringArg(args, 'action')
  if (action === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'browser_debug requires an action: scripts, break, unbreak, list, pause, resume, step, wait, eval, or listeners.' } }
  }
  try {
    // Every action needs the session: the pause state it reports is buffered
    // from that session's events, and `scripts` reads the same buffer.
    ensureListener()
    await holdDebuggerSession(tabId, { debugger: true })
    stateFor(tabId)
    switch (action) {
      case 'scripts':
        return scriptsAnswer(tabId, args, budgetChars)
      case 'break':
        return await breakAnswer(tabId, args)
      case 'unbreak':
        return await unbreakAnswer(tabId, args)
      case 'list':
        return listAnswer(tabId)
      case 'pause':
      case 'resume':
      case 'step':
        return await controlAnswer(tabId, action, args)
      case 'eval':
        return await evalAnswer(tabId, args)
      case 'wait':
        return await waitAnswer(tabId, args, budgetChars)
      case 'listeners':
        return await listenersAnswer(tabId, args, budgetChars)
      default:
        return { ok: false, error: { code: 'action-failed', message: `Unknown browser_debug action "${action}". Use scripts, break, unbreak, list, pause, resume, step, wait, eval, or listeners.` } }
    }
  } catch (error: unknown) {
    return answerError(error)
  }
}

/**
 * Undo this tab's debugging: resume a paused page and drop the breakpoints.
 *
 * Called when the debugging capability is switched off, when the tab closes,
 * and when the session ends for a reason no detach event covered. Breakpoints
 * go through `Debugger.disable`, which is also what releases a pause nobody is
 * left to resume — leaving one installed after the model moved on would freeze
 * the user's page with no tool able to explain why.
 *
 * @param tabId - the tab to clean up.
 * @returns true when there was something to clean up (for the debug log).
 */
export async function dropJsDebug(tabId: number): Promise<boolean> {
  const state = tabs.get(tabId)
  tabs.delete(tabId)
  wakeWaiters(state)
  const touched = state !== undefined && (state.breakpoints.size > 0 || state.paused !== undefined)
  if (state?.paused !== undefined) {
    await chrome.debugger.sendCommand({ tabId }, 'Debugger.resume').catch(() => undefined)
  }
  // Unconditional: `Debugger.disable` also drops breakpoints this module has no
  // record of (a worker restart loses the record, not the attachment), and it
  // is the only way to release a pause nobody is left to resume.
  await releaseDebuggerDomain(tabId, 'Debugger')
  if (touched) recordDebugEvent('js-debug', `tab ${tabId}: resumed and cleared ${state.breakpoints.size} breakpoint(s)`)
  return touched
}

/**
 * Tabs whose debugger state this module holds.
 *
 * The debugger's own toggle needs this: a session opened for `browser_debug` is
 * not necessarily in the priming set, and switching debugging off makes
 * `browser_debug` unusable — so a pause it left behind would have no way out.
 *
 * @returns the tab ids in any state.
 */
export function jsDebugTabIds(): number[] {
  return [...tabs.keys()]
}

/**
 * Forget every tab's state. For tests: each spec stubs its own
 * `chrome.debugger`, and module state would otherwise leak between them.
 */
export function resetJsDebugForTest(): void {
  tabs.clear()
  listenerInstalled = false
}
