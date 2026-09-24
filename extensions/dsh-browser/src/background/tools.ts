/**
 * Tool dispatch: executes `tool.call` frames in an explicitly selected tab via
 * the content script and answers with the text-only result.
 *
 * The background service owns tab-affinity policy. Direct callers may omit a
 * target for backward-compatible active-tab dispatch in isolated tests.
 *
 * @module
 */

import { DEFAULT_SNAPSHOT_MAX_CHARS } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { CaptureRequest, CapturedImage, ToolError } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import {
  allocateFrameBudgets,
  frameOrigin,
  listTabFrames,
  sameFrameDocument,
  type TabFrame,
} from './frames.ts'
import { CaptureError, captureTab } from './capture.ts'
import { PageImageError, fetchPageImage, pageImageEnvelope, parsePageImageSource } from './page-image.ts'
import { clearMocks, evaluateInPage, handleDialog, installMock, parseMockRule, readConsole, readNetwork } from './devtools.ts'
import { addBlockRule, addHeaderRule, clearTabRules, listTabRules, parseHeaderChanges } from './net-rules.ts'
import { wrapUntrustedContent, wrapUntrustedResult } from '../security/untrusted.ts'
import { approvalPromptForCall } from './authorization.ts'
import { waitForNextDocumentReady } from './navigation.ts'
import type { ApprovalAuthorization, ApprovalPrompt, ApprovalRefusal } from '../security/approval.ts'
import { isSessionScopableAction } from '../security/session-allowance.ts'

/** A tool call from the bridge. */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** Server-authored wall-clock deadline; absent only in direct unit tests. */
  expiresAt?: number
  /** Owning Agent session, when supplied by a current bridge. */
  sessionId?: string
}

/** The wire answer for one tool call. */
export interface ToolAnswer {
  ok: boolean
  result?: unknown
  error?: ToolError
}

/** Snapshot limits negotiated with the bridge and forwarded after lazy injection. */
export interface ContentBudget {
  maxItems: number
  maxChars: number
}

const CONTENT_SCRIPT_FILE = 'content.js'
const ACTION_DELTA_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_wait',
])
const ACTION_DELTA_GUIDANCE = 'The page settled and its current changes are included below. Continue from this state; take another snapshot only when broader page context is needed.'
const NAVIGATION_CANDIDATE_TOOLS = new Set([
  'browser_click',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
])
const NAVIGATION_SNAPSHOT_GUIDANCE = 'Navigation completed and the current page snapshot is included below. Use it directly instead of taking an immediate duplicate snapshot.'
/**
 * Budget for the snapshot a navigation attaches automatically.
 *
 * Deliberately far below `snapshotMaxChars`: an automatic read should not cost
 * as much as the model explicitly asking for the page, and the model can always
 * follow up with `browser_snapshot` when it needs more.
 */
const NAVIGATION_SNAPSHOT_MAX_CHARS = 8_000
const pendingInjections = new Map<number, Promise<void>>()
/** Last snapshot's frame observation per tab, for delta baselines and index freshness. */
const snapshotDocumentsByTab = new Map<number, Map<number, TabFrame>>()

/** Forget delta/element state whenever the user explicitly follows a new tab. */
export function resetTabSnapshot(tabId: number): void {
  snapshotDocumentsByTab.delete(tabId)
}

function isToolAnswer(value: unknown): value is ToolAnswer {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { ok?: unknown }).ok === 'boolean'
}

function isInjectablePage(url: string | undefined): boolean {
  return url !== undefined && /^https?:\/\//i.test(url)
}

/**
 * Whether a tab URL means "no document committed yet" rather than "a page the
 * content script may never touch" (chrome://, file://, the PDF viewer).
 *
 * @param url - the controlled tab's current URL.
 * @returns true when the tab is still on its initial empty document.
 */
export function isUncommittedUrl(url: string | undefined): boolean {
  const value = (url ?? '').trim()
  return value === '' || value === 'about:blank'
}

/** Inject the packaged content script once per tab, coalescing concurrent recovery attempts. */
async function injectContentScript(tabId: number): Promise<void> {
  let pending = pendingInjections.get(tabId)
  if (pending === undefined) {
    pending = chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [CONTENT_SCRIPT_FILE],
    }).then(() => undefined)
    pendingInjections.set(tabId, pending)
  }
  try {
    await pending
  } finally {
    if (pendingInjections.get(tabId) === pending) pendingInjections.delete(tabId)
  }
}

async function sendAction(
  tabId: number,
  call: ToolCall,
  frame: TabFrame,
  budget?: ContentBudget,
  includePageDelta: boolean = false,
): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, {
    type: 'DSH_ACTION',
    action: call.name,
    args: withoutFrame(call.args),
    ...budget === undefined ? {} : { budget },
    ...includePageDelta ? { includePageDelta: true } : {},
  }, frame.documentId === undefined ? { frameId: frame.frameId } : { documentId: frame.documentId })
}

function unavailable(message: string): ToolAnswer {
  return { ok: false, error: { code: 'content-unavailable', message } }
}

function cancelled(): ToolAnswer {
  return { ok: false, error: { code: 'bridge-closed', message: 'The browser tool call was cancelled.' } }
}

/**
 * One refusal per fact, for every frame-related refusal in this module.
 *
 * The same two messages used to be spelled out at three and two call sites; the
 * model could see different codes for an identical mistake.
 */
export function frameMissingFailure(frameId: number): ToolAnswer {
  return unavailable(`Frame ${frameId} does not exist or has navigated. Call browser_snapshot again.`)
}

/** @see frameMissingFailure */
export function frameArgumentInvalid(): ToolAnswer {
  return { ok: false, error: { code: 'action-failed', message: 'frame must be a non-negative integer.' } }
}

/** Preserve the factual approval outcome for the model without prescribing a response. */
export function approvalFailureAnswer(approval: ApprovalPrompt, authorization: ApprovalRefusal): ToolAnswer {
  switch (authorization) {
    case 'denied':
      return {
        ok: false,
        error: { code: 'action-failed', message: `The user denied the browser approval request for "${approval.action}".` },
      }
    case 'unavailable':
      return {
        ok: false,
        error: {
          code: 'action-failed',
          message: `No browser side panel was available to receive or complete the approval request for "${approval.action}".`,
        },
      }
    case 'timed-out':
      return {
        ok: false,
        error: { code: 'timeout', message: `The browser approval request for "${approval.action}" timed out before the user responded.` },
      }
    case 'cancelled':
      return {
        ok: false,
        error: {
          code: 'action-failed',
          message: `Nothing ran: the approval prompt for "${approval.action}" was withdrawn before it was answered — the controlled tab changed, or the call was cancelled while you were deciding. Retry and answer the prompt in the side panel (enable approval notifications in Settings to catch prompts when no panel is open).`,
        },
      }
  }
}

function targetChanged(): ToolAnswer {
  return unavailable('The controlled tab changed during the operation. Confirm the page in the side panel before retrying.')
}

function isCancelled(call: ToolCall, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    || (call.expiresAt !== undefined && Date.now() >= call.expiresAt)
}

function withoutFrame(args: Record<string, unknown>): Record<string, unknown> {
  const { frame: _frame, ...rest } = args
  return rest
}

function requestedFrame(args: Record<string, unknown>): number {
  const value = args.frame
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return -1
  return value
}

function answerText(answer: ToolAnswer): string | undefined {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const text = (answer.result as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

/** Accessible name the page reported for the element an action resolved. */
function answerLabel(answer: ToolAnswer): string | undefined {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const label = (answer.result as { label?: unknown }).label
  return typeof label === 'string' && label.trim() !== '' ? label : undefined
}

function answerPageContent(answer: ToolAnswer): string | undefined {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const pageContent = (answer.result as { pageContent?: unknown }).pageContent
  return typeof pageContent === 'string' ? pageContent : undefined
}

function answerNavigationPending(answer: ToolAnswer): boolean {
  return answer.ok
    && typeof answer.result === 'object'
    && answer.result !== null
    && (answer.result as { navigationPending?: unknown }).navigationPending === true
}

/** Keep extension-authored action status outside the nonce-bound page-data boundary. */
function wrapActionDelta(status: string, pageContent: string, frame: TabFrame, maxChars: number): string {
  const prefix = `${status}\n${ACTION_DELTA_GUIDANCE}`
  const separator = '\n\n'
  const boundaryBudget = maxChars - prefix.length - separator.length
  if (boundaryBudget < 500) return prefix.slice(0, maxChars)
  const framedContent = frame.frameId === 0 ? pageContent : `${frameHeader(frame)}\n${pageContent}`
  return `${prefix}${separator}${wrapUntrustedContent(framedContent, boundaryBudget)}`
}

async function snapshotAllFrames(
  tabId: number,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
): Promise<ToolAnswer> {
  const budgets = allocateFrameBudgets(frames, budget)
  const previous = snapshotDocumentsByTab.get(tabId) ?? new Map<number, TabFrame>()
  const deltaRequested = call.args.delta === true

  const settled = await Promise.allSettled(frames.map(async (frame) => {
    const sameDocument = sameFrameDocument(previous.get(frame.frameId), frame)
    const frameCall: ToolCall = {
      ...call,
      args: deltaRequested && sameDocument ? call.args : { ...call.args, delta: false },
    }
    const response = await sendAction(tabId, frameCall, frame, budgets.get(frame.frameId))
    return { frame, response }
  }))

  const sections: string[] = []
  const capturedDocuments = new Map<number, TabFrame>()
  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index]!
    const frame = frames[index]!
    if (outcome.status === 'rejected') {
      if (frame.frameId === 0) throw outcome.reason
      sections.push(frameHeader(frame), '(This iframe was inaccessible or destroyed while loading.)')
      continue
    }
    const answer = outcome.value.response
    if (!isToolAnswer(answer)) {
      if (frame.frameId === 0) return unavailable('The page content script returned an invalid response.')
      sections.push(frameHeader(frame), '(This iframe returned an invalid response.)')
      continue
    }
    const text = answerText(answer)
    if (text === undefined) {
      if (frame.frameId === 0) return answer
      sections.push(frameHeader(frame), `(This iframe could not be read: ${answer.error?.message ?? 'unknown error'})`)
      continue
    }
    capturedDocuments.set(frame.frameId, frame)
    if (frame.frameId === 0) sections.push(text)
    else sections.push(frameHeader(frame), text)
  }

  if (deltaRequested) {
    const liveIds = new Set(frames.map((frame) => frame.frameId))
    const removed = [...previous.keys()].filter((frameId) => frameId !== 0 && !liveIds.has(frameId))
    if (removed.length > 0) sections.push(`\nRemoved iframes: ${removed.join(', ')}`)
  }

  snapshotDocumentsByTab.set(tabId, capturedDocuments)
  return { ok: true, result: { text: wrapUntrustedContent(sections.join('\n'), budget.maxChars) } }
}

function frameHeader(frame: TabFrame): string {
  return `\n--- iframe frame=${frame.frameId} parent=${frame.parentFrameId} origin=${frameOrigin(frame)} ---`
}

function stripDuplicateSnapshotPrompt(status: string): string {
  return status.replace(/ Call browser_snapshot again after (?:navigation settles|the page loads|it loads)\.$/, '')
}

async function snapshotAfterNavigation(
  tabId: number,
  call: ToolCall,
  status: string,
  budget: ContentBudget,
  targetStillAllowed?: () => boolean,
): Promise<ToolAnswer | undefined> {
  const prefix = `${stripDuplicateSnapshotPrompt(status)}\n${NAVIGATION_SNAPSHOT_GUIDANCE}`
  const snapshotMaxChars = Math.min(budget.maxChars, NAVIGATION_SNAPSHOT_MAX_CHARS) - prefix.length - 2
  if (snapshotMaxChars < 500) return undefined
  const frames = await listTabFrames(tabId, undefined)
  if (targetStillAllowed?.() === false) return targetChanged()
  const answer = await snapshotAllFrames(
    tabId,
    frames,
    { ...call, name: 'browser_snapshot', args: {} },
    { ...budget, maxChars: snapshotMaxChars },
  )
  const snapshot = answerText(answer)
  if (snapshot === undefined) return undefined
  return { ok: true, result: { text: `${prefix}\n\n${snapshot}` } }
}

/** Validate the host-supplied storage limits; absent or malformed limits fall back to defaults. */
function parseLimits(value: unknown): CaptureRequest['limits'] {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { maxBytes?: unknown; maxPixels?: unknown; maxDimension?: unknown }
  const positive = (input: unknown): input is number => typeof input === 'number' && Number.isFinite(input) && input > 0
  if (!positive(candidate.maxBytes) || !positive(candidate.maxPixels) || !positive(candidate.maxDimension)) return undefined
  return {
    maxBytes: Math.floor(candidate.maxBytes),
    maxPixels: Math.floor(candidate.maxPixels),
    maxDimension: Math.floor(candidate.maxDimension),
  }
}

/** Build the capture request from the model's arguments plus host-supplied limits. */
function captureRequest(args: Record<string, unknown>): CaptureRequest {
  const format = args.format === 'jpeg' ? 'jpeg' as const : args.format === 'png' ? 'png' as const : undefined
  const quality = typeof args.quality === 'number' && Number.isInteger(args.quality) && args.quality >= 1 && args.quality <= 100
    ? args.quality
    : undefined
  const limits = parseLimits(args.limits)
  return {
    fullPage: args.fullPage === true,
    ...format === undefined ? {} : { format },
    ...quality === undefined ? {} : { quality },
    ...limits === undefined ? {} : { limits },
  }
}

/** Factual, boundary-wrapped envelope that travels beside one screenshot. */
function captureEnvelope(image: CapturedImage, url: string | undefined): string {
  const target = url === undefined || url === '' ? '' : `\nurl: ${url}`
  const note = image.note === undefined ? '' : `\nnote: ${image.note}`
  return `<capture>\nimage: ${image.mediaType} ${image.width}x${image.height} px, ${image.bytes} bytes${target}${note}\n</capture>`
}

/** Character budget for one capture envelope; the metadata is deliberately tiny. */
const CAPTURE_ENVELOPE_MAX_CHARS = 2_000

/**
 * Answer one screenshot call: capture first, then hand the image back beside its
 * envelope. A capture refusal is a stable tool error, never a silent text-only
 * result the model could misread as "empty page".
 */
async function captureAnswer(tabId: number, call: ToolCall, frames: TabFrame[], signal?: AbortSignal): Promise<ToolAnswer> {
  try {
    const image = await captureTab(tabId, captureRequest(call.args), signal)
    const envelope = captureEnvelope(image, frames.find((frame) => frame.frameId === 0)?.url)
    return { ok: true, result: { text: wrapUntrustedContent(envelope, CAPTURE_ENVELOPE_MAX_CHARS), image } }
  } catch (error: unknown) {
    const code = error instanceof CaptureError ? error.code : 'action-failed'
    return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * Add the same-moment screenshot a snapshot asked for. A capture failure keeps
 * the text snapshot and names the reason, so a page that cannot be debugged
 * still answers its text read.
 */
async function withSnapshotVisual(text: string, tabId: number, call: ToolCall, signal?: AbortSignal): Promise<ToolAnswer> {
  if (call.args.visual === false) return { ok: true, result: { text } }
  try {
    const image = await captureTab(tabId, { ...captureRequest(call.args), fullPage: false }, signal)
    return { ok: true, result: { text, image } }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: true, result: { text: `${text}\n\n(screenshot unavailable: ${message})` } }
  }
}

/**
 * Answer one page-picture call: ask the page where the picture lives, then read
 * those bytes here. Unlike a screenshot this needs no `chrome.debugger`, so it
 * works with DevTools open and on a background tab.
 */
async function imageAnswer(tabId: number, call: ToolCall, frames: TabFrame[]): Promise<ToolAnswer> {
  const frameId = requestedFrame(call.args)
  const frame = frames.find((candidate) => candidate.frameId === frameId)
    ?? frames.find((candidate) => candidate.frameId === 0)
  if (frame === undefined) {
    return frameMissingFailure(frameId)
  }
  // A sendMessage failure must reach the caller: the dispatch layer retries it
  // after injecting the content script into a page opened before this build.
  const response = await sendAction(tabId, call, frame)
  if (!isToolAnswer(response)) return unavailable('The page content script returned an invalid response.')
  if (!response.ok) return response
  const source = parsePageImageSource((response.result as { imageSource?: unknown }).imageSource)
  if (source === undefined) {
    return unavailable('The page did not report a picture for that target. Call browser_dom_query to inspect the element, or browser_capture for a screenshot.')
  }
  try {
    const image = await fetchPageImage(source, parseLimits(call.args.limits) ?? undefined)
    return {
      ok: true,
      result: { text: wrapUntrustedContent(pageImageEnvelope(image, source), CAPTURE_ENVELOPE_MAX_CHARS), image },
    }
  } catch (error: unknown) {
    const code = error instanceof PageImageError ? error.code : 'action-failed'
    return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * Enclose page-derived debugging output in the same trust boundary as page
 * text: console lines, network URLs, and evaluated values are all authored by
 * the page, so the model must treat them as data.
 */
function wrapPageAnswer(
  answer: { ok: boolean; result?: { text: string }; error?: { code: 'unsupported' | 'action-failed'; message: string } },
  maxChars: number,
): ToolAnswer {
  if (!answer.ok || answer.result === undefined) {
    return { ok: false, error: answer.error ?? { code: 'action-failed', message: 'The debugging call failed.' } }
  }
  return { ok: true, result: { text: wrapUntrustedContent(answer.result.text, maxChars) } }
}

/**
 * Install or clear the controlled tab's network rules. `clear` removes every
 * rule this extension holds for the tab; otherwise one rule is added.
 */
async function netRuleAnswer(tabId: number, call: ToolCall, kind: 'block' | 'headers'): Promise<ToolAnswer> {
  const args = call.args
  try {
    if (args.clear === true) {
      const removed = await clearTabRules(tabId)
      return { ok: true, result: { text: `Cleared ${removed} rule(s) previously installed for this tab.` } }
    }
    const pattern = typeof args.pattern === 'string' && args.pattern.trim() !== '' ? args.pattern : undefined
    if (pattern === undefined) {
      return { ok: false, error: { code: 'bad-args', message: `${call.name} requires a "pattern" (or clear: true). Patterns use Chrome's urlFilter syntax, including * wildcards.` } }
    }
    if (kind === 'headers') {
      const requestHeaders = parseHeaderChanges(args.requestHeaders)
      const responseHeaders = parseHeaderChanges(args.responseHeaders)
      if (requestHeaders === undefined && responseHeaders === undefined) {
        return {
          ok: false,
          error: {
            code: 'bad-args',
            message: 'browser_headers requires requestHeaders and/or responseHeaders as [{ header, operation: set|append|remove, value? }].',
          },
        }
      }
      const id = await addHeaderRule(tabId, pattern, requestHeaders, responseHeaders)
      const ruleCount = (await listTabRules(tabId)).length
      return { ok: true, result: { text: `Header rule ${id} active for "${pattern}" on this tab (${ruleCount} rule(s) installed). It applies only while this tab is the controlled one and lasts until the browser session ends.` } }
    }
    const resourceTypes = Array.isArray(args.resourceTypes)
      ? args.resourceTypes.filter((value): value is string => typeof value === 'string')
      : undefined
    const id = await addBlockRule(tabId, pattern, resourceTypes)
    const ruleCount = (await listTabRules(tabId)).length
    return { ok: true, result: { text: `Block rule ${id} active for "${pattern}" on this tab (${ruleCount} rule(s) installed). Matching requests now fail as blocked.` } }
  } catch (error: unknown) {
    return { ok: false, error: { code: 'action-failed', message: error instanceof Error ? error.message : String(error) } }
  }
}

async function dispatchOnce(
  tabId: number,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
  signal?: AbortSignal,
  targetStillAllowed?: () => boolean,
  includeActionDelta: boolean = false,
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  if (call.name === 'browser_snapshot') {
    const snapshot = await snapshotAllFrames(tabId, frames, call, budget)
    const text = answerText(snapshot)
    if (!snapshot.ok || text === undefined) return snapshot
    return withSnapshotVisual(text, tabId, call, signal)
  }
  if (call.name === 'browser_capture') return captureAnswer(tabId, call, frames, signal)
  if (call.name === 'browser_image') return imageAnswer(tabId, call, frames)
  // Tab-level debugging tools: the background answers them over CDP or DNR
  // instead of a content script, under the same approval path taken above.
  if (call.name === 'browser_console') return wrapPageAnswer(await readConsole(tabId, call.args, budget.maxChars), budget.maxChars)
  if (call.name === 'browser_network') {
    if (call.args.mockClear === true) {
      const removed = await clearMocks(tabId)
      return { ok: true, result: { text: `Cleared ${removed} response override(s) for this tab.` } }
    }
    if (call.args.mock !== undefined) {
      const mock = parseMockRule(call.args.mock)
      if (mock === undefined) {
        return {
          ok: false,
          error: {
            code: 'bad-args',
            message: 'browser_network mock requires { pattern, status?, headers?: [{name,value}], body?, fail? }.',
          },
        }
      }
      const count = await installMock(tabId, mock)
      return { ok: true, result: { text: `Response override active for "${mock.pattern}" (${count} rule(s)); matching requests are answered from memory, not the network.` } }
    }
    return wrapPageAnswer(await readNetwork(tabId, call.args, budget.maxChars), budget.maxChars)
  }
  if (call.name === 'browser_eval') return wrapPageAnswer(await evaluateInPage(tabId, call.args, budget.maxChars), budget.maxChars)
  if (call.name === 'browser_dialog') return wrapPageAnswer(await handleDialog(tabId, call.args), budget.maxChars)
  if (call.name === 'browser_block') return netRuleAnswer(tabId, call, 'block')
  if (call.name === 'browser_headers') return netRuleAnswer(tabId, call, 'headers')

  const frameId = requestedFrame(call.args)
  if (frameId < 0) return frameArgumentInvalid()
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  if (frame === undefined) {
    return frameMissingFailure(frameId)
  }
  // No await occurs between this guard and tabs.sendMessage, so an expired
  // approval cannot cross the final state-changing dispatch boundary.
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  const hasSnapshotBaseline = sameFrameDocument(snapshotDocumentsByTab.get(tabId)?.get(frameId), frame)
  const requestPageDelta = includeActionDelta && hasSnapshotBaseline && ACTION_DELTA_TOOLS.has(call.name)
  const navigationWait = includeActionDelta && NAVIGATION_CANDIDATE_TOOLS.has(call.name)
    ? waitForNextDocumentReady(tabId, frameId, frame.documentId, signal)
    : undefined
  let response: unknown
  try {
    response = await sendAction(
      tabId,
      call,
      frame,
      requestPageDelta ? budget : undefined,
      requestPageDelta,
    )
  } catch (error: unknown) {
    navigationWait?.cancel()
    throw error
  }
  if (isCancelled(call, signal)) {
    navigationWait?.cancel()
    return cancelled()
  }
  if (!isToolAnswer(response)) {
    navigationWait?.cancel()
    return unavailable('The page content script returned an invalid response.')
  }
  const text = answerText(response)
  if (text === undefined) {
    navigationWait?.cancel()
    return response
  }
  if (answerNavigationPending(response) && navigationWait !== undefined) {
    const ready = await navigationWait.ready
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    if (ready) {
      try {
        const snapshot = await snapshotAfterNavigation(tabId, call, text, budget, targetStillAllowed)
        if (snapshot !== undefined) return snapshot
      } catch {
        // Preserve the successful navigation status when the replacement page
        // becomes unavailable before its opportunistic snapshot completes.
      }
    }
  } else {
    navigationWait?.cancel()
  }
  if (call.name === 'browser_get_text') {
    return { ok: true, result: { text: wrapUntrustedContent(text, budget.maxChars) } }
  }
  if (call.name === 'browser_dom_query') {
    // Every field here is page-authored: `name=` is the computed accessible
    // name, and `text`/`aria-label`/`title`/attribute values all come from the
    // document. It gets the same boundary as the snapshot and get_text paths,
    // in the compact form because a structured read can be smaller than the
    // full enclosure (~421 characters) while the negotiated floor is 500.
    return { ok: true, result: { text: wrapUntrustedResult(text, budget.maxChars) } }
  }
  const pageContent = requestPageDelta ? answerPageContent(response) : undefined
  const label = answerLabel(response)
  return {
    ok: true,
    result: {
      text: pageContent === undefined ? text : wrapActionDelta(text, pageContent, frame, budget.maxChars),
      ...label === undefined ? {} : { label },
    },
  }
}

/**
 * Dispatch one tool call to the selected tab's content script.
 * @param call - the tool call to execute.
 * @param sharePageContent - the user's page-sharing preference ('off' blocks
 *   every page-content read).
 * @param budget - snapshot limits to restore after on-demand content-script injection.
 * @param signal - bridge lifetime; cancellation prevents any not-yet-sent page action.
 * @param targetTab - tab selected by the background affinity controller.
 * @param targetStillAllowed - final fail-closed guard after asynchronous approval/navigation checks.
 * @returns the content script's answer, or a stable error when no tab or
 *   content script is available.
 */
export async function dispatchToolCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  budget?: ContentBudget,
  authorize?: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>,
  signal?: AbortSignal,
  targetTab?: Pick<chrome.tabs.Tab, 'id' | 'url'>,
  targetStillAllowed?: () => boolean,
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  // Privacy boundary: with sharing off, no page content may leave the page.
  if (sharePageContent === 'off'
    && (call.name === 'browser_snapshot' || call.name === 'browser_get_text' || call.name === 'browser_capture'
      || call.name === 'browser_console' || call.name === 'browser_network' || call.name === 'browser_eval'
      || call.name === 'browser_dom_query' || call.name === 'browser_image')) {
    return { ok: false, error: { code: 'action-failed', message: 'Page content sharing is disabled in Settings > Page content sharing.' } }
  }
  const tab = targetTab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
  if (isCancelled(call, signal)) return cancelled()
  if (tab?.id === undefined) {
    return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
  }
  if (targetStillAllowed?.() === false) return targetChanged()
  const effectiveBudget = budget ?? { maxItems: 60, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS }
  const frames = await listTabFrames(tab.id, tab.url)
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  const frameError = validateFrameTarget(call, frames)
  if (frameError !== undefined) return frameError
  const targetError = validateElementTarget(call, tab.id, frames)
  if (targetError !== undefined) return targetError
  let approval = approvalPromptForCall(call, sharePageContent, frames)
  if (approval !== undefined) {
    const result = await settleApproval({
      approval,
      frames,
      call,
      tab,
      signal,
      targetStillAllowed,
      sharePageContent,
      authorize,
    })
    if ('answer' in result) return result.answer
    approval = result.approval
  }
  let executionFrames = frames
  if (approval !== undefined) {
    executionFrames = await listTabFrames(tab.id, tab.url)
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    const refreshedApproval = approvalPromptForCall(call, sharePageContent, executionFrames)
    if (refreshedApproval === undefined
      || !sameApprovalBoundary(approval, refreshedApproval)
      || (approval.kind === 'action' && !sameTargetDocument(call, frames, executionFrames))) {
      return unavailable('The page changed while approval was pending: '
        + `${invalidationReason(approval, refreshedApproval, call, frames, executionFrames)}. `
        + 'Nothing ran — call browser_snapshot again before retrying.')
    }
    const refreshedTargetError = validateElementTarget(call, tab.id, executionFrames)
    if (refreshedTargetError !== undefined) return refreshedTargetError
  }
  try {
    return await dispatchOnce(
      tab.id,
      executionFrames,
      call,
      effectiveBudget,
      signal,
      targetStillAllowed,
      sharePageContent === 'auto',
    )
  } catch {
    if (isCancelled(call, signal)) return cancelled()
    // Manifest content scripts do not run retroactively in tabs that were
    // already open when an unpacked extension was installed or reloaded.
    // Recover in place so the user never has to refresh and lose page state.
    if (!isInjectablePage(tab.url)) {
      // A tab that was just opened has no URL yet: it is not an unsupported
      // page, and telling the model to "switch to a standard http or https
      // page" sent it looking for a different tool instead of retrying.
      return unavailable(isUncommittedUrl(tab.url)
        ? 'The controlled tab has not finished loading its first document yet, so no page script could run. Call browser_wait or browser_snapshot again in a moment.'
        : 'The current page does not support browser operations. Switch to a standard http or https page.')
    }
    try {
      await injectContentScript(tab.id)
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
      const refreshedFrames = await listTabFrames(tab.id, tab.url)
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
      const refreshedTargetError = validateElementTarget(call, tab.id, refreshedFrames)
      if (refreshedTargetError !== undefined) return refreshedTargetError
      if (approval !== undefined) {
        const refreshedApproval = approvalPromptForCall(call, sharePageContent, refreshedFrames)
        if (refreshedApproval === undefined
          || !sameApprovalBoundary(approval, refreshedApproval)
          || (approval.kind === 'action' && !sameTargetDocument(call, executionFrames, refreshedFrames))) {
          return unavailable('The page changed while the content script was loading: '
            + `${invalidationReason(approval, refreshedApproval, call, executionFrames, refreshedFrames)}. `
            + 'Nothing ran — call browser_snapshot again before retrying.')
        }
      }
      return await dispatchOnce(
        tab.id,
        refreshedFrames,
        call,
        effectiveBudget,
        signal,
        targetStillAllowed,
        sharePageContent === 'auto',
      )
    } catch {
      return unavailable('The content script could not be loaded on this page. Chrome internal and protected pages do not support browser operations.')
    }
  }
}

interface SettleApprovalOptions {
  approval: ApprovalPrompt
  /** Frames the prompt was built from; a renewal must stay inside them. */
  frames: TabFrame[]
  call: ToolCall
  tab: Pick<chrome.tabs.Tab, 'id' | 'url'>
  signal?: AbortSignal
  targetStillAllowed?: () => boolean
  sharePageContent: 'ask' | 'auto' | 'off'
  authorize?: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>
}

type SettleApprovalResult = { approval: ApprovalPrompt } | { answer: ToolAnswer }

/**
 * Ask once, and when the answer is "this session" ask once more.
 *
 * Two decisions do not end the call: an expired prompt, and "Allow in this
 * session", which records the grant before it can be honored. Both re-raise
 * the prompt against freshly listed frames, so the approval the user sees
 * still describes the page they are on; the retry then passes the boundary
 * check below.
 *
 * Renewal is limited to calls whose decision actually changed something: an
 * action that can hold a session grant, and a page read when sharing is set to
 * "ask". A navigation is neither — retrying it would re-approve a *new*
 * destination off an old prompt's answer, so an expired navigation prompt
 * simply fails and the model decides whether to ask again.
 */
async function settleApproval(options: SettleApprovalOptions): Promise<SettleApprovalResult> {
  const renewable = options.approval.kind === 'read' || isSessionScopableAction(options.call.name)
  // A read is prompted from one frame's point of view; everything else from the
  // whole tab, so the renewed prompt is scoped exactly like the first one.
  const renew = options.approval.kind === 'read'
    ? async (): Promise<ApprovalPrompt | undefined> => approvalPromptForCall(
        options.call,
        options.sharePageContent,
        options.frames.filter((frame) => frame.frameId === requestedFrame(options.call.args)),
      )
    : async (): Promise<ApprovalPrompt | undefined> => approvalPromptForCall(
        options.call,
        options.sharePageContent,
        await listTabFrames(options.tab.id!, options.tab.url),
      )

  let approval = options.approval
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const authorization: ApprovalAuthorization = options.authorize === undefined
      ? 'unavailable'
      : await options.authorize(approval)
    if (isCancelled(options.call, options.signal)) return { answer: cancelled() }
    if (options.targetStillAllowed?.() === false) return { answer: targetChanged() }
    if (authorization === 'approved') return { approval }
    // `renewable` is what keeps `renew` out of the refusal here: it was checked
    // together with the result above, but TypeScript cannot narrow through it.
    if (authorization !== 'renew' || !renewable) return { answer: approvalFailureAnswer(approval, authorization as ApprovalRefusal) }
    const renewed = await renew()
    if (renewed === undefined || !sameApprovalBoundary(approval, renewed)) {
      return {
        answer: unavailable('The page changed while the approval prompt was open: '
          + `${invalidationReason(approval, renewed, options.call, options.frames, options.frames)}. `
          + 'Nothing ran — call browser_snapshot again before retrying.'),
      }
    }
    approval = renewed
  }
  return {
    answer: unavailable(`The approval prompt for "${approval.action}" expired before it was answered. `
      + 'Nothing ran — call the tool again to raise a fresh prompt in the side panel.'),
  }
}

function validateFrameTarget(call: ToolCall, frames: TabFrame[]): ToolAnswer | undefined {
  if (call.name === 'browser_snapshot') return undefined
  const frameId = requestedFrame(call.args)
  if (frameId < 0) return frameArgumentInvalid()
  if (!frames.some((frame) => frame.frameId === frameId)) {
    return frameMissingFailure(frameId)
  }
  return undefined
}

function validateElementTarget(call: ToolCall, tabId: number, frames: TabFrame[]): ToolAnswer | undefined {
  if (call.name !== 'browser_click' && call.name !== 'browser_type') return undefined
  // A selector targets the live document directly, so there is no snapshot
  // baseline to be stale against.
  if (typeof call.args.selector === 'string' && call.args.selector.trim() !== '') return undefined
  const frameId = requestedFrame(call.args)
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  const snapshotted = snapshotDocumentsByTab.get(tabId)?.get(frameId)
  if (!sameFrameDocument(snapshotted, frame)) {
    return unavailable('The element reference does not belong to the current document. Call browser_snapshot again for current frame and index values.')
  }
  return undefined
}

function sameApprovalBoundary(before: ApprovalPrompt, after: ApprovalPrompt): boolean {
  return before.kind === after.kind
    && before.action === after.action
    && before.origins.length === after.origins.length
    && before.origins.every((origin, index) => origin === after.origins[index])
}

function sameTargetDocument(call: ToolCall, before: TabFrame[], after: TabFrame[]): boolean {
  const frameId = requestedFrame(call.args)
  return sameFrameDocument(
    before.find((frame) => frame.frameId === frameId),
    after.find((frame) => frame.frameId === frameId),
  )
}

/**
 * Name what invalidated an approval that was already granted, so the model (and
 * the user) can tell a real page change from an unstable auxiliary frame.
 *
 * @param approval - boundary the user consented to.
 * @param refreshed - the same boundary recomputed after consent.
 * @param call - the tool call being revalidated.
 * @param before - frame listing taken before consent.
 * @param after - frame listing taken after consent.
 * @returns a short reason for the failure message.
 */
export function invalidationReason(
  approval: ApprovalPrompt,
  refreshed: ApprovalPrompt | undefined,
  call: ToolCall,
  before: TabFrame[],
  after: TabFrame[],
): string {
  if (refreshed === undefined) return 'the operation no longer needs approval on this page'
  if (!sameApprovalBoundary(approval, refreshed)) {
    const added = refreshed.origins.filter((origin) => !approval.origins.includes(origin))
    const removed = approval.origins.filter((origin) => !refreshed.origins.includes(origin))
    const changes = [
      added.length > 0 ? `new origins: ${added.join(', ')}` : '',
      removed.length > 0 ? `removed origins: ${removed.join(', ')}` : '',
    ].filter((part) => part !== '')
    return `the tab's frames changed after you approved (${changes.join('; ')})`
  }
  const frameId = requestedFrame(call.args)
  const beforeFrame = before.find((frame) => frame.frameId === frameId)
  const afterFrame = after.find((frame) => frame.frameId === frameId)
  if (beforeFrame === undefined || afterFrame === undefined) {
    return `frame ${frameId} disappeared`
  }
  return `frame ${frameId} navigated (${beforeFrame.url} → ${afterFrame.url})`
}
