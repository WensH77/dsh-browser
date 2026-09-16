// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchToolCall, invalidationReason, type ToolAnswer, type ToolCall } from '../src/background/tools.ts'
import type { TabFrame } from '../src/background/frames.ts'

const CALL: ToolCall = { id: 'tool-1', name: 'browser_snapshot', args: {} }
const OK: ToolAnswer = { ok: true, result: { text: 'page' } }

function mockChrome(options: {
  tab?: { id?: number; url?: string }
  responses?: Array<unknown>
  injectionError?: Error
  frames?: Array<{ frameId: number; parentFrameId: number; documentId?: string; url: string }>
  respond?: (message: unknown, frameId: number) => unknown
  debugger?: unknown
}) {
  const responses = [...(options.responses ?? [OK])]
  const runtimeListeners = new Set<(message: unknown, sender: chrome.runtime.MessageSender) => void>()
  const currentFrames = () => options.frames ?? (options.tab?.id === undefined ? [] : [{
    frameId: 0,
    parentFrameId: -1,
    documentId: `document-${options.tab.id}`,
    url: options.tab.url ?? '',
  }])
  const sendMessage = vi.fn(async (
    _tabId: number,
    message: unknown,
    target?: { frameId?: number; documentId?: string },
  ) => {
    const targetFrameId = target?.frameId
      ?? currentFrames().find((frame) => frame.documentId === target?.documentId)?.frameId
      ?? 0
    const response = options.respond?.(message, targetFrameId) ?? responses.shift()
    if (response instanceof Error) throw response
    return response
  })
  const executeScript = options.injectionError === undefined
    ? vi.fn(async () => [{ frameId: 0, result: undefined }])
    : vi.fn(async () => { throw options.injectionError })
  const query = vi.fn(async () => options.tab === undefined ? [] : [options.tab])
  const getAllFrames = vi.fn(async () => currentFrames())
  vi.stubGlobal('chrome', {
    tabs: { query, sendMessage },
    scripting: { executeScript },
    webNavigation: { getAllFrames },
    debugger: options.debugger,
    runtime: {
      onMessage: {
        addListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
          runtimeListeners.add(listener)
        },
        removeListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
          runtimeListeners.delete(listener)
        },
      },
    },
  })
  const emitContentReady = (tabId: number, frameId: number, documentId: string): void => {
    for (const listener of runtimeListeners) {
      listener({ type: 'DSH_CONTENT_READY' }, { tab: { id: tabId }, frameId, documentId } as chrome.runtime.MessageSender)
    }
  }
  return { emitContentReady, executeScript, getAllFrames, query, sendMessage }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** CDP stub: one 800x600 viewport, one 800x1200 page, one tiny PNG payload. */
function mockDebuggerApi(overrides: { attachError?: Error; targets?: unknown[] } = {}) {
  const attach = vi.fn(async () => {
    if (overrides.attachError !== undefined) throw overrides.attachError
  })
  const detach = vi.fn(async () => undefined)
  const sendCommand = vi.fn(async (_target: unknown, method: string) => {
    if (method === 'Page.getLayoutMetrics') {
      return {
        cssVisualViewport: { clientWidth: 800, clientHeight: 600 },
        contentSize: { width: 800, height: 1200 },
      }
    }
    return { data: Buffer.from('captured-png').toString('base64') }
  })
  const onEvent = { addListener: vi.fn() }
  const onDetach = { addListener: vi.fn() }
  const getTargets = vi.fn(async () => overrides.targets ?? [])
  return { attach, detach, sendCommand, getTargets, onEvent, onDetach }
}

describe('dispatchToolCall', () => {
  it('uses an already-loaded content script without injecting', async () => {
    const chromeMock = mockChrome({ tab: { id: 7, url: 'https://example.com' } })

    const answer = await dispatchToolCall(CALL, 'auto')
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('page')
    expect((answer.result as { text: string }).text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1)
    expect(chromeMock.executeScript).not.toHaveBeenCalled()
  })

  it('injects content.js and retries for a page opened before extension load', async () => {
    const budget = { maxItems: 80, maxChars: 16_000 }
    const chromeMock = mockChrome({
      tab: { id: 7, url: 'https://example.com/already-open' },
      responses: [new Error('Could not establish connection. Receiving end does not exist.'), OK],
    })

    const answer = await dispatchToolCall(CALL, 'auto', budget)
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('page')
    expect(chromeMock.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, allFrames: true },
      files: ['content.js'],
    })
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(2)
    expect(chromeMock.sendMessage).toHaveBeenLastCalledWith(7, {
      type: 'DSH_ACTION',
      action: 'browser_snapshot',
      args: { delta: false },
      budget,
    }, { documentId: 'document-7' })
  })

  it('does not attempt injection on Chrome internal pages', async () => {
    const chromeMock = mockChrome({
      tab: { id: 8, url: 'chrome://extensions' },
      responses: [new Error('no receiver')],
    })

    await expect(dispatchToolCall(CALL, 'auto')).resolves.toMatchObject({
      ok: false,
      error: { code: 'content-unavailable', message: expect.stringContaining('http or https') },
    })
    expect(chromeMock.executeScript).not.toHaveBeenCalled()
  })

  it('returns a clear error when recovery injection is blocked', async () => {
    mockChrome({
      tab: { id: 9, url: 'https://chromewebstore.google.com/detail/example' },
      responses: [new Error('no receiver')],
      injectionError: new Error('Cannot access contents of the page'),
    })

    await expect(dispatchToolCall(CALL, 'auto')).resolves.toMatchObject({
      ok: false,
      error: { code: 'content-unavailable', message: expect.stringContaining('protected pages') },
    })
  })

  it('keeps the page-sharing privacy boundary ahead of tab access', async () => {
    const chromeMock = mockChrome({ tab: { id: 7, url: 'https://example.com' } })

    await expect(dispatchToolCall(CALL, 'off')).resolves.toMatchObject({
      ok: false,
      error: { code: 'action-failed' },
    })
    expect(chromeMock.query).not.toHaveBeenCalled()
  })

  it('dispatches to an explicitly bound background tab without querying the active tab', async () => {
    const chromeMock = mockChrome({
      tab: { id: 7, url: 'https://active.example/' },
      frames: [{ frameId: 0, parentFrameId: -1, documentId: 'bound-doc', url: 'https://bound.example/' }],
    })

    const answer = await dispatchToolCall(
      CALL,
      'auto',
      undefined,
      undefined,
      undefined,
      { id: 88, url: 'https://bound.example/' },
    )

    expect(answer.ok).toBe(true)
    expect(chromeMock.query).not.toHaveBeenCalled()
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(88, expect.any(Object), { documentId: 'bound-doc' })
  })

  it('aggregates top-level and cross-origin iframe snapshots', async () => {
    const chromeMock = mockChrome({
      tab: { id: 21, url: 'https://app.example/' },
      frames: [
        { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
        { frameId: 4, parentFrameId: 0, documentId: 'child-doc', url: 'https://login.example.net/form' },
      ],
      respond: (_message, frameId) => ({ ok: true, result: { text: frameId === 0 ? 'TOP SNAPSHOT' : 'IFRAME SNAPSHOT' } }),
    })

    const answer = await dispatchToolCall(CALL, 'auto', { maxItems: 10, maxChars: 2_000 })

    expect(answer).toMatchObject({ ok: true })
    const text = (answer.result as { text: string }).text
    expect(text).toContain('TOP SNAPSHOT')
    expect(text).toContain('iframe frame=4 parent=0 origin=https://login.example.net')
    expect(text).toContain('IFRAME SNAPSHOT')
    expect(chromeMock.sendMessage.mock.calls.map((call) => call[2])).toEqual([
      { documentId: 'top-doc' },
      { documentId: 'child-doc' },
    ])
  })

  it('routes an element action to the requested frame and removes routing metadata', async () => {
    const call: ToolCall = { id: 'tool-frame', name: 'browser_click', args: { frame: 8, index: 3 } }
    const chromeMock = mockChrome({
      tab: { id: 22, url: 'https://app.example/' },
      frames: [
        { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
        { frameId: 8, parentFrameId: 0, documentId: 'child-doc', url: 'https://widget.example/' },
      ],
      respond: (message, frameId) => {
        const action = (message as { action?: string }).action
        if (action === 'browser_snapshot') return { ok: true, result: { text: `frame ${frameId}` } }
        return OK
      },
    })

    await dispatchToolCall(CALL, 'auto')
    chromeMock.sendMessage.mockClear()
    await expect(dispatchToolCall(call, 'auto', undefined, async () => 'approved')).resolves.toEqual(OK)
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(22, {
      type: 'DSH_ACTION',
      action: 'browser_click',
      args: { index: 3 },
      budget: expect.objectContaining({ maxItems: 60 }),
      includePageDelta: true,
    }, { documentId: 'child-doc' })
  })

  it('returns automatic action deltas inside a fresh untrusted-content boundary', async () => {
    const call: ToolCall = { id: 'tool-delta', name: 'browser_click', args: { index: 3 } }
    const budget = { maxItems: 10, maxChars: 1_000 }
    const chromeMock = mockChrome({
      tab: { id: 33, url: 'https://app.example/' },
      respond: (message) => (message as { action?: string }).action === 'browser_snapshot'
        ? { ok: true, result: { text: 'Initial page' } }
        : {
            ok: true,
            result: {
              text: 'Clicked [3].',
              pageContent: 'Page change v2\nChanged main content:\nOrder complete',
            },
          },
    })
    await dispatchToolCall(CALL, 'auto', budget)
    chromeMock.sendMessage.mockClear()

    const answer = await dispatchToolCall(call, 'auto', budget, async () => 'approved')

    expect(answer.ok).toBe(true)
    const result = answer.result as { text: string; pageContent?: string }
    expect(result.text).toContain('Clicked [3].')
    expect(result.text).toContain('Continue from this state')
    expect(result.text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(result.text).toContain('Order complete')
    expect(result.text.length).toBeLessThanOrEqual(budget.maxChars)
    expect(result.pageContent).toBeUndefined()
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(33, {
      type: 'DSH_ACTION',
      action: 'browser_click',
      args: { index: 3 },
      budget,
      includePageDelta: true,
    }, { documentId: 'document-33' })
  })

  it('does not extract or forward an action delta when reads require approval', async () => {
    const call: ToolCall = { id: 'tool-private-delta', name: 'browser_click', args: { index: 2 } }
    const chromeMock = mockChrome({
      tab: { id: 34, url: 'https://private.example/' },
      respond: (message) => (message as { action?: string }).action === 'browser_snapshot'
        ? { ok: true, result: { text: 'Initial private page' } }
        : {
            ok: true,
            result: {
              text: 'Clicked [2].',
              pageContent: 'This content must not cross the sharing boundary',
            },
          },
    })
    await dispatchToolCall(CALL, 'auto')
    chromeMock.sendMessage.mockClear()

    const answer = await dispatchToolCall(call, 'ask', undefined, async () => 'approved')

    expect(answer).toEqual({ ok: true, result: { text: 'Clicked [2].' } })
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(34, {
      type: 'DSH_ACTION',
      action: 'browser_click',
      args: { index: 2 },
    }, { documentId: 'document-34' })
  })

  it('returns the replacement page snapshot in the same navigation tool call', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'document-before', url: 'https://app.example/start' },
    ]
    const budget = { maxItems: 10, maxChars: 2_000 }
    const chromeMock = mockChrome({
      tab: { id: 35, url: 'https://app.example/start' },
      frames,
      respond: (message) => (message as { action?: string }).action === 'browser_navigate'
        ? {
            ok: true,
            result: {
              text: 'Navigating to https://app.example/next. Call browser_snapshot again after the page loads.',
              navigationPending: true,
            },
          }
        : { ok: true, result: { text: 'Title: Next page\nURL: https://app.example/next' } },
    })

    const pending = dispatchToolCall(
      { id: 'tool-navigation', name: 'browser_navigate', args: { url: 'https://app.example/next' } },
      'auto',
      budget,
      async () => 'approved',
    )
    await vi.waitFor(() => { expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1) })
    frames[0] = {
      frameId: 0,
      parentFrameId: -1,
      documentId: 'document-after',
      url: 'https://app.example/next',
    }
    chromeMock.emitContentReady(35, 0, 'document-after')

    const answer = await pending
    const text = (answer.result as { text: string }).text
    expect(text).toContain('Navigation completed')
    expect(text).toContain('Title: Next page')
    expect(text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(text).not.toContain('Call browser_snapshot again')
    expect(text.length).toBeLessThanOrEqual(budget.maxChars)
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(2)
    expect(chromeMock.sendMessage).toHaveBeenLastCalledWith(35, expect.objectContaining({
      action: 'browser_snapshot',
      args: { delta: false },
      budget: expect.objectContaining({ maxChars: expect.any(Number) }),
    }), { documentId: 'document-after' })
    // The automatic read is deliberately cheaper than an explicit one: the
    // model can always ask for more, but a navigation should not cost 32k.
    const automatic = chromeMock.sendMessage.mock.calls.at(-1)?.[1] as { budget?: { maxChars?: number } }
    expect(automatic.budget?.maxChars).toBeLessThanOrEqual(8_000)
  })

  it('does not wait for or return navigation page content when reads are not automatic', async () => {
    const chromeMock = mockChrome({
      tab: { id: 36, url: 'https://app.example/start' },
      respond: () => ({
        ok: true,
        result: {
          text: 'Navigating to https://app.example/next. Call browser_snapshot again after the page loads.',
          navigationPending: true,
        },
      }),
    })

    const answer = await dispatchToolCall(
      { id: 'tool-private-navigation', name: 'browser_navigate', args: { url: 'https://app.example/next' } },
      'ask',
      undefined,
      async () => 'approved',
    )

    expect(answer).toEqual({
      ok: true,
      result: { text: expect.stringContaining('Call browser_snapshot again') },
    })
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('wraps browser_get_text output in the same untrusted-content boundary', async () => {
    const call: ToolCall = { id: 'tool-text', name: 'browser_get_text', args: {} }
    mockChrome({ tab: { id: 24, url: 'https://app.example/' }, responses: [{ ok: true, result: { text: 'page text' } }] })

    const answer = await dispatchToolCall(call, 'auto', { maxItems: 10, maxChars: 1_000 })

    const text = (answer.result as { text: string }).text
    expect(text).toContain('page text')
    expect(text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(text.length).toBeLessThanOrEqual(1_000)
  })

  it('returns the explicit user denial before reading', async () => {
    const authorize = vi.fn(async () => 'denied' as const)
    const chromeMock = mockChrome({
      tab: { id: 25, url: 'https://app.example/' },
      frames: [
        { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://app.example/' },
        { frameId: 2, parentFrameId: 0, documentId: 'child', url: 'https://embed.example.net/' },
      ],
    })

    const answer = await dispatchToolCall(CALL, 'ask', undefined, authorize)

    expect(answer).toEqual({
      ok: false,
      error: {
        code: 'action-failed',
        message: 'The user denied the browser approval request for "browser_snapshot".',
      },
    })
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'read',
      origins: ['https://app.example', 'https://embed.example.net'],
    }))
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('names what to do when an approval is withdrawn before it is answered', async () => {
    const chromeMock = mockChrome({ tab: { id: 28, url: 'https://app.example/' } })
    const authorize = vi.fn(async () => 'cancelled' as const)

    const answer = await dispatchToolCall(
      { id: 'withdrawn', name: 'browser_press', args: { key: 'Enter' } },
      'auto',
      undefined,
      authorize,
    )

    expect(answer).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    expect((answer as { error: { message: string } }).error.message).toContain('Nothing ran')
    expect((answer as { error: { message: string } }).error.message).toContain('Retry and answer the prompt')
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('performs no page action while an approval is still pending', async () => {
    const chromeMock = mockChrome({ tab: { id: 27, url: 'https://app.example/' } })
    let resolveApproval: (value: 'approved') => void = () => {}
    const authorize = vi.fn(() => new Promise<'approved'>((resolve) => { resolveApproval = resolve }))
    const call: ToolCall = { id: 'pending-approval', name: 'browser_press', args: { key: 'Enter' } }

    const pending = dispatchToolCall(call, 'auto', undefined, authorize)
    // Let frame discovery and prompt construction settle without an answer.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()

    resolveApproval('approved')
    const answer = await pending
    expect(answer.ok).toBe(true)
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('reports when no side panel can receive a state-changing approval', async () => {
    const call: ToolCall = { id: 'tool-denied', name: 'browser_press', args: { key: 'Enter' } }
    const chromeMock = mockChrome({ tab: { id: 26, url: 'https://app.example/' } })

    const answer = await dispatchToolCall(call, 'auto')

    expect(answer).toEqual({
      ok: false,
      error: {
        code: 'action-failed',
        message: 'No browser side panel was available to receive or complete the approval request for "browser_press".',
      },
    })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('returns an approval timeout without treating it as a user denial', async () => {
    const call: ToolCall = { id: 'tool-timeout', name: 'browser_press', args: { key: 'Enter' } }
    const chromeMock = mockChrome({ tab: { id: 27, url: 'https://app.example/' } })

    const answer = await dispatchToolCall(call, 'auto', undefined, async () => 'timed-out')

    expect(answer).toEqual({
      ok: false,
      error: {
        code: 'timeout',
        message: 'The browser approval request for "browser_press" timed out before the user responded.',
      },
    })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('does not dispatch an action after its bridge call is cancelled during approval', async () => {
    const call: ToolCall = { id: 'tool-cancelled', name: 'browser_press', args: { key: 'Enter' } }
    const controller = new AbortController()
    const chromeMock = mockChrome({ tab: { id: 27, url: 'https://app.example/' } })
    const authorize = vi.fn(async () => {
      controller.abort()
      return 'approved' as const
    })

    const answer = await dispatchToolCall(call, 'auto', undefined, authorize, controller.signal)

    expect(answer).toMatchObject({ ok: false, error: { code: 'bridge-closed' } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('does not dispatch an approved action after tab affinity changes', async () => {
    const call: ToolCall = { id: 'tool-switched', name: 'browser_press', args: { key: 'Enter' } }
    let targetAllowed = true
    const chromeMock = mockChrome({ tab: { id: 28, url: 'https://app.example/' } })
    const authorize = vi.fn(async () => {
      targetAllowed = false
      return 'approved' as const
    })

    const answer = await dispatchToolCall(
      call,
      'auto',
      undefined,
      authorize,
      undefined,
      { id: 28, url: 'https://app.example/' },
      () => targetAllowed,
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('controlled tab') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects an element reference after its frame document reloads', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
      { frameId: 3, parentFrameId: 0, documentId: 'child-v1', url: 'https://widget.example/form' },
    ]
    const chromeMock = mockChrome({
      tab: { id: 30, url: 'https://app.example/' },
      frames,
      respond: (_message, frameId) => ({ ok: true, result: { text: `frame ${frameId}` } }),
    })
    await dispatchToolCall(CALL, 'auto')
    chromeMock.sendMessage.mockClear()
    frames[1] = { ...frames[1]!, documentId: 'child-v2' }

    const answer = await dispatchToolCall(
      { id: 'stale-click', name: 'browser_click', args: { frame: 3, index: 4 } },
      'auto',
      undefined,
      async () => 'approved',
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('Call browser_snapshot again') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects an action when its target origin changes during approval', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-v1', url: 'https://app.example/' },
    ]
    const chromeMock = mockChrome({ tab: { id: 31, url: 'https://app.example/' }, frames })
    const authorize = vi.fn(async () => {
      frames[0] = { ...frames[0]!, documentId: 'top-v2', url: 'https://evil.example/' }
      return 'approved' as const
    })

    const answer = await dispatchToolCall(
      { id: 'changed-origin', name: 'browser_press', args: { key: 'Enter' } },
      'auto',
      undefined,
      authorize,
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('page changed while approval was pending') } })
    // The message names what actually changed instead of blaming "the page".
    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('new origins: https://evil.example') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects an action when the same-origin document changes during approval', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-v1', url: 'https://app.example/one' },
    ]
    const chromeMock = mockChrome({ tab: { id: 32, url: 'https://app.example/one' }, frames })
    const authorize = vi.fn(async () => {
      frames[0] = { ...frames[0]!, documentId: 'top-v2', url: 'https://app.example/two' }
      return 'approved' as const
    })

    const answer = await dispatchToolCall(
      { id: 'changed-document', name: 'browser_press', args: { key: 'Enter' } },
      'auto',
      undefined,
      authorize,
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('page changed while approval was pending') } })
    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('navigated (https://app.example/one → https://app.example/two)') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('does not mistake a url-only frame listing for a navigation', async () => {
    // `getAllFrames` can fail transiently and leave a url-only fallback entry.
    // Comparing that against a document id used to read as a page change and
    // threw away an approval the user had just granted.
    const live: Array<{ frameId: number; parentFrameId: number; documentId?: string; url: string }> = []
    const chromeMock = mockChrome({ tab: { id: 33, url: 'https://app.example/page' }, frames: live })
    const authorize = vi.fn(async () => {
      live.push({ frameId: 0, parentFrameId: -1, documentId: 'doc-1', url: 'https://app.example/page' })
      return 'approved' as const
    })

    const answer = await dispatchToolCall(
      { id: 'url-only-frames', name: 'browser_press', args: { key: 'Enter' } },
      'auto',
      undefined,
      authorize,
    )

    expect(answer).toMatchObject({ ok: true })
    expect(chromeMock.sendMessage).toHaveBeenCalled()
  })

  it('forces a full snapshot for a newly navigated frame before resuming deltas', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
      { frameId: 6, parentFrameId: 0, documentId: 'child-v1', url: 'https://widget.example/one' },
    ]
    const seen: Array<{ frameId: number; delta: unknown }> = []
    const chromeMock = mockChrome({
      tab: { id: 23, url: 'https://app.example/' },
      frames,
      respond: (message, frameId) => {
        seen.push({ frameId, delta: (message as { args?: { delta?: unknown } }).args?.delta })
        return { ok: true, result: { text: `frame ${frameId}` } }
      },
    })
    const deltaCall: ToolCall = { ...CALL, id: 'delta', args: { delta: true } }

    await dispatchToolCall(deltaCall, 'auto')
    expect(seen.splice(0)).toEqual([{ frameId: 0, delta: false }, { frameId: 6, delta: false }])

    await dispatchToolCall(deltaCall, 'auto')
    expect(seen.splice(0)).toEqual([{ frameId: 0, delta: true }, { frameId: 6, delta: true }])

    frames[1] = { ...frames[1]!, documentId: 'child-v2', url: 'https://widget.example/two' }
    await dispatchToolCall(deltaCall, 'auto')
    expect(seen).toEqual([{ frameId: 0, delta: true }, { frameId: 6, delta: false }])
    expect(chromeMock.getAllFrames).toHaveBeenCalledTimes(3)
  })

  it('captures a screenshot for browser_capture without touching the content script', async () => {
    const debuggerApi = mockDebuggerApi()
    const chromeMock = mockChrome({ tab: { id: 41, url: 'https://app.example/visual' }, debugger: debuggerApi })

    const answer = await dispatchToolCall({ id: 'shot', name: 'browser_capture', args: {} }, 'auto')

    expect(answer.ok).toBe(true)
    const result = answer.result as { text: string; image: { mediaType: string; dataBase64: string; bytes: number } }
    expect(result.text).toContain('<capture>')
    expect(result.text).toContain('https://app.example/visual')
    expect(result.text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(result.image.mediaType).toBe('image/png')
    expect(result.image.bytes).toBeGreaterThan(0)
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
    expect(debuggerApi.attach).toHaveBeenCalledWith({ tabId: 41 }, '1.3')
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 41 })
  })

  it('pairs a snapshot with a same-moment screenshot when the host asks for vision', async () => {
    const debuggerApi = mockDebuggerApi()
    const chromeMock = mockChrome({ tab: { id: 42, url: 'https://app.example/' }, debugger: debuggerApi })

    const answer = await dispatchToolCall(
      { id: 'visual-snapshot', name: 'browser_snapshot', args: { visual: true } },
      'auto',
    )

    expect(answer.ok).toBe(true)
    const result = answer.result as { text: string; image?: { mediaType: string } }
    expect(result.text).toContain('page')
    expect(result.image?.mediaType).toBe('image/png')
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1)
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 42 }, 'Page.captureScreenshot', expect.anything())
  })

  it('keeps the snapshot text when the page cannot be captured', async () => {
    const chromeMock = mockChrome({ tab: { id: 43, url: 'https://app.example/' } })

    const answer = await dispatchToolCall(
      { id: 'visual-snapshot-fallback', name: 'browser_snapshot', args: { visual: true } },
      'auto',
    )

    expect(answer.ok).toBe(true)
    const result = answer.result as { text: string; image?: unknown }
    expect(result.text).toContain('page')
    expect(result.text).toContain('screenshot unavailable')
    expect(result.image).toBeUndefined()
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('answers a console read from the CDP session inside the untrusted boundary', async () => {
    const debuggerApi = mockDebuggerApi()
    const chromeMock = mockChrome({ tab: { id: 51, url: 'https://app.example/' }, debugger: debuggerApi })

    const answer = await dispatchToolCall({ id: 'console-read', name: 'browser_console', args: {} }, 'auto')

    expect(answer.ok).toBe(true)
    const text = (answer.result as { text: string }).text
    expect(text).toContain('console entries')
    expect(text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(debuggerApi.attach).toHaveBeenCalledWith({ tabId: 51 }, '1.3')
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 51 }, 'Runtime.enable')
    // Tab-level debugging never reaches the page's content script.
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('blocks screenshots when page content sharing is off', async () => {
    const debuggerApi = mockDebuggerApi()
    mockChrome({ tab: { id: 44, url: 'https://app.example/' }, debugger: debuggerApi })

    const answer = await dispatchToolCall({ id: 'shot-off', name: 'browser_capture', args: {} }, 'off')

    expect(answer).toMatchObject({ ok: false, error: { code: 'action-failed', message: expect.stringContaining('sharing is disabled') } })
    expect(debuggerApi.attach).not.toHaveBeenCalled()
  })

  it('reuses its own session instead of reporting DevTools', async () => {
    // Chrome reports this string only when *this* extension already holds the
    // target — the console/network priming hold, in practice. The capture must
    // reuse it rather than claim DevTools is open.
    const debuggerApi = mockDebuggerApi({ attachError: new Error('Another debugger is already attached to the tab with id: 45') })
    mockChrome({ tab: { id: 45, url: 'https://app.example/' }, debugger: debuggerApi })

    const answer = await dispatchToolCall({ id: 'shot-reuse', name: 'browser_capture', args: {} }, 'auto')

    expect(answer).toMatchObject({ ok: true })
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 45 })
  })

  it('names DevTools when a foreign client holds the tab', async () => {
    const debuggerApi = mockDebuggerApi({
      attachError: new Error('Cannot attach to this target.'),
      targets: [{ id: 't', tabId: 45, attached: true, type: 'page', title: 'x', url: 'https://app.example/' }],
    })
    mockChrome({ tab: { id: 45, url: 'https://app.example/' }, debugger: debuggerApi })

    const answer = await dispatchToolCall({ id: 'shot-conflict', name: 'browser_capture', args: {} }, 'auto')

    expect(answer).toMatchObject({ ok: false, error: { code: 'action-failed', message: expect.stringContaining('Close DevTools') } })
  })
})

describe('invalidationReason', () => {
  const approval = {
    kind: 'action' as const,
    action: 'browser_eval',
    summary: 'run js',
    origins: ['https://app.example'],
    canTrust: true,
  }
  const frame = (over: Partial<TabFrame> = {}): TabFrame => ({
    frameId: 0,
    parentFrameId: -1,
    documentId: 'doc',
    url: 'https://app.example/',
    ...over,
  })

  it('names added and removed origins when the frame set moved', () => {
    const reason = invalidationReason(
      approval,
      { ...approval, origins: ['https://app.example', 'https://accounts.example'] },
      { id: 'c', name: 'browser_eval', args: {} },
      [frame()],
      [frame(), frame({ frameId: 7, url: 'https://accounts.example/' })],
    )

    expect(reason).toContain('new origins: https://accounts.example')
    expect(reason).not.toContain('removed origins')
  })

  it('names a replaced target document and a vanished frame', () => {
    expect(invalidationReason(
      approval,
      approval,
      { id: 'c', name: 'browser_eval', args: {} },
      [frame({ url: 'https://app.example/one' })],
      [frame({ documentId: 'other', url: 'https://app.example/two' })],
    )).toBe('frame 0 navigated (https://app.example/one → https://app.example/two)')

    expect(invalidationReason(
      approval,
      approval,
      { id: 'c', name: 'browser_eval', args: { frame: 4 } },
      [frame(), frame({ frameId: 4, url: 'https://widget.example/' })],
      [frame()],
    )).toBe('frame 4 disappeared')
  })

  it('points at the approval itself when the call no longer needs one', () => {
    expect(invalidationReason(approval, undefined, { id: 'c', name: 'browser_eval', args: {} }, [frame()], [frame()]))
      .toBe('the operation no longer needs approval on this page')
  })
})

describe('uninjectable targets', () => {
  const failing = () => new Error('Could not establish connection. Receiving end does not exist.')

  it('tells the model a brand-new tab is still loading, not that the page is unsupported', async () => {
    // A tab opened by browser_navigate has no committed URL for a moment; the
    // old copy ("switch to a standard http or https page") sent the model
    // hunting for another tool instead of retrying.
    mockChrome({ tab: { id: 40, url: '' }, frames: [], respond: failing })

    const answer = await dispatchToolCall({ id: 'fresh-tab', name: 'browser_wait', args: { ms: 3000 } }, 'auto')

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('has not finished loading its first document') } })
    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('browser_wait or browser_snapshot again') } })
  })

  it('keeps the unsupported-page copy for pages the content script may never touch', async () => {
    mockChrome({ tab: { id: 41, url: 'chrome://extensions/' }, frames: [], respond: failing })

    const answer = await dispatchToolCall({ id: 'chrome-url', name: 'browser_wait', args: {} }, 'auto')

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('does not support browser operations') } })
  })
})

describe('browser_image dispatch', () => {
  const PNG_BASE64 = Buffer.from('page-picture-bytes').toString('base64')

  it('reads the page picture into an image result', async () => {
    mockChrome({
      tab: { id: 51, url: 'https://app.example/report' },
      respond: () => ({ ok: true, result: { text: 'image source: img 1338x1722 px', imageSource: { kind: 'img', url: `data:image/png;base64,${PNG_BASE64}` } } }),
    })
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1338, height: 1722, close: vi.fn() })))

    const answer = await dispatchToolCall({ id: 'page-image', name: 'browser_image', args: { selector: 'img' } }, 'auto')

    expect(answer).toMatchObject({ ok: true })
    const result = answer.result as { text: string; image?: { mediaType: string; width: number; height: number } }
    expect(result.text).toContain('kind: img')
    expect(result.image).toMatchObject({ mediaType: 'image/png', width: 1338, height: 1722 })
  })

  it('explains a target that is not a picture', async () => {
    mockChrome({
      tab: { id: 52, url: 'https://app.example/report' },
      respond: () => ({ ok: true, result: { text: 'image source: img' } }),
    })

    const answer = await dispatchToolCall({ id: 'not-image', name: 'browser_image', args: { selector: '.note' } }, 'auto')

    expect(answer).toMatchObject({ ok: false, error: { code: 'content-unavailable', message: expect.stringContaining('did not report a picture') } })
  })

  it('stays blocked while page content sharing is off', async () => {
    mockChrome({ tab: { id: 53, url: 'https://app.example/report' } })

    const answer = await dispatchToolCall({ id: 'off', name: 'browser_image', args: { selector: 'img' } }, 'off')

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('Page content sharing is disabled') } })
  })
})
