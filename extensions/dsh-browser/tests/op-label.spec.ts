// @vitest-environment jsdom
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

  it('trims a long expression so the row stays readable', () => {
    const label = opLabel(op({
      name: 'browser_eval',
      args: { expression: "Array.from(document.querySelectorAll('a,input,button')).slice(0,60).map((e,i)=>e.tagName)" },
    }), copy)

    expect(label.startsWith('Run JS Array.from(')).toBe(true)
    expect(label.length).toBeLessThanOrEqual('Run JS '.length + 48)
  })

  it('keeps the tool name for anything it cannot describe', () => {
    expect(opLabel(op({ name: 'google_drive_export', args: {} }), copy)).toBe('google_drive_export')
  })
})
