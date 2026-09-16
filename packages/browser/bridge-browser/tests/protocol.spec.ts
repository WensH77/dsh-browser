import { describe, expect, it } from 'vitest'
import {
  BRIDGE_PROTO,
  BRIDGE_TOOLSET,
  declaredProto,
  declaredToolset,
  handshakeRefusal,
  isServerFrame,
  parseBridgeFrame,
} from '../src/protocol.ts'

describe('parseBridgeFrame', () => {
  it('parses a valid hello frame', () => {
    const frame = parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'abc123', caps: { proto: BRIDGE_PROTO, toolset: BRIDGE_TOOLSET, debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } }))
    expect(frame).toEqual({ t: 'hello', token: 'abc123', caps: { proto: BRIDGE_PROTO, toolset: BRIDGE_TOOLSET, debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
  })

  it('accepts a hello from a build that predates proto/toolset', () => {
    const frame = parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'abc123', caps: { debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } }))
    expect(frame).toEqual({ t: 'hello', token: 'abc123', caps: { debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    expect(declaredProto(frame?.t === 'hello' ? frame.caps : undefined)).toBe(1)
    expect(declaredToolset(frame?.t === 'hello' ? frame.caps : undefined)).toBe(0)
  })

  it('drops a hello whose version fields are not usable integers', () => {
    const caps = { snapshotMaxChars: 500, maxInteractiveItems: 10 }
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { ...caps, proto: 1.5 } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { ...caps, proto: 0 } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { ...caps, proto: '2' } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { ...caps, toolset: -1 } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { ...caps, toolset: 1.5 } }))).toBeUndefined()
  })

  it('refuses only a peer that speaks a newer protocol', () => {
    const caps = { snapshotMaxChars: 500, maxInteractiveItems: 10 }
    expect(handshakeRefusal(caps)).toBeUndefined()
    expect(handshakeRefusal({ ...caps, proto: BRIDGE_PROTO })).toBeUndefined()
    const refusal = handshakeRefusal({ ...caps, proto: BRIDGE_PROTO + 1 })
    expect(refusal).toContain('restart dsh')
    expect(refusal).toContain(String(BRIDGE_PROTO + 1))
    // The reason travels in a WebSocket close reason: 123 bytes is the hard cap.
    expect(Buffer.byteLength(refusal ?? '', 'utf8')).toBeLessThanOrEqual(123)
  })

  it('accepts an extension that reports no debug capability', () => {
    const frame = parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'abc123', caps: { snapshotMaxChars: 12000, maxInteractiveItems: 60 } }))
    expect(frame).toEqual({ t: 'hello', token: 'abc123', caps: { snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
  })

  it('rejects hello with wrong caps shape', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { debugger: 'yes', snapshotMaxChars: 500, maxInteractiveItems: 10 } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { debugger: true } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { debugger: true, snapshotMaxChars: 0, maxInteractiveItems: 10 } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { debugger: true, snapshotMaxChars: 499, maxInteractiveItems: 10 } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x' }))).toBeUndefined()
  })

  it('parses rpc and tool frames', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc', id: '1', method: 'session.list', payload: {} })))
      .toEqual({ t: 'rpc', id: '1', method: 'session.list', payload: {} })
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: '2', ok: true, result: { text: 'ok' } })))
      .toEqual({ t: 'tool.result', id: '2', ok: true, result: { text: 'ok' } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: '3', ok: false, error: { code: 'timeout', message: 'm' } })))
      .toEqual({ t: 'tool.result', id: '3', ok: false, error: { code: 'timeout', message: 'm' } })
  })

  it('parses server-side frames the extension receives', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello.ok', caps: { debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })))
      .toEqual({ t: 'hello.ok', caps: { debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '4', name: 'browser_click', args: { index: 1 }, expiresAt: 123, sessionId: 'session-1' })))
      .toEqual({ t: 'tool.call', id: '4', name: 'browser_click', args: { index: 1 }, expiresAt: 123, sessionId: 'session-1' })
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.cancel', id: '4' })))
      .toEqual({ t: 'tool.cancel', id: '4' })
  })

  it('parses rpc.result success and error forms', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc.result', id: '1', ok: true, result: { x: 1 } })))
      .toEqual({ t: 'rpc.result', id: '1', ok: true, result: { x: 1 } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc.result', id: '1', ok: false, error: { code: 'http', message: 'boom' } })))
      .toEqual({ t: 'rpc.result', id: '1', ok: false, error: { code: 'http', message: 'boom' } })
    // ok:true without result, and ok:false without error, are malformed.
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc.result', id: '1', ok: true }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc.result', id: '1', ok: false }))).toBeUndefined()
  })

  it('parses ping and pong frames', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'ping' }))).toEqual({ t: 'ping' })
    expect(parseBridgeFrame(JSON.stringify({ t: 'pong' }))).toEqual({ t: 'pong' })
  })

  it('classifies frames by sender side', () => {
    const server = parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'browser_click', args: {}, expiresAt: 123 }))!
    const client = parseBridgeFrame(JSON.stringify({ t: 'hello', token: 't', caps: { debugger: true, snapshotMaxChars: 500, maxInteractiveItems: 10 } }))!
    expect(isServerFrame(server)).toBe(true)
    expect(isServerFrame(client)).toBe(false)
    for (const t of ['hello.ok', 'rpc.result', 'tool.call', 'tool.cancel', 'ping'] as const) {
      const frame = parseBridgeFrame(JSON.stringify(serverShape(t)))!
      expect(isServerFrame(frame)).toBe(true)
    }
  })

  it('rejects malformed payloads', () => {
    expect(parseBridgeFrame('not json')).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify(null))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify([1, 2]))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({}))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'nope' }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc', id: 5, method: 'x' }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: '1', ok: true }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: 5, ok: true, result: {} }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc.result', id: 5, ok: true, result: {} }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello.ok', caps: { debugger: true } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'x', args: [] }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'x', args: {} }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'x', args: {}, expiresAt: Number.POSITIVE_INFINITY }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'x', args: {}, expiresAt: 123, sessionId: '' }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.cancel', id: 1 }))).toBeUndefined()
  })
})

/** Minimal valid shape per server-side frame type (for classification tests). */
function serverShape(t: 'hello.ok' | 'rpc.result' | 'tool.call' | 'tool.cancel' | 'ping'): Record<string, unknown> {
  switch (t) {
    case 'hello.ok': return { t, caps: { debugger: true, snapshotMaxChars: 500, maxInteractiveItems: 10 } }
    case 'rpc.result': return { t, id: '1', ok: true, result: {} }
    case 'tool.call': return { t, id: '1', name: 'x', args: {}, expiresAt: 123 }
    case 'tool.cancel': return { t, id: '1' }
    case 'ping': return { t }
  }
}
