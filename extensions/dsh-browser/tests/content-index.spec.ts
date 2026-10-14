// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const LISTENER_KEY = '__dshBrowserContentScriptListener__'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[LISTENER_KEY]
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('content script registration', () => {
  it('replaces a stale listener when content.js is injected again', async () => {
    const addListener = vi.fn()
    const removeListener = vi.fn()
    const sendMessage = vi.fn(async () => undefined)
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener, removeListener }, sendMessage },
    })

    await import('../src/content/index.ts')
    expect(addListener).toHaveBeenCalledTimes(1)
    expect(removeListener).not.toHaveBeenCalled()
    const firstListener = addListener.mock.calls[0]?.[0]

    vi.resetModules()
    await import('../src/content/index.ts')

    expect(removeListener).toHaveBeenCalledWith(firstListener)
    expect(addListener).toHaveBeenCalledTimes(2)
    expect(addListener.mock.calls[1]?.[0]).not.toBe(firstListener)
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage).toHaveBeenLastCalledWith({ type: 'DSH_CONTENT_READY' })
  })

  it('appends the tab state to a result when the page is not being looked at', async () => {
    const addListener = vi.fn()
    const sendMessage = vi.fn(async () => undefined)
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener, removeListener: vi.fn() }, sendMessage },
    })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    // jsdom reports `hasFocus() === false` by default, which would name both
    // conditions; pin the focused side so this test asserts the hidden one alone.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)

    await import('../src/content/index.ts')
    const listener = addListener.mock.calls[0]?.[0] as (
      message: unknown,
      sender: unknown,
      sendResponse: (response: { ok: boolean; result?: { text: string } }) => void,
    ) => void
    const answer = await new Promise<{ ok: boolean; result?: { text: string } }>((resolve) => {
      listener({ type: 'DSH_ACTION', action: 'browser_scroll', args: { direction: 'down' } }, {}, resolve)
    })

    // The tab's own state is what explains an action that reports success and changes
    // nothing, so it travels with the result instead of waiting to be asked for.
    expect(answer.ok).toBe(true)
    expect(answer.result?.text).toContain('The controlled tab is hidden.')
  })
})
