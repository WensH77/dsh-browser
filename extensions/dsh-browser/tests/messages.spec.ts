// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendUiRequest } from '../src/shared/messages.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('sendUiRequest', () => {
  it('names the request and the failure when the background does not answer', async () => {
    // Chrome reports this as "The message port closed before a response was
    // received", which hides both which request died and whose side stalled.
    vi.stubGlobal('chrome', {
      runtime: {
        lastError: { message: 'The message port closed before a response was received.' },
        sendMessage: (_message: unknown, callback: (response: unknown) => void) => { callback(undefined) },
      },
    })

    await expect(sendUiRequest({ type: 'settings.get' }))
      .rejects.toThrow('"settings.get" failed: The message port closed before a response was received.')
  })

  it('gives up on its own when the background never calls back', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('chrome', { runtime: { lastError: undefined, sendMessage: () => {} } })

    const pending = sendUiRequest({ type: 'ui.state' })
    const assertion = expect(pending).rejects.toThrow('The background did not answer "ui.state"')
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
  })

  it('passes an answer through untouched', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        lastError: undefined,
        sendMessage: (_message: unknown, callback: (response: unknown) => void) => { callback({ bridgeState: 'connected' }) },
      },
    })

    await expect(sendUiRequest({ type: 'ui.state' })).resolves.toEqual({ bridgeState: 'connected' })
  })
})
