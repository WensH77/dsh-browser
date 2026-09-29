// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 8_000 }

function rect(): DOMRect {
  return {
    top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(rect)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

/** Actions settle on real timers; pump the fake clock while they run. */
async function settle<T>(pending: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(500)
  return pending
}

function context(): { ids: ElementIds; budget: typeof BUDGET } {
  return { ids: new ElementIds(), budget: BUDGET }
}

/** The same shape the reported page had: a placeholder first, real values after. */
function methodSelect(): HTMLSelectElement {
  document.body.innerHTML = `
    <select id="method" name="method">
      <option value="">...</option>
      <option value="PHONE">Phone</option>
      <option value="EMAIL">E-mail</option>
      <option value="FAX" disabled>Fax</option>
    </select>`
  return document.querySelector('#method') as HTMLSelectElement
}

describe('choosing an option in a native <select>', () => {
  it('refuses a bare click instead of reporting one that changed nothing', async () => {
    // A synthetic click cannot open a native popup, so the old behaviour said
    // "Clicked" while the select kept its placeholder value.
    const select = methodSelect()
    await expect(runAction('browser_click', { selector: '#method' }, context())).rejects.toThrow(/native <select>/)
    expect(select.value).toBe('')
  })

  it('chooses by the visible text and dispatches what a real pick dispatches', async () => {
    const select = methodSelect()
    const events: string[] = []
    select.addEventListener('input', () => events.push('input'))
    select.addEventListener('change', () => events.push('change'))

    const result = await settle(runAction('browser_click', { selector: '#method', option: 'Phone' }, context()))

    expect(select.value).toBe('PHONE')
    expect(events).toEqual(['input', 'change'])
    expect(result.text).toContain('Chose option "Phone" in selector "#method"')
  })

  it('chooses by the value, and matches case-insensitively after an exact pass', async () => {
    const select = methodSelect()
    await settle(runAction('browser_click', { selector: '#method', option: 'EMAIL' }, context()))
    expect(select.value).toBe('EMAIL')

    await settle(runAction('browser_click', { selector: '#method', option: 'e-mail' }, context()))
    expect(select.value).toBe('EMAIL')
  })

  it('refuses an option that names nothing, and its disabled options', async () => {
    methodSelect()
    await expect(runAction('browser_click', { selector: '#method', option: 'Carrier pigeon' }, context()))
      .rejects.toThrow(/matches "Carrier pigeon"/)
    await expect(runAction('browser_click', { selector: '#method', option: 'Fax' }, context()))
      .rejects.toThrow(/matches "Fax"/)
  })

  it('refuses option on anything that is not a select', async () => {
    document.body.innerHTML = '<button id="go">Go</button>'
    await expect(runAction('browser_click', { selector: '#go', option: 'Phone' }, context())).rejects.toThrow(/is a <button>/)
  })

  it('refuses a disabled select', async () => {
    document.body.innerHTML = '<select id="state" disabled><option value="A">A</option></select>'
    await expect(runAction('browser_click', { selector: '#state', option: 'A' }, context())).rejects.toThrow(/disabled <select>/)
  })

  it('refuses a multiple select rather than half-choosing', async () => {
    document.body.innerHTML = '<select id="many" multiple><option value="A">A</option><option value="B">B</option></select>'
    await expect(runAction('browser_click', { selector: '#many', option: 'B' }, context())).rejects.toThrow(/multiple <select>/)
  })

  it('reports the options a select offers, marking the chosen one', async () => {
    const select = methodSelect()
    select.value = 'PHONE'

    const result = await settle(runAction('browser_dom_query', { selector: '#method', fields: ['options'] }, context()))

    // dom-query values are quoted, so the inner quotes arrive escaped.
    expect(result.text).toContain('*Phone (value \\"PHONE\\")')
    expect(result.text).toContain('... (value \\"\\")')
    expect(result.text).toContain('Fax (value \\"FAX\\", disabled)')
  })
})
