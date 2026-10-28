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
  opDomQuery: 'Query elements', opClickPointer: 'Press-sequence click', opImage: 'Read image',
  opDebug: 'Debug page', opStatus: 'Check bridge status', opSetup: 'Prepare extension files',
  opUpdate: 'Print update command', opBindInteractive: 'Choose a page to bind', opSlidesPage: 'Open slide',
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

  it('names the page a bind landed on, not just the tab number', () => {
    // The extension resolves the tab it bound and records `42 — https://…`. The id alone told
    // a user nothing: "Bind tab 42" is the same row whichever page 42 happens to be, and the
    // whole point of the row is to show which page the session now operates.
    expect(opLabel(op({
      name: 'browser_bind_tab',
      args: { tabId: 42 },
      label: 'https://app.example/orders',
    }), copy)).toBe('Bind tab https://app.example/orders')
    // A bind recorded before the extension resolved anything still shows what it has.
    expect(opLabel(op({ name: 'browser_bind_tab', args: { tabId: 42 } }), copy)).toBe('Bind tab 42')
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

  it('carries the window height down the whole chain', async () => {
    // `height: 100%` resolves against the parent, so every link has to carry it: html/body,
    // then the React mount point, then `.panel`. `#root` was missing, so the panel collapsed
    // to its content height: the footer sat directly under the feed and the rest of the window
    // stayed empty below it. `.panel { height: 100% }` looked correct the whole time.
    const raw = await readFile(resolve(import.meta.dirname, '../src/panel/styles.css'), 'utf8')
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toContain('html, body { margin: 0; height: 100%; }')
    const at = css.indexOf('#root {')
    expect(at, '#root carries the height').toBeGreaterThanOrEqual(0)
    expect(css.slice(at, css.indexOf('}', at))).toContain('height: 100%')
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
    // The opaque fill has to be its own declaration: `background: rgba(...) var(--bg)`
    // is one colour too many for the shorthand, so it was dropped at computed-value
    // time and the box stayed transparent -- the see-through sticky prompt this test
    // is about. The amber wash rides on `background-image` instead.
    expect(rule).toContain('background-color: var(--bg)')
    expect(rule).toContain('background-image:')
  })

  it('lists the newest operation first, without dropping the oldest', async () => {
    // The store keeps the newest at index 0. The panel used to `reverse()` it,
    // which put the newest at the BOTTOM: with a long feed, the entry that just
    // happened was the one you could not see without scrolling.
    //
    // It then rendered only the newest 15 (`slice(0, 15)`) while the store kept 30, so the
    // earliest operations were not merely below the fold — they were never in the DOM, and
    // no amount of scrolling could reach them. The whole feed is rendered now, and the list
    // takes the height that is left and scrolls inside it (asserted in the next test).
    const source = await readFile(resolve(import.meta.dirname, '../src/panel/App.tsx'), 'utf8')
    expect(source).toContain('{(ui?.recentOps ?? []).map(')
    expect(source).not.toContain('slice(0, 15)')
    expect(source).not.toContain('.reverse()')
  })

  it('gives the operation feed the height that is left, and scrolls inside it', async () => {
    // A fixed `max-height: 42vh` left the bottom half of the panel empty whenever the feed was
    // longer than the cap. The list fills what is left above the status strip instead, and
    // scrolls inside that box; the strip and the footer do not move when it scrolls.
    const raw = await readFile(resolve(import.meta.dirname, '../src/panel/styles.css'), 'utf8')
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = (selector: string): string => {
      const at = css.indexOf(`${selector} {`)
      expect(at, `${selector} exists`).toBeGreaterThanOrEqual(0)
      return css.slice(at, css.indexOf('}', at))
    }

    expect(rule('.ops')).toContain('flex: 1 1 auto')
    expect(rule('.ops')).toContain('min-height: 0')
    const list = rule('.ops__list')
    expect(list).toContain('overflow-y: auto')
    expect(list).toContain('min-height: 0')
    expect(list).not.toContain('max-height')
  })

  it('keeps the operating status out of the scrolling body', async () => {
    // It used to be the last item inside `.panel__body`: a long feed scrolled it out of view,
    // and a short one left it floating under the list with empty space beneath. It is status,
    // so it belongs between the body and the footer, where it always lands in the same place.
    const source = await readFile(resolve(import.meta.dirname, '../src/panel/App.tsx'), 'utf8')
    const bodyEnd = source.indexOf('</main>')
    const status = source.indexOf('className="panel__status"')
    const footer = source.indexOf('className="panel__footer"')
    expect(bodyEnd, 'the body closes').toBeGreaterThanOrEqual(0)
    expect(status, 'the status strip exists').toBeGreaterThan(bodyEnd)
    expect(footer, 'the footer follows it').toBeGreaterThan(status)

    const raw = await readFile(resolve(import.meta.dirname, '../src/panel/styles.css'), 'utf8')
    expect(raw.replace(/\/\*[\s\S]*?\*\//g, '')).toContain('.panel__status {')
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

describe('every tool the bridge can run has a name of its own', () => {
  it('never falls back to the raw tool name, in either language', async () => {
    // The feed printed `browser_dom_query` and `browser_click_pointer` verbatim because the
    // mapping had no case for them: nine of the twenty-seven tools had no name at all, and
    // nothing failed when a tool was added without one. This is that failure, as a test.
    const { en: enCopy, zh: zhCopy } = await import('../src/panel/App.tsx')
    const { BROWSER_TOOL_NAMES, HOST_TOOL_NAMES } = await import('dsh-bridge-browser/src/tools.ts')
    const tools: readonly string[] = [...BROWSER_TOOL_NAMES, ...HOST_TOOL_NAMES, 'browser_bind_interactive']

    for (const name of tools) {
      for (const [locale, localeCopy] of [['zh', zhCopy], ['en', enCopy]] as const) {
        const label = opLabel(op({ name }), localeCopy as OpCopy)
        expect(label, `${name} has a label in ${locale}`).not.toBe(name)
        expect(label.trim(), `${name} label is not empty in ${locale}`).not.toBe('')
      }
    }
  })
})
