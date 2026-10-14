// @vitest-environment jsdom
/**
 * The operation feed's "found nothing" mark.
 *
 * These are the reads that answer `ok: true` while carrying no content, so the
 * judgement has to be narrow in both directions: it must recognize all three
 * sentences the content script composes, and it must never mark a read that
 * returned something, a failure, or a different tool.
 *
 * The sentences are spelled out here rather than built from the module's own
 * constants: a reworded constant must fail this file, which is the whole point
 * of keeping one copy of the wording.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { wrapUntrustedContent, wrapUntrustedResult } from '../src/security/untrusted.ts'
import { isEmptyAnswer } from '../src/shared/empty-answer.ts'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('isEmptyAnswer recognizes the three sentences', () => {
  it('marks a dom query that matched no element', () => {
    // The model sees the compact trust boundary, not the bare sentence.
    const text = wrapUntrustedResult('dom query: 0 matches for "#nope" in this frame.', 500)

    expect(isEmptyAnswer('browser_dom_query', { text }, { selector: '#nope' })).toBe(true)
    // The bare action answer is the same fact.
    expect(isEmptyAnswer('browser_dom_query', { text: 'dom query: 0 matches for "#nope" in this frame.' }, { selector: '#nope' })).toBe(true)
  })

  it('marks a get_text selector that matched no element', () => {
    const text = wrapUntrustedContent('No element matched selector: #nope', 32_000)

    expect(isEmptyAnswer('browser_get_text', { text }, { selector: '#nope' })).toBe(true)
  })

  it('marks a whole-page search whose phrase is absent', () => {
    const sentence = 'text search: no match for "absent phrase" in the whole page (case-insensitive, 12 characters searched).'

    expect(isEmptyAnswer('browser_get_text', { text: wrapUntrustedContent(sentence, 32_000) }, { find: 'absent phrase' })).toBe(true)
  })

  it('marks a selector-scoped search whose phrase is absent', () => {
    const sentence = 'text search: no match for "kw" in selector "section.notes" (case-insensitive, 33 characters searched).'

    expect(isEmptyAnswer('browser_get_text', { text: sentence }, { selector: 'section.notes', find: 'kw' })).toBe(true)
  })

  it('marks the three sentences when the answer carries the tab-state note', () => {
    // Every real answer does. The content script appends the tab's own state after a blank
    // line (`withTabState` in `content/index.ts`), so what the background holds is
    // `sentence\n\n<note>` inside the trust boundary. Judging the whole text against the
    // sentence is why the chip never appeared on a real page while these tests stayed green.
    const note = 'The controlled tab is hidden and its window does not hold system focus. No focus events reach it in this state and clipboard writes are refused, so a step that depends on either can do nothing silently.'
    const withNote = (sentence: string): string => wrapUntrustedContent(`${sentence}\n\n${note}`, 32_000)

    expect(isEmptyAnswer('browser_get_text', { text: withNote('No element matched selector: #nope') }, { selector: '#nope' })).toBe(true)
    expect(isEmptyAnswer('browser_dom_query', { text: wrapUntrustedResult(`dom query: 0 matches for "#nope" in this frame.\n\n${note}`, 500) }, { selector: '#nope' })).toBe(true)
    expect(isEmptyAnswer(
      'browser_get_text',
      { text: withNote('text search: no match for "kw" in selector "section.notes" (case-insensitive, 33 characters searched).') },
      { selector: 'section.notes', find: 'kw' },
    )).toBe(true)
  })
})

describe('isEmptyAnswer leaves everything else alone', () => {
  it('does not mark a read that returned content', () => {
    expect(isEmptyAnswer('browser_get_text', { text: wrapUntrustedContent('Orders\nTotal 12', 32_000) }, {})).toBe(false)
    expect(isEmptyAnswer('browser_dom_query', { text: wrapUntrustedResult('button name=Save selector=#save', 500) }, { selector: '#save' })).toBe(false)
  })

  it('does not mark a failure, whatever it carries', () => {
    const refusal = { ok: false, error: { code: 'action-failed', message: 'Page content sharing is disabled.' } }

    expect(isEmptyAnswer('browser_get_text', refusal, { selector: '#nope' })).toBe(false)
    expect(isEmptyAnswer('browser_get_text', undefined, { selector: '#nope' })).toBe(false)
    expect(isEmptyAnswer('browser_dom_query', { ok: false, result: { text: 'dom query: 0 matches for "#nope" in this frame.' } }, { selector: '#nope' })).toBe(false)
  })

  it('does not mark any other tool', () => {
    const sentence = 'dom query: 0 matches for "#nope" in this frame.'

    for (const name of ['browser_snapshot', 'browser_click', 'browser_console', 'browser_image', 'browser_get_text ']) {
      expect(isEmptyAnswer(name, { text: sentence }, { selector: '#nope' }), name).toBe(false)
    }
  })

  it('does not mark page text that merely mentions a miss', () => {
    const page = wrapUntrustedContent('Notes:\nNo element matched selector: #nope\n(end)', 32_000)

    expect(isEmptyAnswer('browser_get_text', { text: page }, {})).toBe(false)
    expect(isEmptyAnswer('browser_get_text', { text: page }, { selector: '#other' })).toBe(false)
  })

  it('does not mark an answer whose call does not agree with it', () => {
    const domMiss = wrapUntrustedResult('dom query: 0 matches for "#nope" in this frame.', 500)
    const textMiss = wrapUntrustedContent('text search: no match for "kw" in the whole page (case-insensitive, 4 characters searched).', 32_000)

    expect(isEmptyAnswer('browser_dom_query', { text: domMiss }, { selector: '#other' })).toBe(false)
    expect(isEmptyAnswer('browser_get_text', { text: textMiss }, { find: 'another phrase' })).toBe(false)
    expect(isEmptyAnswer('browser_get_text', { text: textMiss }, { selector: 'main', find: 'kw' })).toBe(false)
  })

  it('judges on shape alone when the call arguments are not handed over', () => {
    // The background always passes them; a two-argument caller still gets a
    // specific answer rather than a silent "no".
    expect(isEmptyAnswer('browser_dom_query', { text: 'dom query: 0 matches for "anything[href=\'x\']" in this frame.' })).toBe(true)
    expect(isEmptyAnswer('browser_get_text', { text: 'No element matched selector: whatever' })).toBe(true)
    expect(isEmptyAnswer('browser_get_text', { text: 'dom query: 0 matches for "x" in this frame.' })).toBe(false)
    expect(isEmptyAnswer('browser_get_text', { text: 'text search: no match for "x" in the whole page (case-insensitive, 3 searched).' })).toBe(false)
  })
})

describe('the content script composes exactly the sentences the mark recognizes', () => {
  const context = (): { ids: ElementIds; budget: { maxItems: number; maxForms: number; maxChars: number } } =>
    ({ ids: new ElementIds(), budget: { maxItems: 20, maxForms: 10, maxChars: 8_000 } })

  it('recognizes what browser_dom_query actually answers', async () => {
    document.body.innerHTML = '<main><a href="/x">one</a></main>'

    const answer = await runAction('browser_dom_query', { selector: '#nope' }, context())

    expect(answer.text).toBe('dom query: 0 matches for "#nope" in this frame.')
    const modelFacing = wrapUntrustedResult(answer.text, 500)
    expect(isEmptyAnswer('browser_dom_query', { text: modelFacing }, { selector: '#nope' })).toBe(true)
  })

  it('recognizes what browser_get_text actually answers', async () => {
    document.body.innerHTML = '<main>nothing here</main>'

    const missing = await runAction('browser_get_text', { selector: '#nope' }, context())
    expect(missing.text).toBe('No element matched selector: #nope')
    expect(isEmptyAnswer('browser_get_text', { text: wrapUntrustedContent(missing.text, 32_000) }, { selector: '#nope' })).toBe(true)

    const searched = await runAction('browser_get_text', { find: 'absent phrase' }, context())
    expect(searched.text).toBe('text search: no match for "absent phrase" in the whole page (case-insensitive, 12 characters searched).')
    expect(isEmptyAnswer('browser_get_text', { text: wrapUntrustedContent(searched.text, 32_000) }, { find: 'absent phrase' })).toBe(true)
  })

  it('mirrors each tool\'s own selector handling, padding and all', async () => {
    document.body.innerHTML = '<main>nothing here</main>'
    const padded = { selector: '  #nope  ' }

    // `browser_dom_query` trims the selector before it reports it; a comparison
    // that assumed otherwise would stop marking padded selectors.
    const query = await runAction('browser_dom_query', padded, context())
    expect(query.text).toBe('dom query: 0 matches for "#nope" in this frame.')
    expect(isEmptyAnswer('browser_dom_query', { text: wrapUntrustedResult(query.text, 500) }, padded)).toBe(true)

    // `browser_get_text` does not trim, and its answer keeps the padding.
    const read = await runAction('browser_get_text', padded, context())
    expect(read.text).toBe('No element matched selector:   #nope  ')
    expect(isEmptyAnswer('browser_get_text', { text: wrapUntrustedContent(read.text, 32_000) }, padded)).toBe(true)
  })

  it('does not mark what the same tool answers when it found something', async () => {
    document.body.innerHTML = '<main><p id="hit">member only text</p></main>'

    const found = await runAction('browser_get_text', { selector: '#hit', find: 'member' }, context())
    expect(found.text).toContain('text search: 1 match(es)')
    expect(isEmptyAnswer('browser_get_text', { text: wrapUntrustedContent(found.text, 32_000) }, { selector: '#hit', find: 'member' })).toBe(false)

    const queried = await runAction('browser_dom_query', { selector: '#hit' }, context())
    expect(isEmptyAnswer('browser_dom_query', { text: wrapUntrustedResult(queried.text, 500) }, { selector: '#hit' })).toBe(false)
  })
})
