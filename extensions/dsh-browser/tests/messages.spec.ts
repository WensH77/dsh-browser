// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendUiRequest, sessionGrantsPush } from '../src/shared/messages.ts'

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

describe('sessionGrantsPush', () => {
  const grants = [{ action: 'browser_network', key: 'browser_network#mock', grantedAt: 5 }]

  it('carries the session and the grant keys the panel lists', () => {
    expect(sessionGrantsPush('session-a', grants)).toEqual({
      type: 'push.session-grants',
      sessionId: 'session-a',
      grants,
    })
  })

  it('carries the revocation only when there is one', () => {
    // A frame without a revocation means a grant was added: the panel reads the
    // absence as "the previous explanation is stale" and clears it.
    expect(sessionGrantsPush('session-a', [], { reason: 'rebind', count: 1 })).toEqual({
      type: 'push.session-grants',
      sessionId: 'session-a',
      grants: [],
      revocation: { reason: 'rebind', count: 1 },
    })
    expect(sessionGrantsPush('session-a', grants)).not.toHaveProperty('revocation')
  })
})
