/**
 * Text-only page snapshot: the model's entire view of the page.
 *
 * DeepSeek models cannot see images, so the snapshot renders the page as
 * structured text under a hard character budget: URL/title, main content, a
 * numbered interactive inventory, and form fields (sensitive values masked).
 * `delta` mode returns only what changed since the last snapshot, and stable
 * element ids keep the model's addressing valid across snapshots.
 *
 * @module
 */

import { accessibleName, collectInteractive, cssEscape, isChromeLandmark, isInViewport, mainText, pageText, truncate } from './extract.ts'
import { ElementIds } from './ids.ts'
import { isSensitiveField, maskValue } from './privacy.ts'

/** Role label per element kind (model-facing vocabulary). */
function roleOf(el: Element): string {
  const role = el.getAttribute('role')
  if (role !== null && role !== '') return role
  if (el instanceof HTMLAnchorElement) return 'link'
  if (el instanceof HTMLButtonElement) return 'button'
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case 'checkbox': return 'checkbox'
      case 'radio': return 'radio'
      default: return 'input'
    }
  }
  if (el instanceof HTMLSelectElement) return 'select'
  if (el instanceof HTMLTextAreaElement) return 'textarea'
  if (el instanceof HTMLElement && el.isContentEditable) return 'contenteditable'
  return el.tagName.toLowerCase()
}

/** One numbered interactive element. */
interface InventoryItem {
  index: number
  role: string
  name: string
  disabled?: boolean
  checked?: boolean
  selected?: boolean
  href?: string
  inViewport: boolean
  /** Part of persistent page chrome (nav/header/footer) rather than content. */
  chrome?: boolean
}

/** One numbered form field with its (masked) value. */
interface FormFieldView {
  index: number
  label: string
  kind: string
  value: string
  masked: boolean
  checked?: boolean
  required?: boolean
}

/** One page snapshot. */
export interface SnapshotView {
  version: number
  url: string
  title: string
  ready: 'complete' | 'loading'
  main: string
  items: InventoryItem[]
  forms: FormFieldView[]
  /** ids that changed since the last snapshot (delta mode). */
  changed: number[]
  /** ids that disappeared since the last snapshot (delta mode). */
  removed: number[]
  /** true when the inventory was renumbered (model should re-read ids). */
  reindexed: boolean
  /** Budget accounting: characters cut from main text and items/forms dropped by count caps. */
  truncated: { mainChars: number; itemsDropped: number; formsDropped: number }
  /** Item cap in force for this frame, so a saturated inventory is visible as such. */
  itemCap: number
  /**
   * Chrome items left out of this render because they are byte-identical to the
   * previous snapshot: their indices still work, the text just is not resent.
   */
  collapsedChrome: { count: number; sinceVersion: number } | undefined
  /**
   * Highest-ranked controls the item cap dropped, each with a verified unique
   * CSS selector. They stay reachable through `browser_click { selector }`
   * without the model having to inspect the DOM itself.
   */
  omitted: Array<{ name: string; selector: string }>
  /** 总预算（渲染封顶用）。 */
  budgetChars: number
}

/** Snapshot budgets: negotiated with the plugin via hello caps. */
export interface SnapshotBudget {
  maxItems: number
  maxForms: number
  maxChars: number
}

/** Options for one snapshot build. */
export interface SnapshotOptions {
  delta?: boolean
  region?: string
  budget: SnapshotBudget
}

/** Headline for a link: same-origin relative path, else host + path. */
function hrefHeadline(href: string): string {
  try {
    const url = new URL(href, document.baseURI)
    return url.origin === location.origin ? `${url.pathname}${url.search}` : `${url.host}${url.pathname}`
  } catch {
    return href
  }
}

/**
 * Build a snapshot of the current page.
 *
 * Reconciles the stable id registry, collects the inventory (viewport-first,
 * capped), extracts main content (budgeted), and — in delta mode — diffs
 * against the previous snapshot.
 *
 * @param ids - the stable id registry (one per content-script lifetime).
 * @param options - delta flag, region selector, and negotiated budgets.
 * @param last - previous snapshot view, or null for the first snapshot.
 * @returns the snapshot view.
 */
export function buildSnapshot(ids: ElementIds, options: SnapshotOptions, last: SnapshotView | null): SnapshotView {
  const elements = collectInteractive(document)
  const { added, removed } = ids.assign(elements)
  // A renumbering is only meaningful relative to a previous snapshot: the
  // first snapshot on a fresh document always adds everything.
  const reindexed = last !== null && added + removed > elements.length * 0.5

  // Measure viewport membership once. Calling getBoundingClientRect from a
  // sort comparator forces repeated layout reads on large pages.
  const elementViews = elements.map((element) => ({
    element,
    inViewport: isInViewport(element),
    inChrome: isChromeLandmark(element),
  }))
  // Rank what the user is looking at, and demote persistent chrome: a sidebar
  // full of links must not consume the inventory budget the page content needs.
  const rank = (view: { inViewport: boolean; inChrome: boolean }): number =>
    (view.inViewport ? 2 : 0) + (view.inChrome ? 0 : 1)
  const ordered = [...elementViews].sort((a, b) => rank(b) - rank(a))
  const names = new Map<Element, string>()
  const nameOf = (element: Element): string => {
    let name = names.get(element)
    if (name === undefined) {
      name = accessibleName(element)
      names.set(element, name)
    }
    return name
  }

  const items: InventoryItem[] = []
  for (const { element: el, inViewport } of ordered.slice(0, options.budget.maxItems)) {
    const index = ids.indexOf(el)
    if (index === undefined) continue
    const item: InventoryItem = {
      index,
      role: roleOf(el),
      name: nameOf(el),
      inViewport,
      ...isChromeLandmark(el) ? { chrome: true } : {},
    }
    if (el instanceof HTMLButtonElement && el.disabled) item.disabled = true
    if (el instanceof HTMLInputElement) {
      if (el.disabled) item.disabled = true
      if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked
    }
    const ariaChecked = el.getAttribute('aria-checked')
    if (ariaChecked === 'true' || ariaChecked === 'false') item.checked = ariaChecked === 'true'
    if (el instanceof HTMLOptionElement && el.selected) item.selected = true
    if (el instanceof HTMLAnchorElement && el.href !== '') item.href = hrefHeadline(el.href)
    items.push(item)
  }

  // Chrome that did not change since the last snapshot is not resent: the model
  // still holds it, the indices remain valid, and re-reading it is a tool call.
  const chromeItems = items.filter((item) => item.chrome === true)
  const previousChrome = last === null ? [] : last.items.filter((item) => item.chrome === true)
  const chromeUnchanged = last !== null
    && chromeItems.length > 0
    && chromeItems.length === previousChrome.length
    && chromeItems.every((item, at) => sameChromeItem(item, previousChrome[at]!))
  const collapsedChrome = chromeUnchanged
    ? { count: chromeItems.length, sinceVersion: last.version }
    : undefined

  // Form controls are already part of the visible interactive inventory, so
  // reuse that scan instead of querying, styling, and measuring them again.
  const formElements = elements.filter((el) => el instanceof HTMLInputElement
    || el instanceof HTMLSelectElement
    || el instanceof HTMLTextAreaElement)
  const forms: FormFieldView[] = []
  for (const el of formElements.slice(0, options.budget.maxForms)) {
    const index = ids.indexOf(el)
    if (index === undefined) continue
    const masked = isSensitiveField(el)
    const checkable = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
    const value = checkable
      ? ''
      : el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value
      : el instanceof HTMLSelectElement
        ? selectedText(el)
        : ''
    forms.push({
      index,
      label: nameOf(el),
      kind: el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase(),
      value: masked ? maskValue(value) : value.slice(0, 120),
      masked,
      ...checkable ? { checked: el.checked } : {},
      ...el instanceof HTMLInputElement && el.required ? { required: true } : {},
    })
  }

  const regionEl = options.region !== undefined && options.region !== ''
    ? document.querySelector(options.region)
    : null
  const mainSource = regionEl !== null ? pageText(regionEl) : mainText(document)
  const mainBudget = Math.floor(options.budget.maxChars * 0.5)
  const main = truncate(mainSource, mainBudget)

  const lastItems = last === null ? new Map<number, InventoryItem>() : new Map(last.items.map((item) => [item.index, item]))
  const lastForms = last === null ? new Map<number, FormFieldView>() : new Map(last.forms.map((form) => [form.index, form]))

  const changed = new Set<number>()
  const removedIds: number[] = []
  if (options.delta === true && last !== null) {
    if (last.main !== main.text || last.url !== location.href || last.title !== document.title) {
      changed.add(-1) // -1 = 正文/标题/URL 变化（渲染时说明）
    }
    for (const item of items) {
      const before = lastItems.get(item.index)
      if (before === undefined || !sameItem(before, item)) changed.add(item.index)
    }
    const currentItemIds = new Set(items.map((item) => item.index))
    for (const index of lastItems.keys()) {
      if (!currentItemIds.has(index)) removedIds.push(index)
    }
    for (const form of forms) {
      const before = lastForms.get(form.index)
      if (before === undefined || !sameForm(before, form)) changed.add(form.index)
    }
  }

  return {
    version: (last?.version ?? 0) + 1,
    url: location.href,
    title: document.title,
    ready: document.readyState === 'complete' ? 'complete' : 'loading',
    main: main.text,
    items,
    forms,
    changed: options.delta === true ? [...changed] : [],
    removed: options.delta === true ? removedIds : [],
    reindexed,
    itemCap: options.budget.maxItems,
    collapsedChrome,
    omitted: ordered
      .slice(options.budget.maxItems, options.budget.maxItems + OMITTED_SELECTOR_HINTS)
      .map(({ element }) => ({ name: nameOf(element), selector: uniqueSelector(element) }))
      .filter((entry): entry is { name: string; selector: string } => entry.selector !== undefined),
    truncated: {
      mainChars: main.truncated,
      itemsDropped: Math.max(0, elements.length - options.budget.maxItems),
      formsDropped: Math.max(0, formElements.length - options.budget.maxForms),
    },
    budgetChars: options.budget.maxChars,
  }
}

function selectedText(select: HTMLSelectElement): string {
  return [...select.selectedOptions].map((option) => option.textContent ?? '').join(', ')
}

function sameItem(a: InventoryItem, b: InventoryItem): boolean {
  return a.role === b.role && a.name === b.name && a.href === b.href
    && a.disabled === b.disabled && a.checked === b.checked && a.inViewport === b.inViewport
}

function sameForm(a: FormFieldView, b: FormFieldView): boolean {
  return a.label === b.label && a.kind === b.kind && a.value === b.value && a.masked === b.masked
    && a.checked === b.checked && a.required === b.required
}

/**
 * Render a snapshot as the model-facing text (the whole snapshot is one text
 * block; no images anywhere).
 * @param view - snapshot to render.
 * @param delta - whether this is a delta render (changes only).
 * @param maxChars - optional render cap for compact derivative responses.
 * @returns the text payload.
 */
/** 渲染结果的整体预算：主文/清单之外的部分（标题、URL、包装行）也计入。 */
function capRendered(text: string, budgetChars: number): string {
  if (text.length <= budgetChars) return text
  return `${text.slice(0, budgetChars)}…(truncated to the snapshot character budget)`
}

function renderItem(item: InventoryItem): string {
  const state = [
    item.disabled === true ? 'disabled' : undefined,
    item.checked === undefined ? undefined : item.checked ? 'checked' : 'unchecked',
    item.inViewport ? undefined : 'outside viewport',
  ].filter((value) => value !== undefined).join('/')
  const stateText = state === '' ? '' : ` [${state}]`
  const hrefText = item.href !== undefined ? ` → ${item.href}` : ''
  return `  [${item.index}] ${item.role} "${item.name}"${stateText}${hrefText}`
}

/** How many dropped controls get a ready-made selector line. */
const OMITTED_SELECTOR_HINTS = 8

/** Escape one attribute value for a CSS string literal. */
function cssAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Build a short CSS selector that resolves to exactly this element, or
 * undefined when no short form is unique. Never returns an unverified
 * selector: a wrong handle is worse than none.
 *
 * @param el - the dropped control.
 * @returns a unique selector, or undefined.
 */
export function uniqueSelector(el: Element): string | undefined {
  const doc = el.ownerDocument
  const unique = (selector: string): boolean => {
    try {
      return doc.querySelectorAll(selector).length === 1
    } catch {
      return false
    }
  }
  // `localName` keeps SVG's case-sensitive tag names (`clipPath`, `foreignObject`)
  // usable in a selector; `tagName` is upper-cased for HTML but not for SVG.
  const tag = el.localName
  const id = el.getAttribute('id')
  if (id !== null && id.trim() !== '') {
    const candidate = `#${cssEscape(id.trim())}`
    if (unique(candidate)) return candidate
  }
  // Read the class attribute rather than `className`: on SVG elements that
  // property is an SVGAnimatedString, so the string check would drop every
  // class and leave the model without a handle for SVG controls.
  const classes = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter((name) => name !== '')
  const candidates: string[] = []
  if (classes.length > 0) candidates.push(`${tag}.${classes.slice(0, 3).map(cssEscape).join('.')}`)
  for (const name of classes) candidates.push(`${tag}.${cssEscape(name)}`)
  for (const attribute of ['name', 'href', 'data-id', 'type', 'value']) {
    const value = el.getAttribute(attribute)
    if (value !== null && value !== '') candidates.push(`${tag}[${attribute}="${cssAttributeValue(value)}"]`)
  }
  candidates.push(tag)
  for (const candidate of candidates) {
    if (unique(candidate)) return candidate
    const parent = el.parentElement
    if (parent === null || !el.matches(candidate)) continue
    const sameTag = [...parent.children].filter((sibling) => sibling.tagName === el.tagName)
    const position = sameTag.indexOf(el) + 1
    const scoped = `${candidate}:nth-of-type(${position})`
    if (unique(scoped)) return scoped
    const parentId = parent.getAttribute('id')
    if (parentId !== null && parentId.trim() !== '') {
      const nested = `#${cssEscape(parentId.trim())} > ${scoped}`
      if (unique(nested)) return nested
    }
  }
  return undefined
}


/** Whether two chrome entries would render identically. */
function sameChromeItem(current: InventoryItem, previous: InventoryItem): boolean {
  return current.index === previous.index
    && current.role === previous.role
    && current.name === previous.name
    && current.disabled === previous.disabled
    && current.checked === previous.checked
    && current.selected === previous.selected
    && current.href === previous.href
}

function renderForm(form: FormFieldView, includeIdentity: boolean): string {
  const identity = includeIdentity ? `${form.label} (${form.kind}) ` : ''
  const state = form.checked === undefined
    ? `value="${form.masked ? '••••' : form.value}"`
    : `checked=${String(form.checked)}`
  return `  [${form.index}] ${identity}${state}${form.required === true ? ' required' : ''}`
}

function appendTruncationNotes(lines: string[], view: SnapshotView): void {
  const notes: string[] = []
  if (view.truncated.mainChars > 0) notes.push(`Main content truncated by ${view.truncated.mainChars} characters`)
  if (view.truncated.itemsDropped > 0) notes.push(`${view.truncated.itemsDropped} additional elements omitted`)
  if (view.truncated.formsDropped > 0) notes.push(`${view.truncated.formsDropped} additional form fields omitted`)
  if (notes.length > 0) {
    const advice = view.truncated.itemsDropped > 0
      ? `The inventory is capped at ${view.itemCap} numbered items for this frame; dropped controls are listed with selectors below and can be clicked directly. Use browser_get_text or a region for more text.`
      : 'Use browser_get_text or specify region for more content.'
    lines.push(`\n(${notes.join('; ')}. ${advice})`)
  }
}

export function renderSnapshot(view: SnapshotView, delta: boolean, maxChars: number = view.budgetChars): string {
  const lines: string[] = []
  if (delta) {
    lines.push(`Page change v${view.version} (${view.url})`)
    const elementChanges = view.changed.filter((id) => id !== -1)
    const changedIds = new Set(elementChanges)
    const changedItems = view.items.filter((item) => changedIds.has(item.index))
    const changedForms = view.forms.filter((form) => changedIds.has(form.index))

    lines.push(`Status: ${view.ready}${view.reindexed ? ' (element indices were reassigned; use the indices in this snapshot)' : ''}`)
    if (view.changed.includes(-1)) {
      lines.push(`Title: ${view.title || '(untitled)'}`)
      if (view.main.length > 0) {
        lines.push('')
        lines.push('Changed main content:')
        lines.push(view.main)
      }
    }
    if (changedItems.length > 0) {
      lines.push('')
      lines.push('Changed interactive elements:')
      for (const item of changedItems) lines.push(renderItem(item))
    }
    if (changedForms.length > 0) {
      lines.push('')
      lines.push('Changed form fields:')
      const renderedItems = new Set(changedItems.map((item) => item.index))
      for (const form of changedForms) lines.push(renderForm(form, !renderedItems.has(form.index)))
    }
    if (view.removed.length > 0) lines.push(`Removed elements: ${view.removed.join(', ')}`)
    if (view.changed.length === 0 && view.removed.length === 0) lines.push('(No visible changes.)')
    appendTruncationNotes(lines, view)
    return capRendered(lines.join('\n'), maxChars)
  }
  lines.push(`Title: ${view.title || '(untitled)'}`)
  lines.push(`URL: ${view.url}`)
  lines.push(`Status: ${view.ready}${view.reindexed ? ' (element indices were reassigned; use the indices in this snapshot)' : ''}`)
  if (view.main.length > 0) {
    lines.push('')
    lines.push('Main content:')
    lines.push(view.main)
  }
  const collapsed = view.collapsedChrome
  // Collapsed chrome keeps its indices; only the text is withheld.
  const renderedItems = collapsed === undefined
    ? view.items
    : view.items.filter((item) => item.chrome !== true)
  if (renderedItems.length > 0 || collapsed !== undefined) {
    lines.push('')
    lines.push(collapsed === undefined
      ? 'Interactive elements:'
      : `Interactive elements (${collapsed.count} unchanged nav/header/footer items from snapshot v${collapsed.sinceVersion} are omitted; their indices still work and browser_dom_query returns their selectors):`)
    for (const item of renderedItems) lines.push(renderItem(item))
  }
  if (view.omitted.length > 0) {
    lines.push('')
    lines.push('Omitted by the inventory cap (click them by selector):')
    for (const entry of view.omitted) lines.push(`  ${entry.name} — selector: ${entry.selector}`)
  }
  if (view.forms.length > 0) {
    lines.push('')
    lines.push('Form fields:')
    const renderedItems = new Set(view.items.map((item) => item.index))
    for (const form of view.forms) {
      lines.push(renderForm(form, !renderedItems.has(form.index)))
    }
  }
  appendTruncationNotes(lines, view)
  return capRendered(lines.join('\n'), maxChars)
}
