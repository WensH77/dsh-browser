/**
 * Page actions: click/type/press/scroll/navigate/get_text/wait, executed in
 * the content script against the real page (preserving login state), each
 * returning a short text status. Navigations return a fresh full snapshot
 * because the document — and the id registry — reset.
 *
 * All action results are pure text (DeepSeek models have no vision), so a
 * status line tells the model what happened and what state remains.
 *
 * @module
 */

import { accessibleName, isVisible, pageText, truncate } from './extract.ts'
import { isSensitiveField, maskValue } from './privacy.ts'
import type { ElementIds } from './ids.ts'
import type { SnapshotBudget } from './snapshot.ts'
import { buildSnapshot, renderSnapshot, uniqueSelector } from './snapshot.ts'

/** A settled action result. */
/** Where the page keeps a picture, for the background to fetch and hand to vision. */
export interface PageImageSource {
  /** Absolute URL (http/https/data) the background can read. */
  url?: string
  /** Inline raster the content script had to rasterize itself (a canvas). */
  dataUrl?: string
  kind: 'img' | 'canvas' | 'svg-image' | 'background'
  width?: number
  height?: number
  alt?: string
}

export interface ActionResult {
  text: string
  /** Accessible name of the element this action resolved, for the status feed. */
  label?: string
  /** Picture location reported by `browser_image`; never part of the model's text. */
  imageSource?: PageImageSource
  /** Page-authored snapshot delta; the background must wrap it as untrusted. */
  pageContent?: string
  /** A same-frame document navigation was scheduled after this response. */
  navigationPending?: boolean
}

/** How long an action should observe a ready document before returning. */
export interface PageSettlePolicy {
  /** Earliest return after the document becomes ready. */
  minimumMs: number
  /** Required DOM-quiet period before returning. */
  quietMs: number
  /** Hard cap after readiness; continuously animated pages cannot stall tools. */
  maxAfterReadyMs: number
  /** Hard cap while waiting for document readiness. */
  timeoutMs: number
}

const TYPE_SETTLE: PageSettlePolicy = { minimumMs: 32, quietMs: 32, maxAfterReadyMs: 100, timeoutMs: 5_000 }
const ACTION_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 50, maxAfterReadyMs: 250, timeoutMs: 5_000 }
const SCROLL_SETTLE: PageSettlePolicy = { minimumMs: 50, quietMs: 50, maxAfterReadyMs: 150, timeoutMs: 5_000 }
const EXPLICIT_WAIT_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 100, maxAfterReadyMs: 1_000, timeoutMs: 5_000 }
/** Keep automatic action context focused while preserving the negotiated full snapshot budget. */
const ACTION_DELTA_MAX_CHARS = 4_000

/**
 * Wait for document readiness and a mutation-free window. The old fixed delay
 * charged every action equally and still returned too early when a late DOM
 * update landed near its boundary. This observer returns early on already
 * stable pages, extends only for real mutations, and stays bounded on pages
 * with continuous animation.
 */
export function waitForPageSettled(policy: PageSettlePolicy = ACTION_SETTLE): Promise<boolean> {
  const startedAt = performance.now()
  let readyAt = document.readyState === 'complete' ? startedAt : undefined
  let lastMutationAt = startedAt
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  let observer: MutationObserver | undefined

  return new Promise((resolve) => {
    const finish = (settled: boolean): void => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      observer?.disconnect()
      document.removeEventListener('readystatechange', schedule)
      window.removeEventListener('load', schedule)
      resolve(settled)
    }
    const check = (): void => {
      timer = undefined
      const now = performance.now()
      if (readyAt === undefined && document.readyState === 'complete') {
        readyAt = now
        lastMutationAt = now
      }
      if (readyAt !== undefined) {
        const afterReady = now - readyAt
        const quietFor = now - lastMutationAt
        if ((afterReady >= policy.minimumMs && quietFor >= policy.quietMs)
          || afterReady >= policy.maxAfterReadyMs) {
          finish(true)
          return
        }
        const untilMinimum = Math.max(0, policy.minimumMs - afterReady)
        const untilQuiet = Math.max(0, policy.quietMs - quietFor)
        timer = setTimeout(check, Math.max(1, Math.min(policy.maxAfterReadyMs - afterReady, Math.max(untilMinimum, untilQuiet))))
        return
      }
      const elapsed = now - startedAt
      if (elapsed >= policy.timeoutMs) {
        finish(false)
        return
      }
      timer = setTimeout(check, Math.max(1, Math.min(100, policy.timeoutMs - elapsed)))
    }
    function schedule(): void {
      if (finished) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(check, 0)
    }

    if (document.documentElement !== null) {
      observer = new MutationObserver(() => {
        lastMutationAt = performance.now()
        schedule()
      })
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
    }
    document.addEventListener('readystatechange', schedule)
    window.addEventListener('load', schedule)
    schedule()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** How long to let a scrolled target stop moving before pressing it. */
const POINTER_SETTLE_MS = 400

/** How long to keep re-aiming a press at a target the page is still shifting. */
const POINTER_AIM_MS = 400

/** Longest a frame wait may block when no frame is coming. */
const FRAME_FALLBACK_MS = 32

/**
 * Yield one rendering frame, without depending on one arriving.
 *
 * A hidden tab gets no `requestAnimationFrame` callback at all, so waiting on
 * one alone hangs a press in a background tab until the tool call times out
 * (measured: the events were never dispatched and the call died at 90s). The
 * timer is the floor that keeps the loop moving, and it is the only wait while
 * the tab is hidden — there is nothing to animate there anyway.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') {
      requestAnimationFrame(() => { finish() })
    }
    setTimeout(finish, FRAME_FALLBACK_MS)
  })
}

function sameRect(a: DOMRect, b: DOMRect): boolean {
  return Math.abs(a.left - b.left) < 0.5
    && Math.abs(a.top - b.top) < 0.5
    && Math.abs(a.width - b.width) < 0.5
    && Math.abs(a.height - b.height) < 0.5
}

/**
 * Wait until the element's own rect stops moving.
 *
 * At least one frame always passes: `clickAction` scrolls the target into view
 * right before activating it, and on a lazily rendered or virtualized list
 * (Google Slides' filmstrip and grid view) that scroll is still animating when
 * the same task would otherwise measure it.
 */
async function settledRect(el: Element, timeoutMs: number): Promise<DOMRect> {
  const deadline = performance.now() + timeoutMs
  let previous = el.getBoundingClientRect()
  for (;;) {
    await nextFrame()
    const current = el.getBoundingClientRect()
    if (sameRect(previous, current)) return current
    previous = current
    if (performance.now() >= deadline) return current
  }
}

/**
 * Pick the point to press, preferring one that hit-tests back to the target.
 *
 * A page that resolves a press by its coordinates ignores events whose point
 * landed on a neighbour, so keep re-aiming while the list is still shifting;
 * the last measured centre is the fallback when the point never verifies (a
 * document without hit testing, or a target under an overlay).
 */
async function pointerPressPoint(el: Element): Promise<{ x: number; y: number }> {
  const deadline = performance.now() + POINTER_AIM_MS
  const canHitTest = typeof document.elementFromPoint === 'function'
  let point = { x: 0, y: 0 }
  for (;;) {
    const budget = Math.min(POINTER_SETTLE_MS, Math.max(0, deadline - performance.now()))
    const rect = await settledRect(el, budget)
    point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    if (!canHitTest) return point
    let hit: Element | null = null
    try {
      hit = document.elementFromPoint(point.x, point.y)
    } catch {
      hit = null
    }
    if (hit !== null && (hit === el || el.contains(hit))) return point
    if (performance.now() >= deadline) return point
  }
}

/**
 * Resolve the element a click/type call targets.
 *
 * `selector` exists so the model can act on what it can see — an icon button
 * with no accessible name still has a CSS path — without falling back to
 * running JavaScript, which bypasses approval, auditing, and settle detection.
 *
 * @param args - model arguments: `index` and/or `selector`.
 * @param ids - the snapshot inventory.
 * @returns the resolved element and how it was addressed.
 */
/**
 * Resolve the element an action targets.
 *
 * `label` is how both the side panel and the tool-result text point at the
 * element: `[<index>]` or `selector "<css>"`. It is deliberately structural —
 * page-authored text belongs inside the untrusted-content boundary, and an
 * element's accessible name spliced into a status line would sit outside it.
 * The element's own name reaches the model through browser_dom_query, which
 * encloses its answer.
 */
function targetOrThrow(args: Record<string, unknown>, ids: ElementIds): { element: Element; label: string } {
  const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
  if (selector !== '') {
    let matches: Element[]
    try {
      matches = [...document.querySelectorAll(selector)]
    } catch {
      throw new ActionError('bad-args', `selector is not valid CSS: ${selector}`)
    }
    const visible = matches.find((candidate) => isVisible(candidate))
    const element = visible ?? matches[0]
    if (element === undefined) {
      throw new ActionError('action-failed', `No element in this frame matches selector "${selector}". Nothing was clicked — check the selector with browser_dom_query (it prints each match's verified unique selector) or browser_snapshot.`)
    }
    if (visible === undefined) {
      throw new ActionError('action-failed', `The only element matching "${selector}" is not visible, so it was not clicked. Scroll it into view or use a visible match.`)
    }
    return { element, label: `selector "${selector}"` }
  }
  const index = optionalNumberArg(args, 'index')
  if (index === undefined) {
    throw new ActionError('bad-args', 'Provide either index (from browser_snapshot) or selector (CSS).')
  }
  return { element: elementOrThrow(ids, index), label: `[${index}]` }
}

function elementOrThrow(ids: ElementIds, index: number): Element {
  const el = ids.elementByIndex(index)
  if (el === undefined) {
    throw new ActionError('action-failed', `Element [${index}] does not exist; the page may have changed. Call browser_snapshot again to get current indices.`)
  }
  return el
}

/** Error carrying a stable wire code. */
export class ActionError extends Error {
  constructor(
    readonly code: 'action-failed' | 'bad-args',
    message: string,
  ) {
    super(message)
    this.name = 'ActionError'
  }
}

/** React-compatible value write: native setter + input/change events. */
function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) {
    input.value = value
  } else {
    setter.call(input, value)
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Action implementations; each returns a text result. */
export interface ActionContext {
  ids: ElementIds
  budget: SnapshotBudget
  /** Enabled only when the background may share page content without another approval. */
  includePageDelta?: boolean
}

/** Run one named action with its args. */
export async function runAction(action: string, args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  switch (action) {
    case 'browser_snapshot':
      return snapshotAction(args, ctx)
    case 'browser_click':
      return clickAction(args, ctx)
    case 'browser_click_pointer':
      return clickAction(args, ctx, activateElementAsPointer)
    case 'browser_slides_open_page':
      return slidesOpenPageAction(args)
    case 'browser_type':
      return typeAction(args, ctx)
    case 'browser_press':
      return pressAction(args, ctx)
    case 'browser_scroll':
      return scrollAction(args, ctx)
    case 'browser_navigate':
      return navigateAction(args)
    case 'browser_back':
      return historyAction(-1)
    case 'browser_forward':
      return historyAction(1)
    case 'browser_reload':
      return reloadAction()
    case 'browser_get_text':
      return getTextAction(args, ctx)
    case 'browser_dom_query':
      return domQueryAction(args)
    case 'browser_image':
      return imageSourceAction(args, ctx)
    case 'browser_wait':
      return waitAction(args, ctx)
    default:
      throw new ActionError('bad-args', `Unknown action: ${action}`)
  }
}

function snapshotAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const delta = args.delta === true
  const region = typeof args.region === 'string' && args.region !== '' ? args.region : undefined
  const budget = { ...ctx.budget, maxChars: optionalCharsBudget(args, ctx.budget.maxChars) }
  // 基线在每次快照后都更新：delta 调用才能相对上一次（无论是否 delta）比较。
  const view = buildSnapshot(ctx.ids, { delta, region, budget }, lastSnapshot)
  lastSnapshot = view
  return { text: renderSnapshot(view, delta) }
}

/** Module-level last snapshot state for delta mode (content-script lifetime). */
let lastSnapshot: ReturnType<typeof buildSnapshot> | null = null

/** Invalidate delta state after navigation (new document). */
function resetDeltaState(): void {
  lastSnapshot = null
}

/** Attach the settled page change while retaining the full view as the next delta baseline. */
function withPageDelta(text: string, ctx: ActionContext, label?: string): ActionResult {
  const named = label === undefined ? {} : { label }
  if (ctx.includePageDelta !== true || lastSnapshot === null) return { text, ...named }
  const view = buildSnapshot(ctx.ids, { delta: true, budget: ctx.budget }, lastSnapshot)
  lastSnapshot = view
  return {
    text,
    pageContent: renderSnapshot(view, true, Math.min(ctx.budget.maxChars, ACTION_DELTA_MAX_CHARS)),
    ...named,
  }
}

/**
 * Click one element.
 *
 * @param args - `index` or `selector` target, plus optional `frame`.
 * @param ctx - action context.
 * @param activate - how to press it; the pointer sequence when a page binds to
 *   the press rather than to `click` (see {@link activateElementAsPointer}).
 */
async function clickAction(
  args: Record<string, unknown>,
  ctx: ActionContext,
  activate: (el: Element) => void | Promise<void> = activateElement,
): Promise<ActionResult> {
  const resolved = targetOrThrow(args, ctx.ids)
  const el = resolved.element
  const label = accessibleName(el)
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  if (el instanceof HTMLAnchorElement) {
    const target = el.target.trim().toLowerCase()
    const sameFrameTarget = target === '' || target === '_self'
    let href: URL | undefined
    try { href = new URL(el.href) } catch { /* let the native click handle unusual links */ }
    const controlledNavigation = sameFrameTarget
      && !el.hasAttribute('download')
      && (href?.protocol === 'http:' || href?.protocol === 'https:')
    if (controlledNavigation && href !== undefined) {
      // Manual location assignment cannot preserve browser-managed link
      // semantics such as referrer suppression, hyperlink auditing, or
      // attribution registration. Keep native activation for those links,
      // but do not claim a replacement document is guaranteed: an SPA may
      // still cancel the click and remain in this document.
      const hasReferrerPolicy = typeof el.referrerPolicy === 'string' && el.referrerPolicy !== ''
      const requiresNativeActivation = el.relList.contains('noreferrer')
        || hasReferrerPolicy
        || el.hasAttribute('ping')
        || el.hasAttribute('attributionsrc')
      if (requiresNativeActivation) {
        setTimeout(() => { el.click() }, 0)
        return {
          text: `Clicked link ${resolved.label} using native browser activation. Call browser_snapshot to read the resulting state.`,
          label,
        }
      }
      // Dispatch the click handlers without its default navigation so a
      // client-side router can cancel synchronously and keep this document.
      const shouldNavigate = el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
      }))
      if (!shouldNavigate) {
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link ${resolved.label}.`, ctx, label)
      }
      const sameDocument = href.origin === location.origin
        && href.pathname === location.pathname
        && href.search === location.search
      if (sameDocument) {
        if (href.hash !== location.hash) location.hash = href.hash
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link ${resolved.label}.`, ctx, label)
      }
      // A cross-document navigation can unload this content script before an
      // awaited response. Answer first and navigate in the next task.
      setTimeout(() => { location.href = href.href }, 0)
      return {
        text: `Clicked link ${resolved.label}. Call browser_snapshot again after navigation settles.`,
        label,
        navigationPending: true,
      }
    }
    setTimeout(() => { el.click() }, 0)
    return { text: `Clicked link ${resolved.label}. The link may open outside the controlled frame.`, label }
  }
  if (el instanceof HTMLButtonElement && el.disabled) {
    throw new ActionError('action-failed', `Button ${resolved.label} is disabled.`)
  }
  await activate(el)
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Clicked ${resolved.label}.`, ctx, label)
}

/**
 * Activate one element the way a user click would.
 *
 * `HTMLElement.click()` does not exist on SVG elements (Slides filmstrip
 * thumbnails, chart and map controls), so those get a real bubbling
 * `MouseEvent('click')` instead of a cast that throws at runtime.
 *
 * @param el - the resolved target element.
 */
function activateElement(el: Element): void {
  if (el instanceof HTMLElement) {
    el.click()
    return
  }
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }))
}

/**
 * Activate an element the way a real pointer does.
 *
 * `activateElement` sends exactly one `click` event. That is enough for almost
 * every page, and it is deliberately left alone: adding events to the common
 * path risks double-firing handlers that already respond to `click`.
 *
 * Some canvas/SVG editors bind their controls to the *press sequence* instead —
 * Google Slides is the one this was built and measured against. Its filmstrip
 * thumbnails and toolbar controls watch `mousedown`/`mouseup` and never act on a
 * lone `click`, so a normal click reports success and changes nothing. Measured
 * on a real Slides filmstrip: `pointerdown` alone did nothing,
 * `pointerdown + pointerup + click` did nothing, and
 * `pointerdown + mousedown + pointerup + mouseup + click` switched the slide
 * every time — the mouse pair is the part that matters.
 *
 * Coordinates are mandatory: with no point inside the element's own rect the hit
 * test fails and nothing happens even though the events were dispatched. They
 * also have to be *current*: `clickAction` scrolls the target into view first,
 * and in a virtualized list (the Slides filmstrip and grid view) that scroll
 * keeps moving the element afterwards, so the press is aimed with a rect that is
 * re-measured — and hit-tested — immediately before it is sent.
 *
 * @param el - the element to activate.
 */
async function activateElementAsPointer(el: Element): Promise<void> {
  const point = await pointerPressPoint(el)
  const options = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    detail: 1,
    button: 0,
    buttons: 1,
    clientX: point.x,
    clientY: point.y,
  }
  const sequence: Array<[string, typeof MouseEvent | typeof PointerEvent]> = [
    ['pointerdown', PointerEvent],
    ['mousedown', MouseEvent],
    ['pointerup', PointerEvent],
    ['mouseup', MouseEvent],
    ['click', MouseEvent],
  ]
  for (const [type, EventCtor] of sequence) el.dispatchEvent(new EventCtor(type, options))
}

async function typeAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const text = typeof args.text === 'string' ? args.text : ''
  if (text === '') throw new ActionError('bad-args', 'text must not be empty.')
  const replace = args.replace === true
  const resolved = targetOrThrow(args, ctx.ids)
  const el = resolved.element
  const label = accessibleName(el)
  const contentEditable = el instanceof HTMLElement && el.isContentEditable
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || contentEditable)) {
    throw new ActionError('action-failed', `Element ${resolved.label} is not editable (${el.tagName.toLowerCase()}).`)
  }
  if (contentEditable) {
    if (replace) el.textContent = ''
    el.textContent = `${el.textContent ?? ''}${text}`
    el.dispatchEvent(new Event('input', { bubbles: true }))
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (replace) setNativeValue(el, '')
    setNativeValue(el, `${el.value}${text}`)
  }
  await waitForPageSettled(TYPE_SETTLE)
  return withPageDelta(`Entered ${text.length} characters into ${resolved.label}.`, ctx, label)
}

async function pressAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const key = typeof args.key === 'string' && args.key !== '' ? args.key : ''
  if (key === '') throw new ActionError('bad-args', 'key must not be empty.')
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
  if (key === 'Enter' && target instanceof HTMLInputElement && target.form !== null) {
    target.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Sent key "${key}".`, ctx)
}

async function scrollAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const direction = typeof args.direction === 'string' ? args.direction : ''
  const amount = typeof args.amount === 'number' ? args.amount : Math.floor(window.innerHeight * 0.8)
  switch (direction) {
    case 'top':
      window.scrollTo({ top: 0, behavior: 'instant' })
      break
    case 'bottom':
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
      break
    case 'up':
      window.scrollBy({ top: -amount, behavior: 'instant' })
      break
    case 'down':
      window.scrollBy({ top: amount, behavior: 'instant' })
      break
    default:
      throw new ActionError('bad-args', `direction must be up, down, top, or bottom; received "${direction}".`)
  }
  await waitForPageSettled(SCROLL_SETTLE)
  return withPageDelta(`Scrolled ${direction}.`, ctx)
}

/** Element fields `browser_dom_query` may return, beyond tag/name/selector. */
/**
 * Field names `browser_dom_query` may report. `name` is the computed
 * accessible name (always printed); `aria-label` is the literal attribute.
 */
const DOM_QUERY_FIELDS = new Set([
  'href', 'src', 'alt', 'value', 'id', 'class', 'title', 'aria-label', 'role', 'name',
  'type', 'checked', 'disabled', 'visible', 'text', 'placeholder',
])

/** Matches rendered per query, and the character ceiling for one answer. */
const DOM_QUERY_MAX_MATCHES = 50
const DOM_QUERY_MAX_CHARS = 8_000
const DOM_QUERY_VALUE_CHARS = 80

/**
 * Read specific fields off the elements a CSS selector matches.
 *
 * This is the read-only, narrow counterpart to running JavaScript: it answers
 * "what is this control, and what selector addresses it" without shipping a
 * DOM excerpt, and its per-element `selector` feeds `browser_click` directly.
 */
function domQueryAction(args: Record<string, unknown>): ActionResult {
  const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
  if (selector === '') throw new ActionError('bad-args', 'selector must not be empty.')
  const requested = args.fields === undefined ? [] : args.fields
  if (!Array.isArray(requested) || requested.some((field) => typeof field !== 'string')) {
    throw new ActionError('bad-args', 'fields must be an array of field names.')
  }
  const fields = requested as string[]
  const unknown = fields.filter((field) => !DOM_QUERY_FIELDS.has(field))
  if (unknown.length > 0) {
    throw new ActionError('bad-args', `Unknown field(s): ${unknown.join(', ')}. Allowed: ${[...DOM_QUERY_FIELDS].join(', ')}.`)
  }
  const limit = Math.min(
    Math.max(typeof args.limit === 'number' && Number.isInteger(args.limit) ? args.limit : 20, 1),
    DOM_QUERY_MAX_MATCHES,
  )

  let matches: Element[]
  try {
    matches = [...document.querySelectorAll(selector)]
  } catch {
    throw new ActionError('bad-args', `selector is not valid CSS: ${selector}`)
  }
  if (matches.length === 0) {
    return { text: `dom query: 0 matches for "${selector}" in this frame.` }
  }

  const value = (element: Element, field: string): string | undefined => {
    switch (field) {
      case 'visible': return String(isVisible(element))
      case 'text': return truncate(element.textContent ?? '', DOM_QUERY_VALUE_CHARS).text
      // The accessible name is reported once, in the leading `name=` field.
      case 'name': return undefined
      case 'aria-label': {
        // Name it as the attribute it is; the computed accessible name lives in
        // `name=`, and callers must not build attribute selectors from it.
        const attribute = element.getAttribute('aria-label')
        return attribute === null ? undefined : truncate(attribute, DOM_QUERY_VALUE_CHARS).text
      }
      // Only checkable inputs have a meaningful checked state.
      case 'checked': return element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')
        ? String(element.checked)
        : undefined
      case 'disabled': return 'disabled' in element ? String((element as HTMLInputElement).disabled) : undefined
      // A credential field is masked here exactly as it is in a snapshot: a
      // form value has more than one path to the model, so the same gate has to
      // hold on this one. `privacy.ts` states that contract; this is where it
      // is honoured for the dom-query path.
      case 'value': {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return undefined
        return isSensitiveField(element)
          ? maskValue(element.value)
          : truncate(element.value, DOM_QUERY_VALUE_CHARS).text
      }
      default: {
        const attribute = element.getAttribute(field)
        return attribute === null ? undefined : truncate(attribute, DOM_QUERY_VALUE_CHARS).text
      }
    }
  }

  // Values may themselves contain quotes (a selector like input[name="x"]), so
  // the wrapper escapes rather than nests them.
  const quoted = (input: string): string => `"${input.replace(/"/g, '\\"')}"`
  const lines: string[] = [`dom query: ${matches.length} match(es) for ${quoted(selector)} in this frame.`]
  for (const [position, element] of matches.slice(0, limit).entries()) {
    // `name=` is labelled: an unlabelled quoted string sat exactly where field
    // values sit, and a model read it as an `aria-label` attribute it could
    // build a selector from.
    const parts = [`[${position + 1}] ${element.localName} name=${quoted(accessibleName(element))}`]
    const unique = uniqueSelector(element)
    if (unique !== undefined) parts.push(`selector=${quoted(unique)}`)
    for (const field of fields) {
      if (field === 'name') continue
      const read = value(element, field)
      if (read !== undefined && read !== '') parts.push(`${field}=${quoted(read)}`)
    }
    lines.push(parts.join(' '))
  }
  if (matches.length > limit) {
    lines.push(`…(${matches.length - limit} further match(es) not shown; raise limit or narrow the selector)`)
  }
  return { text: truncate(lines.join('\n'), DOM_QUERY_MAX_CHARS).text }
}

/**
 * Locate a picture and report where its bytes live.
 *
 * `browser_image` answers "what does this chart show" without a screenshot: the
 * background reads the reported source (extension fetches carry the extension's
 * host permissions, so a cross-origin picture needs no CORS header, and a
 * `data:` URL is decoded as-is), which works with DevTools open and on a
 * background tab. Only the raster's location travels here — never its bytes in
 * the model's text.
 */
function imageSourceAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const resolved = targetOrThrow(args, ctx.ids)
  const source = describeImageSource(resolved.element)
  if (source === undefined) {
    throw new ActionError(
      'action-failed',
      `${resolved.label} is not a picture: expected an <img>, a <canvas>, an SVG <image>, or an element with a CSS background image. `
      + 'Call browser_dom_query for the element, or browser_capture for a screenshot of the page.',
    )
  }
  const size = source.width === undefined || source.height === undefined ? '' : ` ${source.width}x${source.height} px`

  return { text: `image source: ${source.kind}${size}`, label: resolved.label, imageSource: source }
}

/** Resolve the picture one element refers to, if it is one. */
function describeImageSource(el: Element): PageImageSource | undefined {
  if (el instanceof HTMLImageElement) {
    const url = el.currentSrc !== '' ? el.currentSrc : el.src
    if (url === '') return undefined
    const known = el.naturalWidth > 0 && el.naturalHeight > 0
    return {
      url,
      kind: 'img',
      ...known ? { width: el.naturalWidth, height: el.naturalHeight } : {},
      ...el.alt.trim() === '' ? {} : { alt: el.alt.trim().slice(0, 200) },
    }
  }
  if (el instanceof HTMLCanvasElement) {
    if (el.width === 0 || el.height === 0) return undefined
    let dataUrl: string
    try {
      dataUrl = el.toDataURL('image/png')
    } catch {
      // A canvas painted from another origin has no exportable pixels.
      throw new ActionError(
        'action-failed',
        'This canvas is tainted by cross-origin content, so the page cannot export it. Use browser_capture to screenshot it instead.',
      )
    }
    return { dataUrl, kind: 'canvas', width: el.width, height: el.height }
  }
  if (typeof SVGImageElement !== 'undefined' && el instanceof SVGImageElement) {
    const href = el.href.baseVal
    return href === '' ? undefined : { url: absoluteUrl(href), kind: 'svg-image' }
  }
  const background = backgroundImageUrl(el)
  return background === undefined ? undefined : { url: background, kind: 'background' }
}

function absoluteUrl(value: string): string {
  try {
    return new URL(value, location.href).href
  } catch {
    return value
  }
}

/** Absolute URL from an element's CSS `background-image`, when it has one. */
function backgroundImageUrl(el: Element): string | undefined {
  const value = getComputedStyle(el).backgroundImage
  const match = /^url\(\s*["']?([^"')]+)["']?\s*\)$/.exec(value.trim())
  if (match === null || match[1] === undefined || match[1].trim() === '') return undefined
  return absoluteUrl(match[1].trim())
}

async function navigateAction(args: Record<string, unknown>): Promise<ActionResult> {
  const url = typeof args.url === 'string' && args.url !== '' ? args.url : ''
  if (url === '') throw new ActionError('bad-args', 'url must not be empty.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ActionError('bad-args', `url is not valid: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ActionError('bad-args', `Only http and https URLs are supported; received ${parsed.protocol}.`)
  }
  resetDeltaState()
  // Cross-document navigation unloads this content script and destroys the
  // tabs.sendMessage response port before any await settles — so answer
  // FIRST, then navigate in a fresh task. The model re-snapshots after load.
  setTimeout(() => { location.href = parsed.href }, 0)
  return {
    text: `Navigating to ${parsed.href}. Call browser_snapshot again after the page loads.`,
    navigationPending: true,
  }
}

async function historyAction(delta: 1 | -1): Promise<ActionResult> {
  resetDeltaState()
  if (delta === -1 && history.length <= 1) {
    // A tab opened directly at its first URL (our new-tab binding) has no
    // previous entry; history.back() would be a silent no-op.
    return {
      text: 'There is no previous page in this tab history (the tab was opened directly at this URL). '
        + 'Go back by navigating to the previous URL with browser_navigate instead.',
    }
  }
  // 同 navigate：先响应再导航（文档卸载会销毁响应端口）。
  setTimeout(() => { if (delta === -1) history.back(); else history.forward() }, 0)
  return {
    text: 'Navigating through browser history. Call browser_snapshot again after the page loads.',
    navigationPending: true,
  }
}

function reloadAction(): ActionResult {
  resetDeltaState()
  setTimeout(() => { location.reload() }, 0)
  return {
    text: 'The page is reloading. Call browser_snapshot again after it loads.',
    navigationPending: true,
  }
}

/* -------------------------------------------------------------------------- *
 * Google Slides: open one page
 * -------------------------------------------------------------------------- */

/** The Slides grid-view toggle; `aria-pressed` says whether the grid is up. */
const SLIDES_GRID_TOGGLE = '#grid-view-toggle'

/** One slide, rendered either in the filmstrip or in grid view. */
const SLIDES_THUMBNAIL = '.punch-filmstrip-thumbnail'

/** A rendered slide group is `filmstrip-slide-<0-based index>-<slideId>`. */
const SLIDES_SLIDE_ID = /^filmstrip-slide-(\d+)-(.+)$/

/** Scroll steps allowed while walking a long deck's window onto the page. */
const SLIDES_MAX_SCROLL_STEPS = 14

/** Presses allowed before the grid path is given up (one may hit a neighbour). */
const SLIDES_MAX_ATTEMPTS = 4

const SLIDES_GRID_SETTLE_MS = 3_000
const SLIDES_SWITCH_SETTLE_MS = 2_500
const SLIDES_POLL_MS = 100

interface SlidesPage {
  /** 0-based position of the slide in the deck. */
  index: number
  slideId: string
  thumbnail: Element
}

function slidesToggle(): HTMLElement | null {
  const toggle = document.querySelector(SLIDES_GRID_TOGGLE)
  return toggle instanceof HTMLElement ? toggle : null
}

function slidesGridOpen(): boolean {
  return slidesToggle()?.getAttribute('aria-pressed') === 'true'
}

/** Every slide the editor currently renders, keyed by its slide id. */
function slidesRenderedPages(): SlidesPage[] {
  const pages = new Map<string, SlidesPage>()
  for (const container of document.querySelectorAll('[id^="filmstrip-slide-"]')) {
    const match = SLIDES_SLIDE_ID.exec(container.id)
    if (match === null) continue
    const index = Number(match[1])
    if (!Number.isInteger(index)) continue
    const slideId = (match[2] ?? '').replace(/-(?:bg|paragraph-\d+)$/, '')
    if (slideId === '' || pages.has(slideId)) continue
    const thumbnail = container.closest(SLIDES_THUMBNAIL)
    if (thumbnail === null) continue
    pages.set(slideId, { index, slideId, thumbnail })
  }
  return [...pages.values()]
}

/** The slide the deck is on, read from the editor's URL hash. */
function slidesCurrentSlideId(): string | null {
  const match = /^#slide=id\.(.+)$/.exec(location.hash)
  return match?.[1] ?? null
}

function slidesPageOfSlideId(slideId: string): number | null {
  const page = slidesRenderedPages().find((candidate) => candidate.slideId === slideId)
  return page === undefined ? null : page.index + 1
}

async function slidesWaitFor(ready: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    if (ready()) return true
    if (performance.now() >= deadline) return false
    await sleep(SLIDES_POLL_MS)
  }
}

/** Press one Slides control and wait for the state it is supposed to change. */
async function slidesPress(el: Element, applied: () => boolean, notes: string[]): Promise<boolean> {
  await activateElementAsPointer(el)
  const done = await slidesWaitFor(applied, SLIDES_GRID_SETTLE_MS)
  if (!done) notes.push('a Slides control did not react to the press')
  return done
}

/**
 * Scroll the editor's rendered window until it covers the wanted slide.
 *
 * The filmstrip and the grid only keep a window of slides in the DOM, so a page
 * far down the deck has to be walked into view before it can be pressed.
 */
async function slidesRevealPage(page: number): Promise<SlidesPage | null> {
  const index = page - 1
  for (let step = 0; step <= SLIDES_MAX_SCROLL_STEPS; step++) {
    const pages = slidesRenderedPages()
    const hit = pages.find((candidate) => candidate.index === index)
    if (hit !== undefined) return hit
    if (pages.length === 0) return null
    const edge = pages.reduce((extreme, candidate) => index < extreme.index
      ? (candidate.index < extreme.index ? candidate : extreme)
      : (candidate.index > extreme.index ? candidate : extreme))
    const seen = new Set(pages.map((candidate) => candidate.slideId))
    edge.thumbnail.scrollIntoView({ block: 'center', behavior: 'instant' })
    const moved = await slidesWaitFor(
      () => slidesRenderedPages().some((candidate) => !seen.has(candidate.slideId)),
      SLIDES_GRID_SETTLE_MS,
    )
    if (!moved) return null
  }
  return null
}

/**
 * Open one page of the Google Slides deck in the controlled tab.
 *
 * Slides renders slides in a virtualized window, and its filmstrip resolves a
 * press by coordinates rather than by the element the events were sent to —
 * measured 2026-09-21: pressing thumbnail 13 left the deck on slide 11, because
 * the scroll `browser_click_pointer` performs is undone by the editor before the
 * press is handled. Grid view is the surface that does behave: its cells keep
 * their position, so a press lands on the cell it was aimed at.
 *
 * The loop presses the wanted thumbnail in grid view, leaves the grid so the
 * deck actually opens the selection, and reads the URL hash back. A press that
 * moves the deck is progress and is retried; a press that changes nothing is a
 * failure and falls back to loading the slide by hash — a same-document jump in
 * Slides, and the only path that does not depend on a press reaching the page.
 */
async function slidesOpenPageAction(args: Record<string, unknown>): Promise<ActionResult> {
  const page = numberArg(args, 'page')
  if (!Number.isInteger(page) || page < 1) {
    throw new ActionError('bad-args', 'page must be a positive whole number (the deck counts from 1).')
  }
  const toggle = slidesToggle()
  if (toggle === null) {
    throw new ActionError(
      'action-failed',
      'browser_slides_open_page needs a Google Slides editor tab: the grid-view toggle was not found on this page.',
    )
  }

  const startedInGrid = slidesGridOpen()
  const startId = slidesCurrentSlideId()
  const startPage = startId === null ? null : slidesPageOfSlideId(startId)
  if (startPage === page) return { text: `Already on slide ${page}.` }

  const notes: string[] = []
  const gridNote = startedInGrid ? ' The grid view is now closed.' : ''
  let target: SlidesPage | null = null
  let landedPage: number | null = null

  for (let attempt = 1; attempt <= SLIDES_MAX_ATTEMPTS; attempt++) {
    if (!slidesGridOpen() && !await slidesPress(toggle, slidesGridOpen, notes)) break
    const revealed = await slidesRevealPage(page)
    if (revealed === null) {
      notes.push(`slide ${page} could not be scrolled into the rendered window`)
      break
    }
    target = revealed
    // Centre it first so the press does not race the window's own scrolling.
    revealed.thumbnail.scrollIntoView({ block: 'center', behavior: 'instant' })
    await activateElementAsPointer(revealed.thumbnail)
    await sleep(SLIDES_POLL_MS)
    if (slidesGridOpen()) await slidesPress(toggle, () => !slidesGridOpen(), notes)
    await slidesWaitFor(() => slidesCurrentSlideId() !== null, SLIDES_SWITCH_SETTLE_MS)

    const nowId = slidesCurrentSlideId()
    landedPage = nowId === null ? null : slidesPageOfSlideId(nowId)
    if (landedPage === page) {
      const tries = attempt > 1 ? ` after ${attempt} presses` : ''
      return { text: `Opened slide ${page} from grid view${tries}.${gridNote}` }
    }
    if (landedPage === startPage || nowId === startId) {
      notes.push(`press ${attempt} did not move the deck`)
      break
    }
    notes.push(`press ${attempt} landed on slide ${landedPage ?? 'unknown'}`)
  }

  if (target === null) {
    throw new ActionError('action-failed', `Could not reach slide ${page} in the rendered window. ${notes.join('; ')}.`)
  }

  // A press that moves the deck but misses the page is not a failure: report
  // where it stopped and the id needed to finish the jump in one call.
  if (landedPage !== null && landedPage !== startPage) {
    return {
      text: `Grid presses moved the deck to slide ${landedPage}, not ${page}. `
        + `The target slide id is ${target.slideId}: call browser_navigate with "#slide=id.${target.slideId}" `
        + `or call browser_slides_open_page again. Notes: ${notes.join('; ')}.`,
    }
  }

  // Nothing moved: load the slide by hash instead (a same-document jump).
  if (slidesGridOpen()) await slidesPress(toggle, () => !slidesGridOpen(), notes)
  location.hash = `#slide=id.${target.slideId}`
  const jumped = await slidesWaitFor(() => slidesCurrentSlideId() === target?.slideId, SLIDES_SWITCH_SETTLE_MS)
  if (!jumped) {
    throw new ActionError(
      'action-failed',
      `Could not open slide ${page}: the grid press did not move the deck and loading #slide=id.${target.slideId} `
      + `did not take effect either. ${notes.join('; ')}.`,
    )
  }
  const jumpedPage = slidesPageOfSlideId(target.slideId)
  return {
    text: `Grid presses did not move the deck, so slide ${page} was loaded by hash`
      + `${jumpedPage === null ? '' : ` (the deck is on slide ${jumpedPage})`}.${gridNote}`,
  }
}

async function getTextAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  const source = selector !== undefined ? document.querySelector(selector) : null
  const text = source !== null ? pageText(source) : selector !== undefined ? `No element matched selector: ${selector}` : pageText()
  const scope = selector === undefined ? 'the whole page' : `selector "${selector}"`
  const find = typeof args.find === 'string' ? args.find.trim() : ''
  // The ceiling is the negotiated tab budget, not a fixed 8000: a caller asking
  // for 20000 used to get 8000 back with no way to tell. `maxChars` shrinks the
  // read, never the negotiated maximum.
  if (find !== '') return { text: findInText(text, find, scope, args, ctx.budget.maxChars) }
  const truncated = truncate(text, optionalCharsBudget(args, ctx.budget.maxChars))
  return { text: truncated.text + (truncated.truncated > 0 ? `\n(Truncated ${truncated.truncated} characters.)` : '') }
}

/** Characters of context returned on each side of a text match. */
const FIND_CONTEXT_DEFAULT = 300
const FIND_CONTEXT_MAX = 2_000
/** Matches reported in one search; the count is always reported in full. */
const FIND_MATCH_LIMIT = 5

/**
 * Locate a phrase in the page text and return a bounded window around it.
 *
 * This exists so "what does this page/section say" never has to be answered by
 * scripting DOM traversal: the search runs over the whole extracted text (not a
 * truncated head), and the returned window stays small.
 *
 * @param text - the full text of the chosen scope.
 * @param needle - phrase to find (literal, case-insensitive).
 * @param scope - human label for where the text came from.
 * @param args - tool arguments (`context`, `maxChars`).
 * @param ceiling - the negotiated per-read ceiling `maxChars` may shrink but not raise.
 * @returns the rendered match report.
 */
function findInText(text: string, needle: string, scope: string, args: Record<string, unknown>, ceiling: number): string {
  const lowerText = text.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  const context = typeof args.context === 'number' && Number.isInteger(args.context)
    ? Math.min(Math.max(args.context, 0), FIND_CONTEXT_MAX)
    : FIND_CONTEXT_DEFAULT

  const offsets: number[] = []
  for (let at = lowerText.indexOf(lowerNeedle); at !== -1; at = lowerText.indexOf(lowerNeedle, at + lowerNeedle.length)) {
    offsets.push(at)
    if (offsets.length >= FIND_MATCH_LIMIT) break
  }
  if (offsets.length === 0) {
    return `text search: no match for "${needle}" in ${scope} (case-insensitive, ${text.length} characters searched).`
  }

  const budget = optionalCharsBudget(args, ceiling)
  // Keep the match itself inside the budget: a wide context with a small
  // maxChars must shrink the window, never cut the phrase out of it.
  const perMatch = Math.max(120, Math.floor((budget - 120) / offsets.length))
  const width = Math.min(context, Math.max(0, Math.floor((perMatch - needle.length) / 2)))
  const exact = offsets.length === FIND_MATCH_LIMIT ? `${FIND_MATCH_LIMIT}+` : String(offsets.length)
  const header = `text search: ${exact} match(es) for "${needle}" in ${scope} (case-insensitive, ±${width} chars of context).`
  const blocks = offsets.map((offset, index) => {
    const start = Math.max(0, offset - width)
    const end = Math.min(text.length, offset + needle.length + width)
    const window = text.slice(start, offset)
      + `«${text.slice(offset, offset + needle.length)}»`
      + text.slice(offset + needle.length, end)
    return `[${index + 1}] chars ${start + 1}-${end} of ${text.length}\n${window}`
  })
  const truncated = truncate(`${header}\n${blocks.join('\n')}`, budget)
  return truncated.text
    + (truncated.truncated > 0 ? `\n(Truncated ${truncated.truncated} characters; raise maxChars or shorten the context.)` : '')
}

async function waitAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const ms = typeof args.ms === 'number' && args.ms > 0 ? args.ms : 0
  await waitForPageSettled(EXPLICIT_WAIT_SETTLE)
  if (ms > 0) await sleep(ms)
  return withPageDelta(`The page is stable${ms > 0 ? ` after an additional ${ms}ms wait` : ''}.`, ctx)
}

function optionalCharsBudget(args: Record<string, unknown>, fallbackMax: number): number {
  const value = args.maxChars
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallbackMax
  return Math.min(Math.max(value, 500), fallbackMax)
}

/** Read an optional numeric argument without throwing when it is absent. */
function optionalNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  return args[name] === undefined ? undefined : numberArg(args, name)
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ActionError('bad-args', `${name} must be a non-negative integer; received ${String(value)}.`)
  }
  return value
}
