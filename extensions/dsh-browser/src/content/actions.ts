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
      return getTextAction(args)
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

async function clickAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
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
  activateElement(el)
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
      case 'value': return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? truncate(element.value, DOM_QUERY_VALUE_CHARS).text
        : undefined
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

async function getTextAction(args: Record<string, unknown>): Promise<ActionResult> {
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  const source = selector !== undefined ? document.querySelector(selector) : null
  const text = source !== null ? pageText(source) : selector !== undefined ? `No element matched selector: ${selector}` : pageText()
  const scope = selector === undefined ? 'the whole page' : `selector "${selector}"`
  const find = typeof args.find === 'string' ? args.find.trim() : ''
  if (find !== '') return { text: findInText(text, find, scope, args) }
  const truncated = truncate(text, optionalCharsBudget(args, 8_000))
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
 * @returns the rendered match report.
 */
function findInText(text: string, needle: string, scope: string, args: Record<string, unknown>): string {
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

  const budget = optionalCharsBudget(args, 8_000)
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
