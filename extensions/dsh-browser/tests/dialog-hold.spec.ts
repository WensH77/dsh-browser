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
}

const TAB = { id: 1, url: 'https://d15a.intranet-v2.test15.tbeng.pro/project-management/266984' }
const OK = { ok: true, result: { text: 'page' } }
const SNAPSHOT = { id: 'tool-1', name: 'browser_snapshot', args: {} }

async function loadHarness(): Promise<Harness> {
  const eventListeners: Array<(source: { tabId?: number }, method: string, params?: object) => void> = []
  const sendMessage = vi.fn(async () => OK)
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => [TAB]),
      sendMessage,
    },
    scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]) },
    webNavigation: { getAllFrames: vi.fn(async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-1', url: TAB.url }]) },
    debugger: {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async (_target: unknown, method: string) => {
        if (method === 'Runtime.evaluate') return { result: { value: 'ok' } }
        return {}
      }),
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
