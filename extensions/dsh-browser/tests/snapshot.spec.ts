// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ElementIds } from '../src/content/ids.ts'
import { buildSnapshot, renderSnapshot, uniqueSelector, type SnapshotBudget } from '../src/content/snapshot.ts'

const BUDGET: SnapshotBudget = { maxItems: 10, maxForms: 5, maxChars: 4_000 }

describe('buildSnapshot', () => {
  it('renders title, url, interactive inventory and masked form values', () => {
    document.body.innerHTML = `
      <h1>示例页</h1>
      <a href="/login">登录</a>
      <button>提交</button>
      <input id="email" type="email" value="user@example.com" />
      <input id="pass" type="password" value="hunter2" />
    `
    document.title = '示例页标题'
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: BUDGET }, null)
    expect(view.version).toBe(1)
    expect(view.url).toBe('http://localhost:3000/')
    expect(view.items.length).toBeGreaterThanOrEqual(3)
    const text = renderSnapshot(view, false)
    expect(text).toContain('Title: 示例页标题')
    expect(text).toContain('Main content:')
    expect(text).toContain('Interactive elements:')
    expect(text).toContain('Form fields:')
    expect(text).toContain('登录')
    expect(text).toContain('user@example.com')
    expect(text).toContain('value="••••"')
    expect(text).not.toContain('hunter2')
  })

  it('increments versions and keeps element ids stable', () => {
    document.body.innerHTML = '<button>甲</button><button>乙</button>'
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { budget: BUDGET }, null)
    const second = buildSnapshot(ids, { budget: BUDGET }, first)
    expect(second.version).toBe(2)
    const firstItems = new Map(first.items.map((item) => [item.name, item.index]))
    for (const item of second.items) {
      if (firstItems.has(item.name)) expect(item.index).toBe(firstItems.get(item.name))
    }
  })

  it('delta mode reports only changed and removed ids', () => {
    document.body.innerHTML = '<button id="a">甲</button><button id="b">乙</button>'
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { delta: true, budget: BUDGET }, null)
    expect(first.changed).toEqual([])

    const a = document.getElementById('a')!
    const bIndex = ids.indexOf(document.getElementById('b')!)!
    a.textContent = '甲已改名'
    const second = buildSnapshot(ids, { delta: true, budget: BUDGET }, first)
    expect(second.changed).toContain(ids.indexOf(a))
    expect(second.changed).not.toContain(bIndex)
    const secondText = renderSnapshot(second, true)
    expect(secondText).toContain('Changed interactive elements:')
    expect(secondText).toContain('甲已改名')
    expect(secondText).not.toContain('Call browser_snapshot again')

    document.getElementById('b')!.remove()
    const third = buildSnapshot(ids, { delta: true, budget: BUDGET }, second)
    expect(third.removed).toContain(bIndex)
    expect(renderSnapshot(third, true)).toContain('Removed elements:')
  })

  it('renders wrapped checkbox labels and explicit checked state', () => {
    document.body.innerHTML = '<label><input type="checkbox">邮件通知</label>'
    const checkbox = document.querySelector<HTMLInputElement>('input')!
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { budget: BUDGET }, null)
    const firstText = renderSnapshot(first, false)

    expect(firstText).toContain('checkbox "邮件通知" [unchecked]')
    expect(firstText).toContain('checked=false')
    expect(firstText).not.toContain('value="on"')

    checkbox.checked = true
    const second = buildSnapshot(ids, { delta: true, budget: BUDGET }, first)
    const secondText = renderSnapshot(second, true)
    expect(second.changed).toContain(ids.indexOf(checkbox))
    expect(secondText).toContain('checkbox "邮件通知" [checked]')
    expect(secondText).toContain('checked=true')
  })

  it('includes changed main content in delta snapshots', () => {
    document.body.innerHTML = '<main>处理中</main>'
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { budget: BUDGET }, null)
    document.querySelector('main')!.textContent = '结算完成'

    const second = buildSnapshot(ids, { delta: true, budget: BUDGET }, first)
    const text = renderSnapshot(second, true)
    expect(text).toContain('Changed main content:')
    expect(text).toContain('结算完成')
  })

  it('caps inventory by budget and reports drops', () => {
    document.body.innerHTML = Array.from({ length: 25 }, (_, i) => `<button>按钮${i}</button>`).join('')
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: { ...BUDGET, maxItems: 10 }, region: undefined, delta: false }, null)
    expect(view.items.length).toBe(10)
    expect(view.truncated.itemsDropped).toBe(15)
  })

  it('reuses the interactive scan for form fields and reports omitted fields', () => {
    document.body.innerHTML = Array.from({ length: 5 }, (_, i) => `<input aria-label="字段${i}">`).join('')
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect')
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: { ...BUDGET, maxForms: 2 }, delta: false }, null)

    expect(view.forms).toHaveLength(2)
    expect(view.truncated.formsDropped).toBe(3)
    // One visibility and one viewport measurement per interactive element;
    // form extraction performs no second layout pass.
    expect(rect).toHaveBeenCalledTimes(10)
  })

  it('truncates main content at the budget', () => {
    document.body.innerHTML = `<article><p>${'长'.repeat(5_000)}</p></article>`
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: { ...BUDGET, maxChars: 2_000 }, delta: false, region: undefined }, null)
    expect(view.main.length).toBeLessThanOrEqual(1_001)
    expect(view.truncated.mainChars).toBeGreaterThan(3_000)
  })

  it('supports region-scoped snapshots', () => {
    document.body.innerHTML = `
      <div id="sidebar">侧边栏内容</div>
      <div id="content">主体内容区</div>
    `
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { region: '#content', budget: BUDGET }, null)
    expect(view.main).toContain('主体内容区')
    expect(view.main).not.toContain('侧边栏内容')
  })
})

describe('inventory ranking', () => {
  it('keeps content controls when chrome would exhaust the item budget', async () => {
    document.body.innerHTML = [
      '<nav>',
      ...Array.from({ length: 8 }, (_, i) => `<a href="/nav-${i}">Nav ${i}</a>`),
      '</nav>',
      '<main><button>Email Specialists</button></main>',
    ].join('')
    document.querySelectorAll('a').forEach((link) => {
      link.scrollIntoView = () => {}
    })
    const budget = { maxItems: 3, maxForms: 5, maxChars: 8_000 }

    const view = buildSnapshot(new ElementIds(), { delta: false, budget }, null)
    const names = view.items.map((item) => item.name)

    expect(names).toContain('Email Specialists')
  })
})

describe('omitted controls', () => {
  it('lists dropped controls with a selector that actually resolves', () => {
    document.body.innerHTML = [
      '<main>',
      '<button>One</button>',
      '<button>Two</button>',
      '<i class="icon-specialist-email" role="button" title="Email Specialists"></i>',
      '</main>',
    ].join('')
    const ids = new ElementIds()

    const view = buildSnapshot(ids, { budget: { maxItems: 2, maxForms: 5, maxChars: 8_000 } }, null)

    expect(view.truncated.itemsDropped).toBeGreaterThan(0)
    expect(view.omitted.length).toBeGreaterThan(0)
    for (const entry of view.omitted) {
      // Every advertised selector must be unique and resolve to a real element.
      expect(document.querySelectorAll(entry.selector)).toHaveLength(1)
    }
    expect(view.omitted.some((entry) => entry.name === 'Email Specialists')).toBe(true)
  })

  it('says the inventory is capped, and points at selectors rather than only more text', () => {
    document.body.innerHTML = ['<main>', ...Array.from({ length: 4 }, (_, i) => `<button>B${i}</button>`), '</main>'].join('')
    const ids = new ElementIds()
    const budget = { maxItems: 2, maxForms: 5, maxChars: 8_000 }

    const text = renderSnapshot(buildSnapshot(ids, { budget }, null), false, 8_000)

    expect(text).toContain('Omitted by the inventory cap')
    expect(text).toContain('capped at 2 numbered items')
    expect(text).toContain('selector:')
  })
})

describe('uniqueSelector', () => {
  it('addresses SVG controls, whose className is not a string', () => {
    // Slides filmstrip thumbnails are <g> elements: reading `className` as a
    // string drops every class, so no handle could be produced for them.
    document.body.innerHTML = '<svg><g class="thumb"><text>9</text></g><g class="thumb"><text>10</text></g></svg>'
    const second = document.querySelectorAll('g')[1]!

    const selector = uniqueSelector(second)

    expect(selector).toBeDefined()
    expect(document.querySelectorAll(selector!)).toHaveLength(1)
    expect(document.querySelector(selector!)).toBe(second)
  })
})

describe('unchanged chrome', () => {
  const budget = { maxItems: 20, maxForms: 10, maxChars: 8_000 }
  const page = (extraNav: string): string => [
    '<nav>',
    '<a href="/dash">Dashboard</a>',
    '<a href="/experts">Specialists</a>',
    extraNav,
    '</nav>',
    '<main><button>Send profile</button></main>',
  ].join('')

  it('omits chrome that did not change, keeping its indices valid', () => {
    document.body.innerHTML = page('')
    const ids = new ElementIds()

    const first = buildSnapshot(ids, { budget }, null)
    expect(first.collapsedChrome).toBeUndefined()
    const firstText = renderSnapshot(first, false, 8_000)
    expect(firstText).toContain('Dashboard')

    const second = buildSnapshot(ids, { budget }, first)
    expect(second.collapsedChrome).toEqual({ count: 2, sinceVersion: first.version })
    const secondText = renderSnapshot(second, false, 8_000)
    expect(secondText).not.toContain('Dashboard')
    expect(secondText).toContain('2 unchanged nav/header/footer items')
    expect(secondText).toContain('browser_dom_query returns their selectors')
    // Content is still listed in full.
    expect(secondText).toContain('Send profile')
    // Indices are unchanged, so an old index still addresses the same element.
    expect(second.items.find((item) => item.name === 'Dashboard')?.index).toBe(first.items.find((item) => item.name === 'Dashboard')?.index)
  })

  it('sends chrome again as soon as any of it changes', () => {
    document.body.innerHTML = page('')
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { budget }, null)

    document.body.innerHTML = page('<a href="/invoices">Invoices</a>')
    const second = buildSnapshot(ids, { budget }, first)

    expect(second.collapsedChrome).toBeUndefined()
    expect(renderSnapshot(second, false, 8_000)).toContain('Invoices')
  })

  it('never collapses on the first snapshot of a document', () => {
    document.body.innerHTML = page('')
    const ids = new ElementIds()

    const view = buildSnapshot(ids, { budget }, null)

    expect(view.collapsedChrome).toBeUndefined()
    expect(renderSnapshot(view, false, 8_000)).toContain('Interactive elements:')
  })
})
