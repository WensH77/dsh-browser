// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { opLabel, type OpCopy } from '../src/panel/op-label.ts'
import type { RecentOp } from '../src/shared/messages.ts'

const copy: OpCopy = {
  opNavigate: 'Navigate to', opClick: 'Click', opType: 'Type', opPress: 'Press', opScroll: 'Scroll',
  opWait: 'Wait', opSnapshot: 'Read page', opGetText: 'Read text', opBack: 'Back', opForward: 'Forward',
  opReload: 'Reload', opListTabs: 'List tabs', opBindTab: 'Bind tab', opEval: 'Run JS', opBlock: 'Block',
  opHeaders: 'Headers', opCapture: 'Capture', opConsole: 'Console', opNetwork: 'Network',
  opDialog: 'Answer dialog', opChars: ' chars', opElement: 'element',
}

const op = (patch: Partial<RecentOp> & Pick<RecentOp, 'name'>): RecentOp => ({
  id: 'op-1',
  args: {},
  state: 'done',
  startedAt: 0,
  ...patch,
})

describe('opLabel', () => {
  it('names a navigation by host, not by the whole URL', () => {
    expect(opLabel(op({
      name: 'browser_navigate',
      args: { url: 'https://d15a.intranet.test15.tbeng.pro/experts/display.php?id=5740719&tab=calls' },
    }), copy)).toBe('Navigate to d15a.intranet.test15.tbeng.pro')
  })

  it('prefers the element the page resolved over the raw index', () => {
    expect(opLabel(op({ name: 'browser_click', args: { index: 12 }, label: 'Email Specialists' }), copy))
      .toBe('Click Email Specialists')
    expect(opLabel(op({ name: 'browser_click', args: { index: 12 } }), copy)).toBe('Click [12]')
  })

  it('falls back to the selector when nothing was resolved', () => {
    expect(opLabel(op({ name: 'browser_click', args: { selector: 'i.icon-specialist-email' } }), copy))
      .toBe('Click i.icon-specialist-email')
  })

  it('shows how much was typed and where', () => {
    expect(opLabel(op({ name: 'browser_type', args: { index: 7, text: 'SchmigTest' }, label: 'surname' }), copy))
      .toBe('Type 10 chars → surname')
    expect(opLabel(op({ name: 'browser_type', args: { selector: '#surname', text: 'abc' } }), copy))
      .toBe('Type 3 chars → #surname')
  })

  it('leaves the expression to the code line, not the one-line label', () => {
    // The expression used to be trimmed onto the label, where it became an
    // unreadable fragment; the panel now prints it on its own wrapping line.
    const label = opLabel(op({
      name: 'browser_eval',
      args: { expression: "Array.from(document.querySelectorAll('a,input,button')).slice(0,60).map((e,i)=>e.tagName)" },
    }), copy)

    expect(label).toBe('Run JS')
  })

  it('names the filter on a network read, so entries are distinguishable', () => {
    expect(opLabel(op({ name: 'browser_network', args: {} }), copy)).toBe('Network')
    expect(opLabel(op({ name: 'browser_network', args: { url: 'api.example.com/usage' } }), copy))
      .toBe('Network api.example.com/usage')
    expect(opLabel(op({ name: 'browser_network', args: { requestId: '1234567' } }), copy)).toContain('1234567')
  })

  it('names what a text read was looking for', () => {
    expect(opLabel(op({ name: 'browser_get_text', args: {} }), copy)).toBe('Read text')
    expect(opLabel(op({ name: 'browser_get_text', args: { find: 'total' } }), copy)).toBe('Read text "total"')
  })

  it('keeps the tool name for anything it cannot describe', () => {
    expect(opLabel(op({ name: 'google_drive_export', args: {} }), copy)).toBe('google_drive_export')
  })
})

describe('panel layout contract', () => {
  // A flex item defaults to `min-height: auto`, so a scrollable body without an
  // explicit `min-height: 0` refuses to shrink below its content. The panel then
  // grew past its container and the thing that scrolled was the whole panel --
  // the header and the newest operations slid out of reach instead of scrolling
  // under a fixed header. The side panel is a viewport of its own, so `100vh`
  // was never the panel's box either.
  it('keeps the header fixed and scrolls only the body', async () => {
    const raw = await readFile(resolve(import.meta.dirname, '../src/panel/styles.css'), 'utf8')
    // Strip comments first: they explain the fix and would otherwise satisfy (or
    // break) these assertions on their own.
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = (selector: string): string => {
      const at = css.indexOf(`${selector} {`)
      expect(at, `${selector} exists`).toBeGreaterThanOrEqual(0)
      return css.slice(at, css.indexOf('}', at))
    }

    const panel = rule('.panel')
    expect(panel).toContain('height: 100%')
    expect(panel).not.toContain('100vh')
    expect(rule('.panel__body')).toContain('min-height: 0')
    expect(rule('.panel__body')).toContain('overflow: auto')
  })

  it('keeps a pending approval on screen instead of letting the feed push it away', async () => {
    // The prompt is the one thing the user must act on, and the feed above it can
    // be arbitrarily long. As a flow element it scrolled away and the call then
    // failed on its own timeout with nothing visible to click. Sticky, with an
    // opaque background, is what keeps it at the top of the scrolled feed.
    const raw = await readFile(resolve(import.meta.dirname, '../src/panel/styles.css'), 'utf8')
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    const at = css.indexOf('.approvals {')
    expect(at, '.approvals exists').toBeGreaterThanOrEqual(0)
    const rule = css.slice(at, css.indexOf('}', at))
    expect(rule).toContain('position: sticky')
    expect(rule).toContain('top: 0')
    expect(rule).toContain('z-index')
    expect(rule).toContain('background:')
  })

  it('lists the newest operation first', async () => {
    // The store keeps the newest at index 0. The panel used to `reverse()` it,
    // which put the newest at the BOTTOM: with a long feed, the entry that just
    // happened was the one you could not see without scrolling.
    const source = await readFile(resolve(import.meta.dirname, '../src/panel/App.tsx'), 'utf8')
    expect(source).toContain('slice(0, 15).map(')
    expect(source).not.toContain('slice(0, 15).reverse()')
  })

  it('gives a ran expression its own wrapping line', async () => {
    const raw = await readFile(resolve(import.meta.dirname, '../src/panel/styles.css'), 'utf8')
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    const at = css.indexOf('.ops__code {')
    expect(at, '.ops__code exists').toBeGreaterThanOrEqual(0)
    const rule = css.slice(at, css.indexOf('}', at))
    expect(rule).toContain('display: block')
    expect(rule).toContain('white-space: pre-wrap')
  })
})

describe('operation labels are self-explanatory', () => {
  // The feed is the only place a user sees what the agent is doing, and it shows
  // the label with no other context. A bare noun ("Network") left users asking
  // what it meant; every label has to say what happened to what.
  /** Read one `op*` string out of a copy block in App.tsx. */
  async function label(key: string, block: 'zh' | 'en'): Promise<string> {
    const source = await readFile(resolve(import.meta.dirname, '../src/panel/App.tsx'), 'utf8')
    const from = source.indexOf(`const ${block} = {`)
    const body = source.slice(from, source.indexOf('\n}', from))
    const found = [...body.matchAll(new RegExp(`${key}: '([^']*)'`, 'g'))]
    expect(found, `${block}.${key}`).toHaveLength(1)
    return found[0]![1]!
  }

  it('describes the action instead of naming a thing', async () => {
    for (const key of ['opNetwork', 'opConsole', 'opHeaders', 'opBlock', 'opCapture', 'opSnapshot']) {
      // Multi-word in both locales: a lone noun is what confused the user.
      expect((await label(key, 'zh')).length, `zh ${key}`).toBeGreaterThanOrEqual(4)
      expect((await label(key, 'en')).split(' ').length, `en ${key}`).toBeGreaterThanOrEqual(2)
    }
    expect(await label('opNetwork', 'zh')).toContain('网络请求')
    expect(await label('opNetwork', 'en')).toContain('network requests')
  })
})
