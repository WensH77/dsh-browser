// @vitest-environment jsdom
/**
 * A page's own `alert`/`confirm`/`prompt` freezes its renderer, so a page-facing
 * tool call that goes out while one is open waits on it — in the field, 69s on a
 * `browser_type` and 80s on a `browser_get_text` against a 90s per-call budget,
 * with the model unable to see past the call to answer the dialog. These tests
 * pin the refusal that replaces that wait, and the tools that stay usable.
 *
 * Modules are reloaded per test because the dialog state, the tab sessions and
 * the CDP listener all live at module scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDebuggerSessionsForTest } from '../src/background/debugger-session.ts'

type Devtools = typeof import('../src/background/devtools.ts')
type Tools = typeof import('../src/background/tools.ts')

interface Harness {
  devtools: Devtools
  tools: Tools
  emit: (tabId: number, method: string, params?: object) => void
  sendMessage: ReturnType<typeof vi.fn>
  sendCommand: ReturnType<typeof vi.fn>
  getAllFrames: ReturnType<typeof vi.fn>
}

const TAB = { id: 1, url: 'https://d15a.intranet-v2.test15.tbeng.pro/project-management/266984' }
const OK = { ok: true, result: { text: 'page' } }
const SNAPSHOT = { id: 'tool-1', name: 'browser_snapshot', args: {} }

async function loadHarness(): Promise<Harness> {
  const eventListeners: Array<(source: { tabId?: number }, method: string, params?: object) => void> = []
  const sendMessage = vi.fn(async () => OK)
  const sendCommand = vi.fn(async (_target: unknown, method: string) => {
    if (method === 'Runtime.evaluate') return { result: { value: 'ok' } }
    return {}
  })
  const getAllFrames = vi.fn(async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-1', url: TAB.url }])
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => [TAB]),
      sendMessage,
    },
    scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]) },
    webNavigation: { getAllFrames },
    debugger: {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand,
      onEvent: { addListener: (listener: (typeof eventListeners)[number]) => eventListeners.push(listener) },
      onDetach: { addListener: vi.fn() },
    },
  })
  vi.resetModules()
  const devtools = await import('../src/background/devtools.ts')
  const tools = await import('../src/background/tools.ts')
  return {
    devtools,
    tools,
    sendMessage,
    sendCommand,
    getAllFrames,
    emit: (tabId, method, params) => { for (const listener of eventListeners) listener({ tabId }, method, params) },
  }
}

let harness: Harness

beforeEach(async () => {
  resetDebuggerSessionsForTest()
  harness = await loadHarness()
  await harness.devtools.primeSession(1)
})

afterEach(() => {
  resetDebuggerSessionsForTest()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const openDialog = (message: string, type = 'alert'): void => {
  harness.emit(1, 'Page.javascriptDialogOpening', { message, type })
}

const dispatch = (name: string, args: Record<string, unknown> = {}) =>
  harness.tools.dispatchToolCall({ id: 'tool-1', name, args }, 'auto', undefined, undefined, undefined, TAB)

describe('a dialog holds back page-facing tools', () => {
  it('refuses the call, quotes the dialog, and names browser_dialog', async () => {
    openDialog('Please enter a duration')

    const answer = await dispatch(SNAPSHOT.name)

    expect(answer.error?.code).toBe('content-unavailable')
    expect(answer.error?.message).toContain('A JavaScript alert is open on this page')
    expect(answer.error?.message).toContain('It says: "Please enter a duration".')
    expect(answer.error?.message).toContain('browser_dialog')
    // The point of the change: the page was never asked, so nothing waited.
    expect(harness.sendMessage).not.toHaveBeenCalled()
  })

  it('refuses before asking the user to approve an action that cannot run', async () => {
    openDialog('Please enter a duration')
    const authorize = vi.fn(async () => 'approved' as const)

    const answer = await harness.tools.dispatchToolCall(
      { id: 'tool-1', name: 'browser_click', args: { index: 2 } },
      'auto',
      undefined,
      authorize,
      undefined,
      TAB,
    )

    expect(answer.error?.message).toContain('Please enter a duration')
    expect(authorize).not.toHaveBeenCalled()
  })

  it('keeps a confirm, which carries a choice, for the model to read', async () => {
    openDialog('Discard your changes?', 'confirm')

    const answer = await dispatch(SNAPSHOT.name)

    expect(answer.error?.message).toContain('A JavaScript confirm is open')
    expect(answer.error?.message).toContain('Discard your changes?')
  })

  it('names the dialog without inventing a message when the page sent none', async () => {
    openDialog('')

    const answer = await dispatch(SNAPSHOT.name)

    expect(answer.error?.message).toContain('A JavaScript alert is open on this page')
    expect(answer.error?.message).not.toContain('It says:')
  })

  it('lets the call through again once Chrome reports the dialog closed', async () => {
    openDialog('Please enter a duration')
    harness.emit(1, 'Page.javascriptDialogClosed', {})

    const answer = await dispatch(SNAPSHOT.name)

    expect(answer.ok).toBe(true)
    expect(harness.sendMessage).toHaveBeenCalled()
  })
})

describe('what stays usable while the page is frozen', () => {
  it('still answers browser_dialog, and that clears the hold', async () => {
    openDialog('Please enter a duration')

    const answered = await harness.tools.dispatchToolCall(
      { id: 'tool-1', name: 'browser_dialog', args: { action: 'accept' } },
      'auto',
      undefined,
      async () => 'approved',
      undefined,
      TAB,
    )
    expect(answered.ok).toBe(true)
    expect((answered.result as { text: string }).text).toContain('Please enter a duration')

    const next = await dispatch(SNAPSHOT.name)
    expect(next.ok).toBe(true)
  })

  it('still serves the console buffer, which is where the dialog is logged', async () => {
    openDialog('Please enter a duration')

    const answer = await dispatch('browser_console', {})

    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('[dialog:alert] Please enter a duration')
  })
})

describe('a dialog that opens while a call is already running', () => {
  /** A page action whose renderer never answers, as a dialog-frozen one is. */
  const hangThePage = (): void => {
    harness.sendMessage.mockImplementationOnce(() => new Promise(() => {}))
  }

  it('cuts the call off, quotes the dialog, and says not to repeat it', async () => {
    hangThePage()
    const pending = dispatch('browser_get_text', {})
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1))

    openDialog('Please select at least one specialist')

    const answer = await pending
    expect(answer.error?.code).toBe('content-unavailable')
    expect(answer.error?.message).toContain('while this call was running')
    expect(answer.error?.message).toContain('It says: "Please select at least one specialist".')
    expect(answer.error?.message).toContain('browser_dialog')
    expect(answer.error?.message).toContain('repeating it blindly could run it twice')
    // This is the half that differs from the hold: the action was already out,
    // so the answer may not claim nothing happened.
    expect(answer.error?.message).not.toContain('did not run')
  })

  it('cuts off a browser_eval the dialog froze mid-expression', async () => {
    // The measured shape: the expression runs `button.click()`, the page's own
    // alert opens, and `Runtime.evaluate` does not come back until it is
    // answered. That call used to hold the whole turn with no signal at all.
    harness.sendCommand.mockImplementation((_target: unknown, method: string) => (
      method === 'Runtime.evaluate' ? new Promise(() => {}) : Promise.resolve({})
    ))
    const pending = harness.tools.dispatchToolCall(
      { id: 'tool-1', name: 'browser_eval', args: { expression: 'document.querySelector("button").click()' } },
      'auto',
      undefined,
      async () => 'approved',
      undefined,
      TAB,
    )
    await vi.waitFor(() => expect(harness.sendCommand.mock.calls.some(([, method]) => method === 'Runtime.evaluate')).toBe(true))

    openDialog('Please select at least one specialist')

    const answer = await pending
    expect(answer.error?.code).toBe('content-unavailable')
    expect(answer.error?.message).toContain('while this call was running')
    expect(answer.error?.message).toContain('It says: "Please select at least one specialist".')
    expect(answer.error?.message).toContain('browser_dialog')
  })

  it('leaves a call on another tab waiting', async () => {
    // Both tabs need a session: the CDP router drops events for a tab it never
    // primed, so an unprimed second tab would make this test prove nothing.
    await harness.devtools.primeSession(2)
    hangThePage()
    const pending = dispatch('browser_get_text', {})
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1))

    harness.emit(2, 'Page.javascriptDialogOpening', { message: 'another tab', type: 'alert' })
    const early = await Promise.race([
      pending.then(() => 'settled'),
      new Promise((resolve) => { setTimeout(() => resolve('waiting'), 10) }),
    ])
    expect(early).toBe('waiting')

    harness.emit(1, 'Page.javascriptDialogOpening', { message: 'this tab', type: 'alert' })
    const answer = await pending
    expect(answer.error?.message).toContain('It says: "this tab".')
  })

  it('does not cut it off for the beforeunload dialog it answers by itself', async () => {
    let release!: (value: unknown) => void
    harness.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const pending = dispatch('browser_get_text', {})
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1))

    harness.emit(1, 'Page.javascriptDialogOpening', { message: '系统可能不会保存您所做的更改。', type: 'beforeunload' })
    harness.emit(1, 'Page.javascriptDialogClosed', {})
    release(OK)

    const answer = await pending
    expect(answer.ok).toBe(true)
  })

  it('says nothing ran when the dialog was already open before the action left', async () => {
    // The approval card can sit on screen for seconds, and the page may raise
    // its own dialog while it waits: the dispatcher's hold check ran before the
    // prompt, so the send is the first place that sees this one. Nothing has
    // gone out at that point, so the answer may not say an action is underway.
    const answer = await harness.tools.dispatchToolCall(
      { id: 'tool-1', name: 'browser_press', args: { key: 'Escape' } },
      'auto',
      undefined,
      async () => {
        openDialog('Please select at least one specialist')
        return 'approved'
      },
      undefined,
      TAB,
    )

    expect(answer.error?.code).toBe('content-unavailable')
    expect(answer.error?.message).toContain('so this call did not run')
    expect(answer.error?.message).toContain('It says: "Please select at least one specialist".')
    expect(answer.error?.message).not.toContain('repeating it blindly')
    expect(harness.sendMessage).not.toHaveBeenCalled()
  })

  it('lets the call through when only a beforeunload is pending before the send', async () => {
    const answer = await harness.tools.dispatchToolCall(
      { id: 'tool-1', name: 'browser_press', args: { key: 'Escape' } },
      'auto',
      undefined,
      async () => {
        harness.emit(1, 'Page.javascriptDialogOpening', { message: '系统可能不会保存您所做的更改。', type: 'beforeunload' })
        return 'approved'
      },
      undefined,
      TAB,
    )

    // The extension answers that one itself, so it must not become an interrupt
    // naming a dialog that is already being closed.
    expect(answer.ok).toBe(true)
    expect(harness.sendMessage).toHaveBeenCalled()
  })

  it('names the dialog when an iframe raised it after the main frame answered', async () => {
    harness.getAllFrames.mockImplementation(async () => [
      { frameId: 0, parentFrameId: -1, documentId: 'document-1', url: TAB.url },
      { frameId: 1, parentFrameId: 0, documentId: 'document-iframe', url: 'https://frame.example/' },
    ])
    harness.sendMessage.mockImplementation((_tab: unknown, _message: unknown, options?: { documentId?: string }) => (
      options?.documentId === 'document-iframe' ? new Promise(() => {}) : Promise.resolve(OK)
    ))

    const pending = dispatch('browser_snapshot', { visual: false })
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(2))

    openDialog('Please select at least one specialist')

    const answer = await pending
    expect(answer.error?.message).toContain('It says: "Please select at least one specialist".')
    // A frozen tab is not an inaccessible iframe.
    expect(answer.error?.message).not.toContain('inaccessible')
  })
})
