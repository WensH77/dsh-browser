import { describe, expect, it, vi } from 'vitest'
import { listRunningSessions, type TypertGatewayLike } from '../src/remote-host-api.ts'

/** Fake gateway returning a canned session.list projection. */
function fakeGateway(value: unknown, fail = false): { gateway: TypertGatewayLike; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async (request: { namespace: string; method: string }) => {
    if (fail) throw new Error('gateway down')
    return request.method === 'list' ? value : undefined
  })
  return { gateway: { invoke }, invoke }
}

describe("listRunningSessions (the bridge's only Host interaction)", () => {
  it('returns well-formed rows from the session.list projection', async () => {
    const { gateway, invoke } = fakeGateway({
      items: [
        { sessionId: 's-1', running: true },
        { sessionId: 's-2', running: false },
      ],
    })
    const signal = new AbortController().signal
    await expect(listRunningSessions(gateway, signal)).resolves.toEqual([
      { sessionId: 's-1', running: true },
      { sessionId: 's-2', running: false },
    ])
    expect(invoke).toHaveBeenCalledWith({
      namespace: 'session',
      method: 'list',
      args: { _request: {} },
      signal,
    })
  })

  it('skips malformed rows instead of failing the guard', async () => {
    const { gateway } = fakeGateway({
      items: [
        { sessionId: 's-1', running: true },
        { running: true },
        { sessionId: 's-2' },
        null,
        'junk',
        { sessionId: 42, running: false },
      ],
    })
    await expect(listRunningSessions(gateway, new AbortController().signal)).resolves.toEqual([
      { sessionId: 's-1', running: true },
    ])
  })

  it('rejects listings that are not objects with an items array', async () => {
    for (const bad of [undefined, null, [], { items: 'nope' }]) {
      const { gateway } = fakeGateway(bad)
      await expect(listRunningSessions(gateway, new AbortController().signal))
        .rejects.toThrow('session.list returned an invalid listing')
    }
  })

  it('propagates gateway failures so the purge guard can fall back', async () => {
    const { gateway } = fakeGateway(undefined, true)
    await expect(listRunningSessions(gateway, new AbortController().signal))
      .rejects.toThrow('gateway down')
  })
})
