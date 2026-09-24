// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { approvalPromptForCall, originFromUrl, setActionTrustPolicy } from '../src/background/authorization.ts'
import type { TabFrame } from '../src/background/frames.ts'
import type { ToolCall } from '../src/background/tools.ts'

const FRAMES: TabFrame[] = [
  { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://app.example/page' },
  { frameId: 4, parentFrameId: 0, documentId: 'child', url: 'https://login.example.net/form' },
  { frameId: 5, parentFrameId: 4, documentId: 'about', url: 'about:blank' },
]

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'call', name, args }
}

describe('approvalPromptForCall', () => {
  it('asks before reading and names every effective frame origin', () => {
    expect(approvalPromptForCall(call('browser_snapshot'), 'ask', FRAMES, 'zh')).toMatchObject({
      kind: 'read',
      origins: ['https://app.example', 'https://login.example.net'],
      canTrust: false,
    })
    expect(approvalPromptForCall(call('browser_snapshot'), 'auto', FRAMES, 'zh')).toBeUndefined()
  })

  it('treats a page picture as a read and scopes it to the target frame', () => {
    expect(approvalPromptForCall(call('browser_image', { selector: 'img' }), 'ask', FRAMES, 'en')).toMatchObject({
      kind: 'read',
      action: 'browser_image',
      origins: ['https://app.example'],
      canTrust: false,
    })
    expect(approvalPromptForCall(call('browser_image', { selector: 'img' }), 'auto', FRAMES, 'en')).toBeUndefined()
    expect(approvalPromptForCall(call('browser_image', { selector: 'img', frame: 4 }), 'ask', FRAMES, 'zh'))
      .toMatchObject({ origins: ['https://login.example.net'], summary: '读取当前页面里的一张图片' })
  })

  it('treats a screenshot as a page read and scopes it to the main frame', () => {
    expect(approvalPromptForCall(call('browser_capture'), 'ask', FRAMES, 'zh')).toMatchObject({
      kind: 'read',
      action: 'browser_capture',
      origins: ['https://app.example'],
      canTrust: false,
      summary: '截取当前页面截图',
    })
    expect(approvalPromptForCall(call('browser_capture'), 'ask', FRAMES, 'en')?.summary)
      .toBe('Capture a screenshot of the current page')
    expect(approvalPromptForCall(call('browser_capture'), 'auto', FRAMES, 'zh')).toBeUndefined()
  })

  it('gates a Drive export on the file origin, without printing share tokens', () => {
    const prompt = approvalPromptForCall(
      call('gdrive.fetch', { url: 'https://docs.google.com/document/d/FILE-ID/edit?usp=sharing&token=secret' }),
      'auto',
      FRAMES,
      'en',
    )

    expect(prompt).toMatchObject({
      kind: 'action',
      action: 'gdrive.fetch',
      origins: ['https://docs.google.com'],
      canTrust: true,
    })
    expect(prompt?.summary).toContain('https://docs.google.com/document/d/FILE-ID/edit')
    expect(prompt?.summary).not.toContain('token=secret')
  })

  it('offers no trust for an export URL without a usable origin', () => {
    expect(approvalPromptForCall(call('gdrive.fetch', { url: 'not a url' }), 'auto', FRAMES, 'zh'))
      .toMatchObject({ kind: 'action', action: 'gdrive.fetch', origins: [], canTrust: false })
    expect(approvalPromptForCall(call('gdrive.fetch', { url: 'file:///etc/hosts' }), 'auto', FRAMES, 'zh'))
      .toMatchObject({ origins: [], canTrust: false })
  })

  it('classifies the debugging tools: reads stay reads, injections never trust', () => {
    for (const name of ['browser_console', 'browser_network']) {
      expect(approvalPromptForCall(call(name), 'ask', FRAMES, 'en')).toMatchObject({ kind: 'read', action: name, canTrust: false })
      expect(approvalPromptForCall(call(name), 'auto', FRAMES, 'en')).toBeUndefined()
    }

    expect(approvalPromptForCall(call('browser_eval', { expression: 'document.title' }), 'auto', FRAMES, 'en'))
      .toMatchObject({ kind: 'action', action: 'browser_eval', canTrust: false })
    expect(approvalPromptForCall(call('browser_headers', { pattern: '*/api/*' }), 'auto', FRAMES, 'en'))
      .toMatchObject({ kind: 'action', action: 'browser_headers', canTrust: false })
    // Answering a dialog can commit an irreversible action, so it never trusts.
    const dialog = approvalPromptForCall(call('browser_dialog', { action: 'accept' }), 'auto', FRAMES, 'en')
    expect(dialog).toMatchObject({ kind: 'action', action: 'browser_dialog', canTrust: false })
    expect(dialog?.summary).toContain('accept')
    expect(approvalPromptForCall(call('browser_network', { mock: { pattern: 'x' } }), 'auto', FRAMES, 'en'))
      .toMatchObject({ kind: 'action', action: 'browser_network', canTrust: false })
    // Blocking is tab-scoped and reversible, so a trusted origin may skip it.
    const block = approvalPromptForCall(call('browser_block', { pattern: '*/ads/*' }), 'auto', FRAMES, 'en')
    expect(block).toMatchObject({ kind: 'action', action: 'browser_block', canTrust: true })
    expect(block?.summary).toContain('*/ads/*')
  })

  it('scopes JavaScript consent to the frame the expression runs in', () => {
    // Slides and similar SPAs load auxiliary frames that come and go; making
    // consent depend on all of them invalidated grants the user had just given.
    expect(approvalPromptForCall(call('browser_eval', { expression: 'document.title' }), 'auto', FRAMES, 'en'))
      .toMatchObject({ origins: ['https://app.example'] })
    expect(approvalPromptForCall(call('browser_eval', { expression: 'document.title', frame: 4 }), 'auto', FRAMES, 'en'))
      .toMatchObject({ origins: ['https://login.example.net'] })
    expect(approvalPromptForCall(call('browser_eval', { expression: 'document.title', frame: 99 }), 'auto', FRAMES, 'en'))
      .toMatchObject({ origins: [] })
    // A dialog and header rewriting act on the whole tab, not one frame.
    expect(approvalPromptForCall(call('browser_dialog', { action: 'accept' }), 'auto', FRAMES, 'en'))
      .toMatchObject({ origins: ['https://app.example', 'https://login.example.net'] })
    expect(approvalPromptForCall(call('browser_headers', { pattern: '*/api/*' }), 'auto', FRAMES, 'en'))
      .toMatchObject({ origins: ['https://app.example', 'https://login.example.net'] })
  })

  it('lets origin trust cover JavaScript only by explicit opt-in', () => {
    try {
      expect(approvalPromptForCall(call('browser_eval', { expression: 'document.title' }), 'auto', FRAMES, 'en'))
        .toMatchObject({ action: 'browser_eval', canTrust: false })

      setActionTrustPolicy({ trustJsExecution: true })
      expect(approvalPromptForCall(call('browser_eval', { expression: 'document.title' }), 'auto', FRAMES, 'en'))
        .toMatchObject({ action: 'browser_eval', canTrust: true })
      // Header rewriting stays untrustable in either mode.
      expect(approvalPromptForCall(call('browser_headers', { pattern: '*/api/*' }), 'auto', FRAMES, 'en'))
        .toMatchObject({ action: 'browser_headers', canTrust: false })
    } finally {
      setActionTrustPolicy({ trustJsExecution: false })
    }
  })

  it('scopes a frame-local action to the frame origin and redacts typed text', () => {
    const prompt = approvalPromptForCall(call('browser_type', {
      frame: 4,
      index: 7,
      text: 'my-password-must-not-appear',
    }), 'auto', FRAMES, 'zh')

    expect(prompt).toMatchObject({
      kind: 'action',
      origins: ['https://login.example.net'],
      canTrust: true,
    })
    expect(prompt?.summary).toContain('27 个字符')
    expect(prompt?.summary).not.toContain('my-password')
  })

  it('offers persistent trust for the destination of any navigation', () => {
    const prompt = approvalPromptForCall(call('browser_navigate', {
      url: 'https://bank.example/transfer?token=secret#confirm',
    }), 'auto', FRAMES, 'zh')

    expect(prompt).toMatchObject({
      origins: ['https://bank.example'],
      canTrust: true,
      summary: '导航到 https://bank.example/transfer',
    })
    expect(prompt?.summary).not.toContain('secret')
  })

  it('does not offer trust for invalid navigation and keeps key summaries on one bounded line', () => {
    expect(approvalPromptForCall(call('browser_navigate', { url: 'javascript:alert(1)' }), 'auto', FRAMES, 'zh'))
      .toMatchObject({ canTrust: false })

    const prompt = approvalPromptForCall(call('browser_press', { key: `Enter\n${'x'.repeat(100)}` }), 'auto', FRAMES, 'zh')
    expect(prompt?.summary).not.toContain('\n')
    expect(prompt?.summary.length).toBeLessThan(70)
  })

  it('keeps read-only viewport tools outside the approval path', () => {
    expect(approvalPromptForCall(call('browser_scroll', { direction: 'down' }), 'auto', FRAMES, 'zh')).toBeUndefined()
    expect(approvalPromptForCall(call('browser_wait'), 'auto', FRAMES, 'zh')).toBeUndefined()
  })

  it('renders approval summaries in English for non-Chinese browsers', () => {
    expect(approvalPromptForCall(call('browser_type', {
      index: 3,
      text: 'secret',
    }), 'auto', FRAMES, 'en')?.summary).toBe(
      'Enter 6 characters in element [3] (the text is not shown in this dialog)',
    )
    expect(approvalPromptForCall(call('browser_snapshot'), 'ask', FRAMES, 'en')?.summary)
      .toBe('Read the current page and accessible iframes')
  })
})

describe('originFromUrl', () => {
  it('accepts web/blob origins and rejects browser-internal or invalid URLs', () => {
    expect(originFromUrl('https://example.com/path?q=1')).toBe('https://example.com')
    expect(originFromUrl('blob:https://example.com/id')).toBe('https://example.com')
    expect(originFromUrl('chrome://settings')).toBeUndefined()
    expect(originFromUrl('not a url')).toBeUndefined()
  })
})
