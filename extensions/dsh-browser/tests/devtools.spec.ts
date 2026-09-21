// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDebuggerSessionsForTest } from '../src/background/debugger-session.ts'

/** Buffers and sessions live at module scope, so each test reloads the module. */
type Devtools = typeof import('../src/background/devtools.ts')

interface Harness {
  devtools: Devtools
  emit: (tabId: number, method: string, params?: object) => void
  detach: (tabId: number, reason?: string) => void
  sendCommand: ReturnType<typeof vi.fn>
  attach: ReturnType<typeof vi.fn>
  detachCommand: ReturnType<typeof vi.fn>
}

async function loadHarness(): Promise<Harness> {
  const eventListeners: Array<(source: { tabId?: number }, method: string, params?: object) => void> = []
  const detachListeners: Array<(source: { tabId?: number }, reason: string) => void> = []
  const sendCommand = vi.fn(async (_target: unknown, method: string, _params?: object) => {
    if (method === 'Network.getResponseBody') return { body: '{"ok":true}', base64Encoded: false }
    if (method === 'Runtime.evaluate') return { result: { value: { title: 'Example' } } }
    return {}
  })
  const attach = vi.fn(async () => undefined)
  const detachCommand = vi.fn(async () => undefined)
  vi.stubGlobal('chrome', {
    debugger: {
      attach,
      detach: detachCommand,
      sendCommand,
      onEvent: { addListener: (listener: (typeof eventListeners)[number]) => eventListeners.push(listener) },
      onDetach: { addListener: (listener: (typeof detachListeners)[number]) => detachListeners.push(listener) },
    },
  })
  vi.resetModules()
  const devtools = await import('../src/background/devtools.ts')
  return {
    devtools,
    sendCommand,
    attach,
    detachCommand,
    emit: (tabId, method, params) => { for (const listener of eventListeners) listener({ tabId }, method, params) },
    detach: (tabId, reason = 'canceled_by_user') => { for (const listener of detachListeners) listener({ tabId }, reason) },
  }
}

let harness: Harness

beforeEach(async () => {
  resetDebuggerSessionsForTest()
  harness = await loadHarness()
})

afterEach(() => {
  resetDebuggerSessionsForTest()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('console buffer', () => {
  it('attaches on demand, then buffers messages and advances the cursor', async () => {
    // The first call attaches; events only flow for an attached tab.
    await harness.devtools.readConsole(1, {}, 32_000)
    harness.emit(1, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'hello' }, { value: 42 }] })
    harness.emit(1, 'Runtime.consoleAPICalled', { type: 'error', args: [{ description: 'boom' }] })
    harness.emit(1, 'Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: bad' } } })

    const first = await harness.devtools.readConsole(1, {}, 32_000)
    expect(harness.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3')
    expect(first.result?.text).toContain('[1] log: hello 42')
    expect(first.result?.text).toContain('[2] error: boom')
    expect(first.result?.text).toContain('TypeError: bad')
    expect(first.result?.text).toContain('nextCursor: 3')

    const next = await harness.devtools.readConsole(1, { cursor: 3 }, 32_000)
    expect(next.result?.text).toContain('(none new)')
    expect(harness.attach).toHaveBeenCalledTimes(1)
    void first
  })

  it('filters by level and text', async () => {
    await harness.devtools.readConsole(1, {}, 32_000)
    harness.emit(1, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'keep me' }] })
    harness.emit(1, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'drop me' }] })
    harness.emit(1, 'Log.entryAdded', { entry: { level: 'warning', text: 'careful' } })

    const level = await harness.devtools.readConsole(1, { level: 'warning' }, 32_000)
    expect(level.result?.text).toContain('careful')
    expect(level.result?.text).not.toContain('keep me')

    const text = await harness.devtools.readConsole(1, { text: 'KEEP' }, 32_000)
    expect(text.result?.text).toContain('keep me')
    expect(text.result?.text).not.toContain('careful')
  })

  it('drops the buffer when the session detaches', async () => {
    await harness.devtools.readConsole(1, {}, 32_000)
    harness.emit(1, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'before' }] })
    harness.detach(1)

    const after = await harness.devtools.readConsole(1, {}, 32_000)
    expect(after.result?.text).not.toContain('before')
    expect(harness.attach).toHaveBeenCalledTimes(2)
  })
})

describe('network buffer', () => {
  it('lists requests with status and reads one body by id', async () => {
    await harness.devtools.readNetwork(1, {}, 32_000)
    harness.emit(1, 'Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://app.example/api', method: 'POST' }, type: 'XHR' })
    harness.emit(1, 'Network.responseReceived', { requestId: 'r1', response: { status: 201 }, type: 'XHR' })
    harness.emit(1, 'Network.requestWillBeSent', { requestId: 'r2', request: { url: 'https://app.example/gone', method: 'GET' }, type: 'Fetch' })
    harness.emit(1, 'Network.loadingFailed', { requestId: 'r2', errorText: 'net::ERR_BLOCKED_BY_CLIENT' })

    const list = await harness.devtools.readNetwork(1, {}, 32_000)
    expect(list.result?.text).toContain('id=r1 POST 201')
    expect(list.result?.text).toContain('id=r2 GET FAILED net::ERR_BLOCKED_BY_CLIENT')
    expect(list.result?.text).toContain('nextCursor: 2')

    const body = await harness.devtools.readNetwork(1, { requestId: 'r1' }, 32_000)
    expect(body.result?.text).toContain('status: 201')
    expect(body.result?.text).toContain('{"ok":true}')

    void list
    const filtered = await harness.devtools.readNetwork(1, { url: 'gone' }, 32_000)
    expect(filtered.result?.text).toContain('id=r2')
    expect(filtered.result?.text).not.toContain('id=r1')
  })

  it('names an unknown request id instead of failing silently', async () => {
    await harness.devtools.readNetwork(1, {}, 32_000)
    const answer = await harness.devtools.readNetwork(1, { requestId: 'nope' }, 32_000)
    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('No captured request has id nope')
  })
})

describe('response overrides', () => {
  it('enables Fetch and fulfils matching paused requests from memory', async () => {
    const parsed = harness.devtools.parseMockRule({ pattern: '/api/user', status: 200, body: '{"mocked":true}' })
    expect(parsed).toBeDefined()

    await harness.devtools.installMock(1, parsed!)
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Fetch.enable', {
      patterns: [{ urlPattern: '*/api/user*', requestStage: 'Request' }],
    })

    harness.emit(1, 'Fetch.requestPaused', { requestId: 'p1', request: { url: 'https://app.example/api/user/7' } })
    await vi.waitFor(() => {
      expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Fetch.fulfillRequest', {
        requestId: 'p1',
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/plain; charset=utf-8' }],
        body: Buffer.from('{"mocked":true}', 'utf8').toString('base64'),
      })
    })

    const removed = await harness.devtools.clearMocks(1)
    expect(removed).toBe(1)
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Fetch.disable')
  })

  it('fulfils a mocked body without a Node global', async () => {
    // The service worker is a browser worker, so `Buffer` does not exist there.
    // The body encoder used it anyway; the throw landed in a bare catch and every
    // mocked response stayed paused forever instead of being answered.
    vi.stubGlobal('Buffer', undefined)
    await harness.devtools.installMock(1, { pattern: '/api/user', status: 201, body: 'plain' })

    harness.emit(1, 'Fetch.requestPaused', { requestId: 'p1', request: { url: 'https://app.example/api/user/7' } })

    await vi.waitFor(() => {
      expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Fetch.fulfillRequest', {
        requestId: 'p1',
        responseCode: 201,
        responseHeaders: [{ name: 'content-type', value: 'text/plain; charset=utf-8' }],
        body: 'cGxhaW4=',
      })
    })
  })

  it('keeps every installed rule in the pattern set Fetch.enable replaces', async () => {
    await harness.devtools.installMock(1, { pattern: '/api/one', body: 'one' })
    await harness.devtools.installMock(1, { pattern: '/api/two', body: 'two' })

    const enables = harness.sendCommand.mock.calls.filter((call) => call[1] === 'Fetch.enable')
    // Sending only the newest pattern silently disabled the earlier rule while
    // the tool still reported "2 rule(s)".
    expect(enables.at(-1)?.[2]).toEqual({
      patterns: [
        { urlPattern: '*/api/one*', requestStage: 'Request' },
        { urlPattern: '*/api/two*', requestStage: 'Request' },
      ],
    })

    harness.emit(1, 'Fetch.requestPaused', { requestId: 'p1', request: { url: 'https://app.example/api/one' } })
    harness.emit(1, 'Fetch.requestPaused', { requestId: 'p2', request: { url: 'https://app.example/api/two' } })

    await vi.waitFor(() => {
      expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Fetch.fulfillRequest', expect.objectContaining({ requestId: 'p1', body: 'b25l' }))
      expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Fetch.fulfillRequest', expect.objectContaining({ requestId: 'p2', body: 'dHdv' }))
    })
  })

  it('releases the request when a fulfil fails, instead of leaving it paused', async () => {
    harness.sendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'Fetch.fulfillRequest') throw new Error('Fulfil failed')
      return {}
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await harness.devtools.installMock(1, { pattern: '/api/user', body: 'x' })

    harness.emit(1, 'Fetch.requestPaused', { requestId: 'p9', request: { url: 'https://app.example/api/user/7' } })

    await vi.waitFor(() => {
      expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Fetch.continueRequest', { requestId: 'p9' })
    })
    // The reason has to survive the failure: a silent catch is what hid the bug.
    expect(warn).toHaveBeenCalled()
  })

  it('fails a matching request and releases the rest untouched', async () => {
    await harness.devtools.installMock(1, { pattern: 'blocked.example', fail: true })

    harness.emit(1, 'Fetch.requestPaused', { requestId: 'p1', request: { url: 'https://blocked.example/x' } })
    harness.emit(1, 'Fetch.requestPaused', { requestId: 'p2', request: { url: 'https://other.example/y' } })

    await vi.waitFor(() => {
      expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Fetch.failRequest', { requestId: 'p1', errorReason: 'Failed' })
    })
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Fetch.continueRequest', { requestId: 'p2' })
  })

  it('rejects malformed mock rules', () => {
    expect(harness.devtools.parseMockRule(null)).toBeUndefined()
    expect(harness.devtools.parseMockRule({})).toBeUndefined()
    expect(harness.devtools.parseMockRule({ pattern: '  ' })).toBeUndefined()
    expect(harness.devtools.parseMockRule({ pattern: 'x', headers: [{ name: 'a' }] })).toBeUndefined()
    expect(harness.devtools.parseMockRule({ pattern: 'x', headers: [{ name: 'a', value: 'b' }] }))
      .toEqual({ pattern: 'x', headers: [{ name: 'a', value: 'b' }] })
  })
})

describe('eager priming', () => {
  it('attaches and opens the console and network buffers before any read', async () => {
    expect(harness.devtools.isSessionAttached(1)).toBe(false)

    await harness.devtools.primeSession(1)

    expect(harness.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3')
    for (const domain of ['Runtime', 'Log', 'Network']) {
      expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, `${domain}.enable`)
    }
    expect(harness.devtools.isSessionAttached(1)).toBe(true)
  })

  it('buffers events that arrive before the model asks for them', async () => {
    await harness.devtools.primeSession(1)
    harness.emit(1, 'Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://app.example/submit', method: 'POST' }, type: 'Fetch' })
    harness.emit(1, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'boom on load' }] })

    const network = await harness.devtools.readNetwork(1, {}, 32_000)
    const console = await harness.devtools.readConsole(1, {}, 32_000)

    expect(network.result?.text).toContain('https://app.example/submit')
    expect(console.result?.text).toContain('boom on load')
  })

  it('reports a detached session so the caller can prime it again', async () => {
    await harness.devtools.primeSession(1)
    harness.detach(1, 'canceled_by_user')

    expect(harness.devtools.isSessionAttached(1)).toBe(false)
  })
})

describe('javascript dialogs', () => {
  it('answers an open dialog and reports what it said', async () => {
    await harness.devtools.readConsole(1, {}, 32_000)
    harness.emit(1, 'Page.javascriptDialogOpening', { message: 'Please select at least one specialist', type: 'alert' })

    const answer = await harness.devtools.handleDialog(1, { action: 'accept' })

    expect(answer.ok).toBe(true)
    expect(answer.result?.text).toContain('Dialog accepted')
    expect(answer.result?.text).toContain('Please select at least one specialist')
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Page.handleJavaScriptDialog', { accept: true })
  })

  it('passes prompt text through and dismisses instead when asked', async () => {
    await harness.devtools.handleDialog(1, { action: 'dismiss', text: 'typed answer' })

    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Page.handleJavaScriptDialog', {
      accept: false,
      promptText: 'typed answer',
    })
  })

  it('rejects a bad action without touching the page', async () => {
    const answer = await harness.devtools.handleDialog(1, { action: 'cancel' })

    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('requires action')
    expect(harness.sendCommand).not.toHaveBeenCalled()
  })

  it('names the no-dialog case instead of leaking a CDP error', async () => {
    harness.sendCommand.mockRejectedValueOnce(new Error('No dialog is showing'))

    const answer = await harness.devtools.handleDialog(1, { action: 'accept' })

    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('No JavaScript dialog is open')
  })
})

describe('page evaluation', () => {
  it('returns the evaluated value and reports exceptions', async () => {
    const answer = await harness.devtools.evaluateInPage(1, { expression: 'document.title' }, 32_000)
    expect(answer.result?.text).toBe('result: {"title":"Example"}')
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Runtime.evaluate', expect.objectContaining({
      expression: 'document.title',
      awaitPromise: true,
      returnByValue: true,
    }))

    harness.sendCommand.mockResolvedValueOnce({ exceptionDetails: { text: 'SyntaxError', exception: { description: 'SyntaxError: unexpected token' } } })
    const thrown = await harness.devtools.evaluateInPage(1, { expression: 'oops(' }, 32_000)
    expect(thrown.result?.text).toContain('exception: SyntaxError: unexpected token')
  })

  it('refuses an empty expression without touching the page', async () => {
    const answer = await harness.devtools.evaluateInPage(1, { expression: '   ' }, 32_000)
    expect(answer.ok).toBe(false)
    expect(harness.sendCommand).not.toHaveBeenCalled()
  })

  it('keeps the nextCursor line when the budget cannot fit the page', async () => {
    // A plain slice at the end used to cut the cursor off, leaving the model a
    // page it could not page past and no sign that entries had been dropped.
    await harness.devtools.readConsole(1, {}, 32_000)
    for (let at = 0; at < 40; at += 1) {
      harness.emit(1, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: `entry-${at}-${'x'.repeat(60)}` }] })
    }

    const page = await harness.devtools.readConsole(1, {}, 600)

    expect(page.ok).toBe(true)
    expect(page.result?.text).toMatch(/nextCursor: \d+/)
    expect(page.result?.text).toContain('omitted')
    expect(page.result!.text.length).toBeLessThanOrEqual(600)

    // Even a budget too small for the summary still keeps the cursor: without
    // it the model has no way to continue and no sign it was dropped.
    const tiny = await harness.devtools.readConsole(1, {}, 90)
    expect(tiny.result?.text).toMatch(/nextCursor: \d+/)
  })

  it('refuses a frame argument instead of letting approval and execution disagree', async () => {
    // `Runtime.evaluate` runs in the main frame context, so a `frame` argument
    // cannot move it. Approval reads `args.frame` to pick the origin it names,
    // so honouring the argument only in approval would show the user one
    // origin while the code ran in another.
    const answer = await harness.devtools.evaluateInPage(1, { expression: 'document.cookie', frame: 3 }, 32_000)

    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('main frame')
    expect(harness.sendCommand).not.toHaveBeenCalled()
  })
})
