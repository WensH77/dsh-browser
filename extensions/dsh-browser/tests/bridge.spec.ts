// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROTO, BRIDGE_TOOLSET } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { BridgeClient, handshakeNotice, type BridgeNotice, type BridgeState } from '../src/background/bridge.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  /** Every frame this socket was asked to send, for handshake assertions. */
  readonly sent: string[] = []

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(data?: unknown): void {
    if (typeof data === 'string') this.sent.push(data)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('BridgeClient connection probe', () => {
  it('waits without opening a WebSocket while the local bridge is unavailable', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const probe = vi.fn(async () => false)
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
      onNotice: () => {},
    }, probe)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)

    expect(probe).toHaveBeenCalledOnce()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(states.at(-1)).toBe('reconnecting')
    client.stop()
  })

  it('opens the WebSocket after the probe succeeds', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new BridgeClient({
      onStateChange: () => {},
      onFrame: () => {},
      onHelloOk: () => {},
      onNotice: () => {},
    }, async () => true)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)

    expect(FakeWebSocket.instances).toHaveLength(1)
    client.stop()
  })

  it('does not retry after the bridge explicitly replaces this connection', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
      onNotice: () => {},
    })

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    socket.receive({
      t: 'hello.ok',
      caps: { proto: 2, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe('connected')

    socket.close(4000, 'replaced')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe('BridgeClient handshake version', () => {
  it('declares the protocol and toolset it speaks, with no legacy marker', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new BridgeClient({ onStateChange: () => {}, onFrame: () => {}, onHelloOk: () => {}, onNotice: () => {} })

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(0)

    const hello = JSON.parse(socket.sent[0]!) as { t: string; caps: Record<string, unknown> }
    expect(hello.t).toBe('hello')
    expect(hello.caps.proto).toBe(BRIDGE_PROTO)
    expect(hello.caps.toolset).toBe(BRIDGE_TOOLSET)
    expect(Object.keys(hello.caps)).not.toContain('textOnly')
    client.stop()
  })

  it('surfaces the host\'s refusal reason instead of failing silently', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const notices: Array<BridgeNotice | null> = []
    const client = new BridgeClient({
      onStateChange: () => {},
      onFrame: () => {},
      onHelloOk: () => {},
      onNotice: (notice) => { notices.push(notice) },
    })

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    socket.close(4003, 'restart dsh: extension bridge protocol 3 is newer')
    await vi.advanceTimersByTimeAsync(0)

    expect(notices.at(-1)).toEqual({
      kind: 'host-rejected',
      detail: 'restart dsh: extension bridge protocol 3 is newer',
    })
    client.stop()
  })

  it('reports a host that never acknowledges the hello, and clears it on the next success', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const notices: Array<BridgeNotice | null> = []
    const client = new BridgeClient({
      onStateChange: () => {},
      onFrame: () => {},
      onHelloOk: () => {},
      onNotice: (notice) => { notices.push(notice) },
    })

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const first = FakeWebSocket.instances[0]!
    first.open()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(notices.at(-1)).toEqual({ kind: 'host-silent', detail: 'no hello.ok within 5s' })

    // A host that does answer clears the warning.
    await vi.advanceTimersByTimeAsync(30_000)
    const second = FakeWebSocket.instances.at(-1)!
    second.open()
    await vi.advanceTimersByTimeAsync(0)
    second.receive({ t: 'hello.ok', caps: { proto: BRIDGE_PROTO, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    expect(notices.at(-1)).toBeNull()
    client.stop()
  })

  it('turn a failed handshake into one actionable notice', () => {
    expect(handshakeNotice(undefined, true)).toEqual({ kind: 'host-silent', detail: 'no hello.ok within 5s' })
    expect(handshakeNotice(undefined, false)).toEqual({ kind: 'host-silent', detail: 'the socket closed before hello.ok' })
    expect(handshakeNotice({ code: 1008, reason: 'unparseable frame' }, false))
      .toEqual({ kind: 'host-silent', detail: 'closed with 1008 unparseable frame' })
    expect(handshakeNotice({ code: 4003, reason: 'restart dsh' }, false))
      .toEqual({ kind: 'host-rejected', detail: 'restart dsh' })
  })
})
