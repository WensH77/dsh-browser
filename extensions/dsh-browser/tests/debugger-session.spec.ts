// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireDebuggerSession,
  debuggerSessionHeld,
  forgetDebuggerSession,
  holdDebuggerSession,
  releaseDebuggerSession,
  resetDebuggerSessionsForTest,
  visionAvailable,
} from '../src/background/debugger-session.ts'

interface Mock {
  attach: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  sendCommand: ReturnType<typeof vi.fn>
  getTargets: ReturnType<typeof vi.fn>
}

function mockDebugger(overrides: {
  attachError?: Error
  failures?: Record<string, Error>
  targets?: unknown[]
} = {}): Mock {
  const attach = vi.fn(async () => {
    if (overrides.attachError !== undefined) throw overrides.attachError
  })
  const detach = vi.fn(async () => undefined)
  const sendCommand = vi.fn(async (_target: unknown, method: string) => {
    const failure = overrides.failures?.[method]
    if (failure !== undefined) throw failure
    return {}
  })
  const getTargets = vi.fn(async () => overrides.targets ?? [])
  vi.stubGlobal('chrome', { debugger: { attach, detach, sendCommand, getTargets } })
  return { attach, detach, sendCommand, getTargets }
}

afterEach(() => {
  resetDebuggerSessionsForTest()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('acquireDebuggerSession', () => {
  it('attaches once, enables the asked-for domains, and detaches when released', async () => {
    const mock = mockDebugger()

    const lease = await acquireDebuggerSession(7, { runtime: true, network: true })
    expect(mock.attach).toHaveBeenCalledTimes(1)
    expect(mock.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3')
    expect(mock.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Runtime.enable')
    expect(mock.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Network.enable')
    expect(mock.sendCommand).not.toHaveBeenCalledWith({ tabId: 7 }, 'Log.enable')
    expect(debuggerSessionHeld(7)).toBe(true)

    await lease.release()
    expect(mock.detach).toHaveBeenCalledWith({ tabId: 7 })
    expect(debuggerSessionHeld(7)).toBe(false)
  })

  it('reuses a session this extension already holds, without a second attach', async () => {
    // The regression this module exists for: priming holds the tab, then a
    // capture asked Chrome for a second client and got "Another debugger…".
    const mock = mockDebugger()
    await holdDebuggerSession(7, { runtime: true, log: true, network: true })
    expect(mock.attach).toHaveBeenCalledTimes(1)

    const lease = await acquireDebuggerSession(7)
    expect(mock.attach).toHaveBeenCalledTimes(1)

    await lease.release()
    // The buffer hold is still using the session, so nothing may detach.
    expect(mock.detach).not.toHaveBeenCalled()
    expect(debuggerSessionHeld(7)).toBe(true)

    await releaseDebuggerSession(7)
    expect(mock.detach).toHaveBeenCalledWith({ tabId: 7 })
  })

  it('detaches once the last lease is gone, whatever order they release', async () => {
    const mock = mockDebugger()
    const hold = await acquireDebuggerSession(7, { network: true })
    const shot = await acquireDebuggerSession(7)

    // The buffer hold lets go first: the screenshot still holds the session.
    await hold.release()
    expect(mock.detach).not.toHaveBeenCalled()
    await shot.release()
    expect(mock.detach).toHaveBeenCalledTimes(1)
    expect(debuggerSessionHeld(7)).toBe(false)
  })

  it('treats Chrome\'s "already attached" as our own session', async () => {
    // Chrome returns this only from FindClientHost (same extension, same
    // target), so the session is ours to reuse.
    const mock = mockDebugger({ attachError: new Error('Another debugger is already attached to the tab with id: 7') })

    const lease = await acquireDebuggerSession(7, { network: true })

    expect(mock.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Network.enable')
    await lease.release()
    expect(mock.detach).toHaveBeenCalledWith({ tabId: 7 })
  })

  it('names a foreign debugger when another client holds the tab', async () => {
    mockDebugger({
      attachError: new Error('Cannot attach to this target.'),
      targets: [{ id: 't', tabId: 7, attached: true, type: 'page', title: 'x', url: 'https://app.example/' }],
    })

    await expect(acquireDebuggerSession(7)).rejects.toMatchObject({
      code: 'action-failed',
      reason: 'foreign-debugger',
      message: expect.stringContaining('DevTools'),
    })
  })

  it('keeps the protected-page copy when nothing is attached to the tab', async () => {
    mockDebugger({ attachError: new Error('Cannot attach to this target.'), targets: [] })

    await expect(acquireDebuggerSession(7)).rejects.toMatchObject({ code: 'unsupported', reason: 'restricted-page' })
  })

  it('forgets a reused session that turns out to be gone', async () => {
    const failures: Record<string, Error> = { 'Network.enable': new Error('Debugger is not attached to the tab with id: 7.') }
    const mock = mockDebugger({ failures })

    await expect(acquireDebuggerSession(7, { network: true })).rejects.toMatchObject({ reason: 'detached' })

    // The phantom hold must not survive, or every later call would reuse it.
    expect(debuggerSessionHeld(7)).toBe(false)
    delete failures['Network.enable']
    const lease = await acquireDebuggerSession(7, { network: true })
    // A fresh attach, not a reuse of the session that just proved dead.
    expect(mock.attach).toHaveBeenCalledTimes(2)
    await lease.release()
  })

  it('reports a build without chrome.debugger', async () => {
    vi.stubGlobal('chrome', {})
    expect(visionAvailable()).toBe(false)
    await expect(acquireDebuggerSession(7)).rejects.toMatchObject({ code: 'unsupported', reason: 'unsupported' })
  })

  it('lets a caller drop the bookkeeping Chrome already ended', async () => {
    mockDebugger()
    await holdDebuggerSession(7, { network: true })
    expect(debuggerSessionHeld(7)).toBe(true)

    forgetDebuggerSession(7)

    expect(debuggerSessionHeld(7)).toBe(false)
  })
})
