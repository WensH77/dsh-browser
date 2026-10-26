// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalCoordinator } from '../src/background/approval-coordinator.ts'

const PROMPT = {
  kind: 'action' as const,
  action: 'browser_click',
  summary: 'Click element [3]',
  origins: ['https://example.com'],
  canTrust: true,
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function harness(delivered = false) {
  const callbacks = {
    deliver: vi.fn(() => delivered),
    notify: vi.fn(),
    clearNotification: vi.fn(),
    expired: vi.fn(),
    resolved: vi.fn(),
  }
  const coordinator = new ApprovalCoordinator(callbacks, 60_000)
  return { callbacks, coordinator }
}

describe('ApprovalCoordinator', () => {
  it('keeps an undelivered approval pending and notifies the user', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abc')
    const { callbacks, coordinator } = harness()
    const pending = coordinator.request(PROMPT, new AbortController().signal, 7, 'session-1')

    expect(callbacks.notify).toHaveBeenCalledWith(expect.objectContaining({
      id: '12345678-1234-4234-8234-123456789abc',
      sessionId: 'session-1',
    }), 7)

    coordinator.respond('12345678-1234-4234-8234-123456789abc', 'allow-once')

    await expect(pending).resolves.toEqual({ status: 'decision', decision: 'allow-once' })
    expect(callbacks.clearNotification).toHaveBeenCalledWith('12345678-1234-4234-8234-123456789abc')
    expect(callbacks.resolved).toHaveBeenCalledWith('12345678-1234-4234-8234-123456789abc')
  })

  it('waits for the full approval window before timing out', async () => {
    vi.useFakeTimers()
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abd')
    const { coordinator } = harness()
    const pending = coordinator.request(PROMPT, new AbortController().signal, 7)

    await vi.advanceTimersByTimeAsync(59_999)
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toEqual({ status: 'timed-out' })
  })

  it('turns an expired reminder into an expired note instead of clearing it', async () => {
    vi.useFakeTimers()
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789aba')
    const { callbacks, coordinator } = harness()
    const pending = coordinator.request(PROMPT, new AbortController().signal, 7)

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(pending).resolves.toEqual({ status: 'timed-out' })

    // The reminder is kept and re-labelled, so a user who comes back later can
    // still see that a prompt was missed; clearing it here was the old behaviour.
    // The window id travels with it: the pending entry is gone, and a click on
    // that note still has to reach the right window.
    expect(callbacks.expired).toHaveBeenCalledWith(expect.objectContaining({
      id: '12345678-1234-4234-8234-123456789aba',
    }), 7)
    expect(callbacks.clearNotification).not.toHaveBeenCalled()
    expect(callbacks.resolved).toHaveBeenCalledWith('12345678-1234-4234-8234-123456789aba')
  })

  it('cancels a pending approval when its tool call is withdrawn', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abe')
    const { coordinator } = harness(true)
    const abort = new AbortController()
    const pending = coordinator.request(PROMPT, abort.signal, 7)

    abort.abort()

    await expect(pending).resolves.toEqual({ status: 'cancelled' })
  })

  it('cancels approvals only for the requested session', async () => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('12345678-1234-4234-8234-123456789ab1')
      .mockReturnValueOnce('12345678-1234-4234-8234-123456789ab2')
    const { coordinator } = harness(true)
    const sessionOne = coordinator.request(PROMPT, new AbortController().signal, 7, 'session-1')
    const sessionTwo = coordinator.request(PROMPT, new AbortController().signal, 7, 'session-2')

    coordinator.cancelAll('session-2')
    coordinator.respond('12345678-1234-4234-8234-123456789ab1', 'allow-once')

    await expect(sessionOne).resolves.toEqual({ status: 'decision', decision: 'allow-once' })
    await expect(sessionTwo).resolves.toEqual({ status: 'cancelled' })
  })
})
