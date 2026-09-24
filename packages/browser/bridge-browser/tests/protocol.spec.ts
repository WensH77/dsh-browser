import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BRIDGE_EXTENSION_IDS,
  BRIDGE_PROTO,
  BRIDGE_TOOLSET,
  EXTENSION_ID_PATTERN,
  LEGACY_TOOLSET,
  declaredProto,
  declaredToolset,
  formatBindableTab,
  handshakeRefusal,
  isServerFrame,
  parseBindableTabs,
  parseBridgeFrame,
} from '../src/protocol.ts'

describe('bindable tab lines', () => {
  // The extension renders these lines and the host parses them back. When the
  // two drifted, the host silently produced an empty list and the model
  // reported "no bindable pages are open" instead of a parse miss.
  it('round-trips the lines the extension renders', () => {
    const lines = [
      formatBindableTab({ id: 5, title: 'Inbox — mail', url: 'https://mail.example/inbox' }),
      formatBindableTab({ id: 9, title: '', url: 'https://example.com/' }),
      formatBindableTab({ id: 11, url: 'https://no-title.example/' }),
    ]

    expect(parseBindableTabs(lines.join('\n'))).toEqual([
      { id: 5, title: 'Inbox — mail', url: 'https://mail.example/inbox' },
      { id: 9, title: '', url: 'https://example.com/' },
      { id: 11, title: '', url: 'https://no-title.example/' },
    ])
  })

  it('keeps entries whose title itself contains a separator', () => {
    const line = formatBindableTab({ id: 3, title: 'a | b', url: 'https://example.com/x' })

    expect(parseBindableTabs(line)).toEqual([{ id: 3, title: 'a | b', url: 'https://example.com/x' }])
  })

  it('ignores anything that is not a rendered line', () => {
    expect(parseBindableTabs('No bindable web tabs are open (open a page first).')).toEqual([])
    expect(parseBindableTabs(undefined)).toEqual([])
    expect(parseBindableTabs('ID=x | t | u')).toEqual([])
  })
})

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

  it('accepts every level between the oldest and the current one', () => {
    // A level below the current one is the skew the handshake exists to serve:
    // the host narrows the surface to what that build implements. Requiring the
    // current level dropped the frame as unparseable, which closed the socket
    // with `1008` and made the degradation path unreachable.
    const caps = { snapshotMaxChars: 500, maxInteractiveItems: 10, proto: BRIDGE_PROTO }
    for (let level = LEGACY_TOOLSET; level <= BRIDGE_TOOLSET; level += 1) {
      const frame = parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { ...caps, toolset: level } }))
      expect(frame?.t).toBe('hello')
      expect(declaredToolset(frame?.t === 'hello' ? frame.caps : undefined)).toBe(level)
    }
  })

  it('pins an extension id that the extension manifest actually derives', () => {
    // The no-token loopback path accepts only this ID, so it has to be the ID
    // Chrome gives the extension this repo builds. That ID comes from the
    // manifest's public `key`; if the two ever drift, the extension can no
    // longer connect at all -- which is why this is asserted rather than
    // trusted. Chrome's derivation: SHA-256 of the key's SubjectPublicKeyInfo
    // DER, first 16 bytes, each hex digit mapped onto `a`-`p`.
    const manifestPath = resolve(import.meta.dirname, '../../../../extensions/dsh-browser/manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { key?: string }
    expect(typeof manifest.key).toBe('string')

    const digest = createHash('sha256').update(Buffer.from(manifest.key!, 'base64')).digest().subarray(0, 16)
    const derived = [...digest]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .split('')
      .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
      .join('')

    expect(derived).toBe(BRIDGE_EXTENSION_IDS[0])
    expect(EXTENSION_ID_PATTERN.test(derived)).toBe(true)
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

describe('extension version capability', () => {
  // Additive on purpose: the host uses it to say "reload the extension" instead
  // of guessing, but a build that predates the field must keep connecting, and
  // a host that predates it must keep ignoring it. So none of this moves
  // BRIDGE_PROTO/BRIDGE_TOOLSET.
  const BASE = { snapshotMaxChars: 32_000, maxInteractiveItems: 60 }

  const hello = (caps: Record<string, unknown>): ReturnType<typeof parseBridgeFrame> =>
    parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: { ...BASE, ...caps } }))

  it('carries the reported version through both handshake directions', () => {
    expect(hello({ proto: BRIDGE_PROTO, toolset: BRIDGE_TOOLSET, extensionVersion: '0.1.2' }))
      .toEqual({ t: 'hello', token: 'x', caps: { ...BASE, proto: BRIDGE_PROTO, toolset: BRIDGE_TOOLSET, extensionVersion: '0.1.2' } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello.ok', caps: { ...BASE, extensionVersion: '9.9.9' } })))
      .toEqual({ t: 'hello.ok', caps: { ...BASE, extensionVersion: '9.9.9' } })
  })

  it('still accepts a build that reports no version, as a legacy one', () => {
    const frame = hello({})
    expect(frame).toEqual({ t: 'hello', token: 'x', caps: { ...BASE } })
    // Absent is "not reported", not "version 0": it must not need a version bump
    // to be understood, and it must not be refused as a mismatch.
    expect(declaredProto(frame?.t === 'hello' ? frame.caps : undefined)).toBe(1)
    expect(handshakeRefusal({ ...BASE })).toBeUndefined()
  })

  it('rejects a present-but-unusable version instead of reading it as absent', () => {
    for (const extensionVersion of ['', '   ', 7, null, true, [], {}, ['0.1.2']]) {
      expect(hello({ extensionVersion }), JSON.stringify(extensionVersion)).toBeUndefined()
    }
  })

  it('ignores unknown extra caps fields and is insensitive to their order', () => {
    const frame = hello({ extensionVersion: '0.1.2', futureCapability: { level: 3 } })
    expect(frame?.t).toBe('hello')
    expect(frame?.t === 'hello' ? frame.caps.extensionVersion : undefined).toBe('0.1.2')

    // The parser reads named fields, so a field arriving before or after them
    // cannot change the outcome.
    const reordered = parseBridgeFrame(JSON.stringify({
      caps: { extensionVersion: '0.1.2', maxInteractiveItems: 60, snapshotMaxChars: 32_000, t: 'hello' },
      token: 'x',
      t: 'hello',
    }))
    expect(reordered?.t).toBe('hello')
    expect(reordered?.t === 'hello' ? reordered.caps.extensionVersion : undefined).toBe('0.1.2')
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
