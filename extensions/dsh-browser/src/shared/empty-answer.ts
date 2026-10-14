/**
 * The reads that answer successfully with nothing found.
 *
 * `browser_dom_query` on a selector that matches no element, and
 * `browser_get_text` against a selector or a `find` phrase that is absent, all
 * answer `ok: true`: the model asked a question and "nothing" is the truthful
 * answer. The operation feed renders them exactly like a read that came back
 * with content — same green dot, same `done` — so the one fact worth noticing
 * is the one thing the feed does not say.
 *
 * The three sentences live here, once. The content script composes its answers
 * from these builders and {@link isEmptyAnswer} recognizes exactly the shapes
 * they produce, so rewording a sentence is a change here instead of a silent
 * end to the marking.
 *
 * Nothing in this module is model-facing: it labels the operation feed only.
 *
 * @module
 */

import { unwrapUntrustedContent } from '../security/untrusted.ts'

/** Opening of `browser_dom_query`'s zero-match answer, before the selector. */
export const DOM_QUERY_MISS_HEAD = 'dom query: 0 matches for "'
/** Closing of `browser_dom_query`'s zero-match answer, after the selector. */
export const DOM_QUERY_MISS_TAIL = '" in this frame.'

/** Whole answer of `browser_get_text` when its selector matched no element. */
export const GET_TEXT_NO_ELEMENT_HEAD = 'No element matched selector: '

/** Opening of `browser_get_text`'s failed `find`, before the phrase. */
export const TEXT_SEARCH_MISS_HEAD = 'text search: no match for "'
/** Between the phrase and the scope the search covered. */
export const TEXT_SEARCH_MISS_MID = '" in '
/** Between the scope and the number of characters searched. */
export const TEXT_SEARCH_MISS_COUNT_HEAD = ' (case-insensitive, '
/** Closing, after the number of characters searched. */
export const TEXT_SEARCH_MISS_TAIL = ' characters searched).'

/** Scope label of a search that covered the whole page. */
export const TEXT_SEARCH_SCOPE_WHOLE_PAGE = 'the whole page'

/**
 * Scope label of a search confined to one selector.
 *
 * @param selector - the call's own selector, exactly as it arrived.
 * @returns the label the answer prints for that scope.
 */
export function selectorScope(selector: string): string {
  return `selector "${selector}"`
}

/**
 * The answer `browser_dom_query` gives when nothing matches.
 *
 * @param selector - the trimmed selector the call asked for.
 * @returns the answer text.
 */
export function domQueryMissAnswer(selector: string): string {
  return `${DOM_QUERY_MISS_HEAD}${selector}${DOM_QUERY_MISS_TAIL}`
}

/**
 * The answer `browser_get_text` gives when its selector matched no element.
 *
 * @param selector - the selector the call asked for, exactly as it arrived.
 * @returns the answer text.
 */
export function getTextNoElementAnswer(selector: string): string {
  return `${GET_TEXT_NO_ELEMENT_HEAD}${selector}`
}

/**
 * The answer `browser_get_text` gives when its `find` phrase is absent.
 *
 * @param needle - the trimmed phrase that was searched for.
 * @param scope - the label {@link selectorScope} or
 *   {@link TEXT_SEARCH_SCOPE_WHOLE_PAGE} produced.
 * @param searchedChars - how many characters the search covered.
 * @returns the answer text.
 */
export function textSearchMissAnswer(needle: string, scope: string, searchedChars: number): string {
  return `${TEXT_SEARCH_MISS_HEAD}${needle}${TEXT_SEARCH_MISS_MID}${scope}${TEXT_SEARCH_MISS_COUNT_HEAD}${searchedChars}${TEXT_SEARCH_MISS_TAIL}`
}

/** The tools whose answers {@link isEmptyAnswer} is allowed to judge. */
const EMPTY_ANSWER_TOOLS = new Set(['browser_dom_query', 'browser_get_text'])

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? args[key] as string : ''
}

/**
 * Pull the answer text out of whatever the caller has in hand.
 *
 * Accepts the model-facing result (`{ text }`), a bare string, or a whole tool
 * answer — in which case a refused call answers nothing, whatever it carries:
 * "found nothing" is a statement only a successful read may make.
 */
function answerText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { ok?: unknown; result?: unknown; text?: unknown }
  if (typeof record.ok === 'boolean') return record.ok ? answerText(record.result) : undefined
  return typeof record.text === 'string' ? record.text : undefined
}

/**
 * The first paragraph of an answer.
 *
 * The content script attaches the tab's own state to every successful result after a blank
 * line (`withTabState` in `content/index.ts`), so the sentence a miss is recognized by is the
 * **first** paragraph, not the whole text. Comparing the whole text is why the chip did not
 * appear on a real page at all while the unit tests — which fed the bare sentence — stayed
 * green: every real miss answer carried the note behind it.
 */
function firstParagraph(text: string): string {
  // No trimming: the sentence carries the selector exactly as the caller wrote it, padding
  // and all, and `getTextNoElementAnswer` rebuilds it that way.
  return text.split('\n\n', 1)[0] ?? ''
}

/**
 * Whether a successful answer reached the model with nothing in it.
 *
 * The check is deliberately narrow: only the two reads that can miss, only the
 * exact sentences {@link domQueryMissAnswer}, {@link getTextNoElementAnswer}
 * and {@link textSearchMissAnswer} compose, and only inside the trust boundary
 * the answer arrives in. A page that merely talks about a miss, a read that
 * returned content, and every failure all stay unmarked.
 *
 * When `args` carries the call's own selector and `find`, the comparison is
 * exact — including the selector-scoped search label, which is otherwise the
 * one part of the sentence built from a page-independent value.
 *
 * @param name - the tool name from the call.
 * @param result - the answer's result payload (`{ text }`), a bare answer text,
 *   or a whole tool answer.
 * @param args - the call's arguments, which make the check exact.
 * @returns true when this was a successful read that found nothing.
 */
export function isEmptyAnswer(
  name: string,
  result: unknown,
  args: Record<string, unknown> = {},
): boolean {
  if (!EMPTY_ANSWER_TOOLS.has(name)) return false
  const text = answerText(result)
  if (text === undefined) return false
  const body = firstParagraph(unwrapUntrustedContent(text) ?? text)
  return name === 'browser_dom_query' ? isDomQueryMiss(body, args) : isGetTextMiss(body, args)
}

function isDomQueryMiss(body: string, args: Record<string, unknown>): boolean {
  const selector = stringArg(args, 'selector').trim()
  if (selector !== '') return body === domQueryMissAnswer(selector)
  // No arguments to compare against: the sentence's own shape, with a selector
  // somewhere between its head and tail.
  return body.startsWith(DOM_QUERY_MISS_HEAD)
    && body.endsWith(DOM_QUERY_MISS_TAIL)
    && body.length > DOM_QUERY_MISS_HEAD.length + DOM_QUERY_MISS_TAIL.length
}

function isGetTextMiss(body: string, args: Record<string, unknown>): boolean {
  // `browser_get_text` keeps the selector exactly as it arrived; only `find` is
  // trimmed before the search.
  const selector = stringArg(args, 'selector')
  const find = stringArg(args, 'find').trim()
  if (find !== '') {
    const scope = selector === '' ? TEXT_SEARCH_SCOPE_WHOLE_PAGE : selectorScope(selector)
    return isTextSearchMiss(body, find, scope)
  }
  if (selector !== '') return body === getTextNoElementAnswer(selector)
  // No arguments to compare against: accept either sentence's shape.
  if (body.startsWith(GET_TEXT_NO_ELEMENT_HEAD)) return body.length > GET_TEXT_NO_ELEMENT_HEAD.length
  return isTextSearchMiss(body)
}

/**
 * Whether `body` is the failed-search sentence.
 *
 * @param body - the answer text without its trust boundary.
 * @param needle - the phrase the search covered, when the call said.
 * @param scope - the scope label, when the call said.
 * @returns true only for the composed sentence, with a counted character total.
 */
function isTextSearchMiss(body: string, needle?: string, scope?: string): boolean {
  if (!body.startsWith(TEXT_SEARCH_MISS_HEAD) || !body.endsWith(TEXT_SEARCH_MISS_TAIL)) return false
  const inner = body.slice(TEXT_SEARCH_MISS_HEAD.length, body.length - TEXT_SEARCH_MISS_TAIL.length)
  if (needle !== undefined) {
    const head = `${needle}${TEXT_SEARCH_MISS_MID}${scope}${TEXT_SEARCH_MISS_COUNT_HEAD}`
    return inner.startsWith(head) && /^\d+$/.test(inner.slice(head.length))
  }
  // Without the call's own arguments the phrase and the scope are whatever sits
  // between the two labels; the counted total right after the last one is what
  // keeps this from accepting a sentence that merely contains the words.
  const countAt = inner.lastIndexOf(TEXT_SEARCH_MISS_COUNT_HEAD)
  const midAt = inner.indexOf(TEXT_SEARCH_MISS_MID)
  if (midAt <= 0 || countAt <= midAt) return false
  return /^\d+$/.test(inner.slice(countAt + TEXT_SEARCH_MISS_COUNT_HEAD.length))
}
