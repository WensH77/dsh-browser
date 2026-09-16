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

describe('browser_dom_query', () => {
  it('reports tag, name and an actionable selector per match', async () => {
    document.body.innerHTML = [
      '<main>',
      '<i class="icon-specialist-email" role="button" title="Email Specialists"></i>',
      '<a class="name" href="/experts/162979">Jeffry Mesich</a>',
      '</main>',
    ].join('')

    const icons = await runAction('browser_dom_query', { selector: 'i.icon-specialist-email' }, context())
    expect(icons.text).toContain('1 match(es)')
    expect(icons.text).toContain('i name="Email Specialists"')
    expect(icons.text).toContain('selector="i.icon-specialist-email"')

    const links = await runAction('browser_dom_query', { selector: 'a.name', fields: ['href'] }, context())
    expect(links.text).toContain('a name="Jeffry Mesich"')
    expect(links.text).toContain('href="/experts/162979"')
  })

  it('reports an image alt attribute, which identifies the picture', async () => {
    document.body.innerHTML = '<img src="/chart.png" alt="Member token usage">'

    const answer = await runAction('browser_dom_query', { selector: 'img', fields: ['alt', 'src'] }, context())

    expect(answer.text).toContain('alt="Member token usage"')
    expect(answer.text).toContain('src="/chart.png"')
  })

  it('returns only the fields asked for, and only what exists', async () => {
    document.body.innerHTML = '<input name="surname" type="text" value="Schmig">'

    const answer = await runAction('browser_dom_query', {
      selector: 'input[name=surname]',
      fields: ['value', 'type', 'checked', 'href'],
    }, context())

    expect(answer.text).toContain('value="Schmig"')
    // A selector containing quotes is escaped, not nested.
    expect(answer.text).toContain('selector="input[name=\\"surname\\"]"')
    expect(answer.text).toContain('type="text"')
    expect(answer.text).not.toContain('href=')
    // An unchecked checkbox field is meaningful; a missing one is omitted.
    expect(answer.text).not.toContain('checked=')
  })

  it('answers an empty match instead of failing', async () => {
    document.body.innerHTML = '<main>empty</main>'

    const answer = await runAction('browser_dom_query', { selector: '#nope' }, context())

    expect(answer.text).toBe('dom query: 0 matches for "#nope" in this frame.')
  })

  it('caps the number of matches and says so', async () => {
    document.body.innerHTML = `<main>${Array.from({ length: 5 }, (_, i) => `<button>B${i}</button>`).join('')}</main>`

    const answer = await runAction('browser_dom_query', { selector: 'button', limit: 2 }, context())

    expect(answer.text).toContain('5 match(es)')
    expect(answer.text).toContain('[2]')
    expect(answer.text).not.toContain('[3]')
    expect(answer.text).toContain('3 further match(es) not shown')
  })

  it('rejects a bad selector, a bad field list, and a bad field name', async () => {
    document.body.innerHTML = '<main>x</main>'

    await expect(runAction('browser_dom_query', { selector: '' }, context())).rejects.toThrow(/selector must not be empty/)
    await expect(runAction('browser_dom_query', { selector: ':::' }, context())).rejects.toThrow(/not valid CSS/)
    await expect(runAction('browser_dom_query', { selector: 'main', fields: 'href' }, context()))
      .rejects.toThrow(/fields must be an array/)
    await expect(runAction('browser_dom_query', { selector: 'main', fields: ['nope'] }, context()))
      .rejects.toThrow(/Unknown field\(s\): nope/)
  })
})
