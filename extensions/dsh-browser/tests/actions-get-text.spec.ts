// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

const budget = { maxItems: 20, maxForms: 10, maxChars: 8_000 }
const context = (): { ids: ElementIds; budget: typeof budget } => ({ ids: new ElementIds(), budget })

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('browser_get_text find', () => {
  /** One slide page: title, body, then filler so windows cannot cover the deck. */
  const page = (title: string, body: string): string => `${title}\n${body}\n${'.'.repeat(260)}`
  const deck = [
    page('1 of 142', 'Reverse Knowledge Transfer'),
    page('2 of 142', 'Agenda'),
    page('10 of 142', 'Connection Business Process\nIn Consultation\nCTM monitor consultation before consultation started'),
    page('11 of 142', 'Log consultation'),
  ].join('\n\n')

  it('returns a window around the phrase instead of the whole text', async () => {
    document.body.innerHTML = `<main>${deck.replace(/\n\n/g, '<br>')}</main>`

    const answer = await runAction('browser_get_text', { find: '10 of 142', context: 220 }, context())

    expect(answer.text).toContain('text search: 1 match(es) for "10 of 142" in the whole page')
    expect(answer.text).toContain('«10 of 142»')
    expect(answer.text).toContain('In Consultation')
    expect(answer.text).toContain('CTM monitor consultation before consultation started')
    // The answer is a window, not the deck.
    expect(answer.text).not.toContain('Log consultation')
    expect(answer.text.length).toBeLessThan(deck.length / 2)
  })

  it('matches case-insensitively and reports every match it found', async () => {
    document.body.innerHTML = '<main>Alpha beta ALPHA Gamma alpha</main>'

    const answer = await runAction('browser_get_text', { find: 'alpha', context: 3 }, context())

    expect(answer.text).toContain('3 match(es)')
    expect(answer.text).toContain('«Alpha»')
    expect(answer.text).toContain('«ALPHA»')
  })

  it('searches the whole text even when maxChars would truncate the read', async () => {
    // The needle sits far past a small maxChars: a read-then-search design
    // would report "no match" here and send the model back to DOM scripting.
    const long = `${'x'.repeat(20_000)}\nslidetarget\n${'y'.repeat(20_000)}`
    document.body.innerHTML = `<main>${long}</main>`

    const answer = await runAction('browser_get_text', { find: 'slidetarget', maxChars: 500 }, context())

    expect(answer.text).toContain('text search: 1 match(es) for "slidetarget"')
    expect(answer.text).toContain('«slidetarget»')
  })

  it('says so, with the searched length, when nothing matches', async () => {
    document.body.innerHTML = '<main>nothing here</main>'

    const answer = await runAction('browser_get_text', { find: 'absent phrase' }, context())

    expect(answer.text).toBe('text search: no match for "absent phrase" in the whole page (case-insensitive, 12 characters searched).')
  })

  it('scopes the search to a selector and keeps the plain read when find is absent', async () => {
    document.body.innerHTML = ['<main>whole page text</main>', '<section class="notes">member only text</section>'].join('')

    const scoped = await runAction('browser_get_text', { selector: 'section.notes', find: 'member' }, context())
    expect(scoped.text).toContain('in selector "section.notes"')
    expect(scoped.text).toContain('«member»')

    const plain = await runAction('browser_get_text', {}, context())
    expect(plain.text).toContain('whole page text')
    expect(plain.text).not.toContain('text search:')
  })

  it('honours a maxChars above the old 8000 hard cap, up to the negotiated budget', async () => {
    // 12k of body text; the host schema advertises 500-32000 with an 8000
    // default, so asking for 12000 used to come back as 8000 with no sign of it.
    document.body.innerHTML = `<main>${'a'.repeat(12_000)}</main>`
    const wideContext = { ids: new ElementIds(), budget: { maxItems: 20, maxForms: 10, maxChars: 32_000 } }

    const wide = await runAction('browser_get_text', { maxChars: 12_000 }, wideContext)
    expect(wide.text.length).toBeGreaterThan(8_000)
    expect(wide.text).not.toContain('Truncated')

    // The negotiated ceiling still bounds it: this context caps at 8000.
    const narrow = await runAction('browser_get_text', { maxChars: 12_000 }, context())
    expect(narrow.text).toContain('Truncated')

    // No maxChars means the negotiated budget, not a fixed 8000.
    const byDefault = await runAction('browser_get_text', {}, wideContext)
    expect(byDefault.text).not.toContain('Truncated')
  })

  it('keeps the reported window within maxChars', async () => {
    document.body.innerHTML = `<main>${'a'.repeat(3_000)}needle${'b'.repeat(3_000)}</main>`

    const answer = await runAction('browser_get_text', { find: 'needle', context: 2_000, maxChars: 600 }, context())

    expect(answer.text).toContain('«needle»')
    expect(answer.text).toContain('Truncated')
    expect(answer.text.length).toBeLessThan(800)
  })
})
