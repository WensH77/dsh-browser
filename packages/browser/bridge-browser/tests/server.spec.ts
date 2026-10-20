import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { BridgeServer, BridgeToolError, isLoopbackAddress, messageToText, payloadCode, payloadMessage, payloadNeedsPageChoice } from '../src/server.ts'
import type { BridgeFrame } from '../src/protocol.ts'
import { BRIDGE_BINDINGS_METHOD, BRIDGE_EXTENSION_IDS, BRIDGE_PROTO, BRIDGE_TOOLSET, EXTENSION_UNVERIFIED_CLOSE_CODE, HANDSHAKE_MISMATCH_CLOSE_CODE } from '../src/protocol.ts'
import { UPDATE_RAW_BASE, currentInstallMode, currentPlatform, updateCommand } from '../src/update-source.ts'

const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef'

/** The extension ID the bridge pins; the no-token loopback path requires it. */
const EXT_ID = BRIDGE_EXTENSION_IDS[0]

/** 扩展上下文的 Origin（回环免 token 的必要条件）。 */
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`
/** An extension this repo does not build: no loopback exemption, token required. */
const OTHER_EXT_ID = 'a'.repeat(32)
const OTHER_EXT_ORIGIN = `chrome-extension://${OTHER_EXT_ID}`

/** Extension caps used by every hello in this suite. */
const CAPS = { debugger: true as const, extensionId: EXT_ID, snapshotMaxChars: 12_000, maxInteractiveItems: 60 }

interface Harness {
  bridge: BridgeServer
  server: Server
  url: string
}

async function startBridge(overrides: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}): Promise<Harness> {
  const bridge = new BridgeServer({
    token: TOKEN,
    toolTimeoutMs: 1_000,
    caps: { debugger: true, snapshotMaxChars: 12_000, maxInteractiveItems: 60 },
    ...overrides,
  })
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { bridge.handleUpgrade(req, socket, head) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  return { bridge, server, url: `ws://127.0.0.1:${port}/ext/bridge` }
}

function connect(url: string, origin?: string): Promise<{ ws: WebSocket; frames: BridgeFrame[]; done: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin !== undefined ? { headers: { origin } } : undefined)
    const frames: BridgeFrame[] = []
    ws.on('message', (data) => { frames.push(JSON.parse(data.toString()) as BridgeFrame) })
    ws.on('error', reject)
    ws.on('open', () => {
      resolve({
        ws,
        frames,
        done: new Promise<void>((doneResolve) => {
          ws.on('close', () => { doneResolve() })
        }),
      })
    })
  })
}

function send(ws: WebSocket, frame: BridgeFrame): void {
  ws.send(JSON.stringify(frame))
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

const harnesses: Harness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.bridge.close()
    await new Promise<void>((resolve) => { h.server.close(() => resolve()) })
  }
})

describe('BridgeServer', () => {
  it('decodes every ws message delivery shape', () => {
    expect(messageToText([Buffer.from('a'), Buffer.from('b')])).toBe('ab')
    expect(messageToText(Buffer.from('hi'))).toBe('hi')
    expect(messageToText(new TextEncoder().encode('x').buffer)).toBe('x')
  })

  it('extracts tool error codes and messages with parser-gated fallbacks', () => {
    expect(payloadCode({ code: 'timeout', message: 'm' })).toBe('timeout')
    expect(payloadCode({ code: 42, message: 'm' })).toBe('internal')
    expect(payloadCode('garbage')).toBe('internal')
    expect(payloadCode(null)).toBe('internal')
    expect(payloadMessage({ code: 'x', message: 'm' })).toBe('m')
    expect(payloadMessage({ code: 'x', message: '' })).toBe('browser action failed')
    expect(payloadMessage({ code: 'x', message: 42 })).toBe('browser action failed')
    expect(payloadMessage('garbage')).toBe('browser action failed')
  })

  it('reads the page-choice flag, and only when the extension set it', () => {
    // The flag sends the host into a bind, so anything but a literal true — an
    // older build's silence, or a malformed frame — must read as "not a page
    // problem" rather than as consent to bind.
    expect(payloadNeedsPageChoice({ code: 'x', message: 'm', needsPageChoice: true })).toBe(true)
    expect(payloadNeedsPageChoice({ code: 'x', message: 'm' })).toBe(false)
    expect(payloadNeedsPageChoice({ code: 'x', message: 'm', needsPageChoice: 'true' })).toBe(false)
    expect(payloadNeedsPageChoice({ code: 'x', message: 'm', needsPageChoice: 1 })).toBe(false)
    expect(payloadNeedsPageChoice(null)).toBe(false)
    expect(payloadNeedsPageChoice('garbage')).toBe(false)
  })

  it('authenticates a valid hello and acknowledges caps', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(frames.find((f) => f.t === 'hello.ok')).toEqual({ t: 'hello.ok', caps: { debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    ws.close()
  })

  it('reports the extension\'s capabilities and follows a build that declares none', async () => {
    const h = await startBridge()
    harnesses.push(h)
    expect(h.bridge.clientDebugger()).toBe(false)

    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { proto: BRIDGE_PROTO, toolset: BRIDGE_TOOLSET, debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(h.bridge.clientDebugger()).toBe(true)

    // A build from before the versioned handshake is still accepted: it reports
    // no debug capability and reads as the legacy toolset.
    const legacy = await connect(h.url)
    send(legacy.ws, { t: 'hello', token: TOKEN, caps: { snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => legacy.frames.some((f) => f.t === 'hello.ok'))
    expect(h.bridge.clientDebugger()).toBe(false)
  })

  it('refuses an extension that speaks a newer protocol, with a reason it can show', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url)
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => { resolve({ code, reason: reason.toString() }) })
    })
    send(ws, { t: 'hello', token: TOKEN, caps: { ...CAPS, proto: BRIDGE_PROTO + 1 } })
    await done
    const close = await closed
    expect(close.code).toBe(HANDSHAKE_MISMATCH_CLOSE_CODE)
    expect(close.reason).toContain('restart dsh')
    expect(h.bridge.hasConnection()).toBe(false)
  })

  it('accepts loopback connections without a token when Origin is an extension (zero-config mode)', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url, EXT_ORIGIN)
    send(ws, { t: 'hello', token: '', caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(frames.find((f) => f.t === 'hello.ok')).toBeDefined()
    ws.close()
  })

  it('refuses a no-token loopback socket whose Origin names another extension', async () => {
    // `Origin` is only a header: every other extension the user has installed
    // can present a genuine `chrome-extension://<its own id>`. Accepting any
    // such origin let any of them take the tool slot and read every tool call.
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => { resolve({ code, reason: reason.toString() }) })
    })
    send(ws, { t: 'hello', token: '', caps: { ...CAPS, extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } })
    await done
    expect((await closed).code).toBe(4002)
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('refuses a no-token loopback socket whose Origin is not an extension origin at all', async () => {
    // A local process can send whatever it likes here.
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url, `chrome-extension://${EXT_ID}-suffix`)
    send(ws, { t: 'hello', token: '', caps: CAPS })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('refuses a hello whose extensionId disagrees with the Origin it arrived on', async () => {
    // The Origin names the pinned extension but the frame claims another: a
    // process that learned the accepted origin cannot also pass the claim.
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url, EXT_ORIGIN)
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => { resolve({ code, reason: reason.toString() }) })
    })
    send(ws, { t: 'hello', token: '', caps: { ...CAPS, extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } })
    await done
    const result = await closed
    // Its own code, not 4002: the token was never the problem, so the extension
    // must not be told to fix the token or to restart the host.
    expect(result.code).toBe(EXTENSION_UNVERIFIED_CLOSE_CODE)
    expect(result.reason).toContain('reload it from chrome://extensions')
  })

  it('requires a token from extension origins this repo does not build', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url, OTHER_EXT_ORIGIN)
    send(ws, { t: 'hello', token: '', caps: { ...CAPS, extensionId: OTHER_EXT_ID } })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('accepts another extension that presents the token', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url, OTHER_EXT_ORIGIN)
    send(ws, { t: 'hello', token: TOKEN, caps: { ...CAPS, extensionId: OTHER_EXT_ID } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(frames.find((f) => f.t === 'hello.ok')).toBeDefined()
    ws.close()
  })

  it('rejects loopback connections without a token when Origin is not an extension (malicious page)', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url, 'https://evil.example')
    send(ws, { t: 'hello', token: '', caps: CAPS })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('rejects loopback connections without a token and without any Origin', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url)
    send(ws, { t: 'hello', token: '', caps: CAPS })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('still requires the token from non-loopback remotes', async () => {
    const h = await startBridge({ remoteAddressOverride: '192.168.1.5' })
    harnesses.push(h)
    const { ws, done } = await connect(h.url)
    send(ws, { t: 'hello', token: '', caps: CAPS })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('closes sockets that never present hello', async () => {
    const h = await startBridge({ helloTimeoutMs: 500 })
    harnesses.push(h)
    const { ws, done } = await connect(h.url)
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('rejects frames before hello', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url)
    send(ws, { t: 'pong' })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('refuses an RPC method the bridge does not service', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'rpc-1', method: 'session.list', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result'))
    expect(frames.find((f) => f.t === 'rpc.result'))
      .toMatchObject({ t: 'rpc.result', id: 'rpc-1', ok: false, error: { code: 'method-not-allowed' } })
    ws.close()
  })

  it('records the UI language the extension reports over the rpc channel', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(h.bridge.clientUiLanguage()).toBeUndefined()

    send(ws, { t: 'rpc', id: 'lang-1', method: 'bridge.uiLanguage', payload: { language: 'zh' } })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result'))

    expect(frames.find((f) => f.t === 'rpc.result')).toMatchObject({ id: 'lang-1', ok: true, result: { language: 'zh' } })
    // Cached: the prompts read it per ask, not per rpc round trip.
    expect(h.bridge.clientUiLanguage()).toBe('zh')
    ws.close()
  })

  it('refuses an unusable language and keeps the prompts in English', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))

    // `auto` is the value this setting deliberately does not have; a build that
    // sends it must not make the host render a language it has no copy for.
    send(ws, { t: 'rpc', id: 'lang-2', method: 'bridge.uiLanguage', payload: { language: 'auto' } })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'lang-2'))

    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'lang-2'))
      .toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(h.bridge.clientUiLanguage()).toBeUndefined()
    ws.close()
  })

  it('drops the reported language when the connection is replaced', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const first = await connect(h.url)
    send(first.ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => first.frames.some((f) => f.t === 'hello.ok'))
    send(first.ws, { t: 'rpc', id: 'lang-3', method: 'bridge.uiLanguage', payload: { language: 'zh' } })
    await waitFor(() => h.bridge.clientUiLanguage() === 'zh')

    // A new socket starts from nothing: the language reports once per
    // connection, so the next extension has to say its own.
    const second = await connect(h.url)
    send(second.ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => second.frames.some((f) => f.t === 'hello.ok'))

    expect(h.bridge.clientUiLanguage()).toBeUndefined()
    second.ws.close()
  })

  it('records the bindings table the extension reports over the rpc channel', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    // The capability is what tells the host these reports exist at all; the
    // route serves `supported: true` from it.
    expect(h.bridge.clientSupportsBindings()).toBe(false)
    send(ws, { t: 'hello', token: TOKEN, caps: { ...CAPS, bindingsReport: true } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    // "Supported, nothing reported yet" is not "nothing is bound": the route
    // answers undefined here and an empty table only from an actual report.
    expect(h.bridge.clientSupportsBindings()).toBe(true)
    expect(h.bridge.clientBindings()).toBeUndefined()

    const report = {
      revision: 4,
      focusedSessionId: 's1',
      bindings: [{ sessionId: 's1', tabId: 42, windowId: 1, title: 'Orders' }],
    }
    send(ws, { t: 'rpc', id: 'bind-1', method: BRIDGE_BINDINGS_METHOD, payload: report })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'bind-1'))

    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'bind-1'))
      .toMatchObject({ t: 'rpc.result', id: 'bind-1', ok: true, result: { revision: 4 } })
    expect(h.bridge.clientBindings()).toEqual(report)
    ws.close()
  })

  it('reads an extension that cannot report bindings as unsupported, not unbound', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    // A build from before the report: absent capability and no table. The GUI
    // must not be told the browser is free.
    send(ws, { t: 'hello', token: TOKEN, caps: { ...CAPS } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))

    expect(h.bridge.clientSupportsBindings()).toBe(false)
    expect(h.bridge.clientBindings()).toBeUndefined()
    ws.close()
  })

  it('refuses a malformed bindings report and keeps the previous snapshot', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { ...CAPS, bindingsReport: true } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))

    const report = {
      revision: 1,
      focusedSessionId: null,
      bindings: [{ sessionId: 's1', tabId: 42, windowId: 1, title: 'Orders' }],
    }
    send(ws, { t: 'rpc', id: 'bind-2', method: BRIDGE_BINDINGS_METHOD, payload: report })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'bind-2'))
    expect(h.bridge.clientBindings()).toEqual(report)

    // A half-parsed table would show a binding that may already be gone, which
    // is worse than one poll cycle of lag.
    send(ws, { t: 'rpc', id: 'bind-3', method: BRIDGE_BINDINGS_METHOD, payload: { ...report, revision: -1 } })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'bind-3'))

    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'bind-3'))
      .toMatchObject({ t: 'rpc.result', id: 'bind-3', ok: false, error: { code: 'bad-request' } })
    expect(h.bridge.clientBindings()).toEqual(report)
    ws.close()
  })

  it('clears the bindings table when the connection is replaced or closes', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const first = await connect(h.url)
    send(first.ws, { t: 'hello', token: TOKEN, caps: { ...CAPS, bindingsReport: true } })
    await waitFor(() => first.frames.some((f) => f.t === 'hello.ok'))
    send(first.ws, {
      t: 'rpc',
      id: 'bind-4',
      method: BRIDGE_BINDINGS_METHOD,
      payload: { revision: 1, focusedSessionId: 's1', bindings: [] },
    })
    await waitFor(() => h.bridge.clientBindings()?.revision === 1)

    // Serving the last socket's table would mark a session that may no longer
    // own the browser, so the replacement starts from nothing.
    const second = await connect(h.url)
    send(second.ws, { t: 'hello', token: TOKEN, caps: { ...CAPS, bindingsReport: true } })
    await waitFor(() => second.frames.some((f) => f.t === 'hello.ok'))

    expect(h.bridge.clientBindings()).toBeUndefined()
    expect(h.bridge.clientSupportsBindings()).toBe(true)

    send(second.ws, {
      t: 'rpc',
      id: 'bind-5',
      method: BRIDGE_BINDINGS_METHOD,
      payload: { revision: 2, focusedSessionId: null, bindings: [] },
    })
    await waitFor(() => h.bridge.clientBindings()?.revision === 2)
    second.ws.close()
    // The close is processed asynchronously; the table must not outlive it.
    await expect.poll(() => h.bridge.clientBindings()).toBeUndefined()
  })

  it('hands a reported wait to the call it belongs to', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    // The capability is what tells the host these reports exist at all.
    expect(h.bridge.clientReportsWaiting()).toBe(false)
    send(ws, { t: 'hello', token: TOKEN, caps: { ...CAPS, waitingReport: true } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(h.bridge.clientReportsWaiting()).toBe(true)

    const seen: boolean[] = []
    const pending = h.bridge.requestTool(
      'browser_click',
      { index: 3 },
      new AbortController().signal,
      60_000,
      undefined,
      (waiting) => { seen.push(waiting) },
    )
    // The host mints the call id, so the report has to quote the frame it just
    // sent — an id the extension could not have known in advance.
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((f) => f.t === 'tool.call') as { id: string }

    send(ws, { t: 'rpc', id: 'wait-1', method: 'bridge.toolWaiting', payload: { id: call.id, waiting: true } })
    await waitFor(() => seen.length === 1)
    send(ws, { t: 'rpc', id: 'wait-2', method: 'bridge.toolWaiting', payload: { id: call.id, waiting: false } })
    await waitFor(() => seen.length === 2)

    expect(seen).toEqual([true, false])
    expect(frames.filter((f) => f.t === 'rpc.result').map((f) => f.id)).toEqual(['wait-1', 'wait-2'])

    // The report is a notification, not part of the call's answer.
    send(ws, { t: 'tool.result', id: call.id, ok: true, result: { text: 'clicked' } })
    await expect(pending).resolves.toEqual({ text: 'clicked' })
    ws.close()
  })

  it('drops a wait report no in-flight call can claim, and refuses a malformed one', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { ...CAPS, waitingReport: true } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))

    // Nobody is waiting for c-gone: a report that outlived its call must not
    // resurrect it, or a cancelled card would raise a question about nothing.
    send(ws, { t: 'rpc', id: 'wait-3', method: 'bridge.toolWaiting', payload: { id: 'c-gone', waiting: true } })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'wait-3'))
    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'wait-3')).toMatchObject({ ok: true })

    send(ws, { t: 'rpc', id: 'wait-4', method: 'bridge.toolWaiting', payload: { id: 'c-1', waiting: 'yes' } })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'wait-4'))
    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'wait-4'))
      .toMatchObject({ ok: false, error: { code: 'bad-request' } })
    ws.close()
  })


  it('classifies loopback addresses for the hello gate', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })

  it('dispatches tool calls and resolves on tool.result', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const result = h.bridge.requestTool('browser_click', { index: 1 }, new AbortController().signal)
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((f) => f.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    expect(call.name).toBe('browser_click')
    expect(call.args).toEqual({ index: 1 })
    send(ws, { t: 'tool.result', id: call.id, ok: true, result: { text: 'clicked' } })
    await expect(result).resolves.toEqual({ text: 'clicked' })
    ws.close()
  })

  it('rejects tool calls whose signal is already aborted before dispatch', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url, EXT_ORIGIN)
    send(ws, { t: 'hello', token: '', caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const abort = new AbortController()
    abort.abort()
    expect(() => h.bridge.requestTool('browser_click', {}, abort.signal))
      .toThrowError(expect.objectContaining({ code: 'bridge-closed' }))
    // 没有 tool.call 被发出
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(frames.some((f) => f.t === 'tool.call')).toBe(false)
    ws.close()
  })

  it('rejects tool calls when no extension is connected', async () => {
    const h = await startBridge()
    harnesses.push(h)
    expect(() => h.bridge.requestTool('browser_click', {}, new AbortController().signal))
      .toThrowError(expect.objectContaining({ code: 'bridge-closed' }))
  })

  it('times out tool calls that never settle', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    await expect(h.bridge.requestTool('browser_wait', {}, new AbortController().signal, 30))
      .rejects.toMatchObject({ code: 'timeout' })
    await waitFor(() => frames.some((frame) => frame.t === 'tool.cancel'))
    const call = frames.find((frame) => frame.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    expect(frames).toContainEqual({ t: 'tool.cancel', id: call.id })
    ws.close()
  })

  it('propagates extension-reported tool errors', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const result = h.bridge.requestTool('browser_navigate', { url: 'https://x' }, new AbortController().signal)
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((f) => f.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    send(ws, { t: 'tool.result', id: call.id, ok: false, error: { code: 'action-failed', message: 'blocked' } })
    await expect(result).rejects.toBeInstanceOf(BridgeToolError)
    await expect(result).rejects.toMatchObject({ code: 'action-failed', message: 'blocked' })
    ws.close()
  })

  it('settles pending tool calls when a replacement connection arrives', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const first = await connect(h.url)
    send(first.ws, { t: 'hello', token: TOKEN, caps: { debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => first.frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal)
    // Attach the assertion eagerly: the replacement below settles it before the final await.
    const pendingAssertion = expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    await waitFor(() => first.frames.some((f) => f.t === 'tool.call'))

    const second = await connect(h.url)
    send(second.ws, { t: 'hello', token: TOKEN, caps: { debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => second.frames.some((f) => f.t === 'hello.ok'))

    await pendingAssertion
    first.ws.close()
    second.ws.close()
  })

  it('aborts tool calls when the caller signal fires', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { debugger: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const abort = new AbortController()
    const pending = h.bridge.requestTool('browser_click', {}, abort.signal)
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((frame) => frame.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    await waitFor(() => frames.some((frame) => frame.t === 'tool.cancel'))
    expect(frames).toContainEqual({ t: 'tool.cancel', id: call.id })
    ws.close()
  })

  it('forwards the owning session with a tool call', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool(
      'browser_click',
      {},
      new AbortController().signal,
      1_000,
      'session-browser',
    )
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((frame) => frame.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    expect(call.sessionId).toBe('session-browser')
    send(ws, { t: 'tool.result', id: call.id, ok: true, result: { text: 'done' } })
    await expect(pending).resolves.toEqual({ text: 'done' })
    ws.close()
  })

  it('settles pending tool calls when the send fails mid-flight', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal)
    // Tear the socket down immediately: the in-flight send reports a write
    // failure (or the close path wins — either settles as bridge-closed).
    const assertion = expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    ws.terminate()
    await assertion
  })

  it('closes cleanly twice (second close is a no-op on the acceptor)', async () => {
    const h = await startBridge()
    harnesses.push(h)
    await h.bridge.close()
    await h.bridge.close()
  })

  it('sends protocol pings on the configured cadence and the client answers pong', async () => {
    const h = await startBridge({ pingIntervalMs: 50 })
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'ping'))
    send(ws, { t: 'pong' })
    ws.close()
  })

  it('closes cleanly and rejects pending work', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal)
    // Attach the assertion eagerly: close() settles it before the final await.
    const pendingAssertion = expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    await h.bridge.close()
    await pendingAssertion
    expect(() => h.bridge.requestTool('browser_click', {}, new AbortController().signal))
      .toThrowError(expect.objectContaining({ code: 'bridge-closed' }))
    ws.close()
  })

  it('refuses a hello whose reported extension version is present but empty', async () => {
    // The wire contract reads present-but-empty as malformed, so the host must
    // drop the frame rather than treat it as "an extension with no version" —
    // otherwise `clientExtensionVersion()` could return a value the model would
    // print as a version.
    const h = await startBridge()
    harnesses.push(h)
    const { ws, done } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { ...CAPS, extensionVersion: '' } })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
    expect(h.bridge.hasConnection()).toBe(false)
    expect(h.bridge.clientExtensionVersion()).toBeUndefined()
  })

  it('samples the extension version from the last handshake and clears it on disconnect', async () => {
    const h = await startBridge()
    harnesses.push(h)
    // Nothing has connected yet: no sample to report.
    expect(h.bridge.clientExtensionVersion()).toBeUndefined()

    const { ws, frames, done } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: { ...CAPS, extensionVersion: '0.1.2' } })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(h.bridge.clientExtensionVersion()).toBe('0.1.2')

    ws.close()
    await done
    // The close is processed asynchronously; the sample must not outlive it.
    await expect.poll(() => h.bridge.clientExtensionVersion()).toBeUndefined()
  })

  it('accepts a build that reports no version and takes the sample from the replacing socket', async () => {
    const h = await startBridge()
    harnesses.push(h)

    // An older build: the field is absent, and the handshake still succeeds.
    const legacy = await connect(h.url)
    send(legacy.ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => legacy.frames.some((f) => f.t === 'hello.ok'))
    expect(h.bridge.hasConnection()).toBe(true)
    expect(h.bridge.clientExtensionVersion()).toBeUndefined()

    // A replacement owns the slot, so it also owns the sample: a version read
    // after promotion must come from the socket that is actually connected.
    const next = await connect(h.url)
    send(next.ws, { t: 'hello', token: TOKEN, caps: { ...CAPS, extensionVersion: '0.2.0' } })
    await waitFor(() => next.frames.some((f) => f.t === 'hello.ok'))
    expect(h.bridge.clientExtensionVersion()).toBe('0.2.0')

    await h.bridge.close()
    expect(h.bridge.clientExtensionVersion()).toBeUndefined()
    next.ws.close()
  })

  it('tracks connection state through auth, close, and replacement', async () => {
    const h = await startBridge()
    harnesses.push(h)
    expect(h.bridge.hasConnection()).toBe(false)
    const { ws, frames, done } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(h.bridge.hasConnection()).toBe(true)
    ws.close()
    await done
    // The server processes the close asynchronously; poll for the outcome.
    await expect.poll(() => h.bridge.hasConnection()).toBe(false)
  })

  it('closes sockets on unparseable frames and ignores client-only frames when ready', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames, done } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    // Client-only shapes after ready are ignored (no error frame, no close).
    send(ws, { t: 'pong' })
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    // Garbage is a protocol violation and closes the socket.
    ws.send('not-json')
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('ignores tool results with unknown ids', async () => {
    const h = await startBridge()
    harnesses.push(h)
    const { ws, frames } = await connect(h.url)
    send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    // Unknown id: ignored, connection stays healthy.
    send(ws, { t: 'tool.result', id: 'nope', ok: true, result: {} })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  /**
   * `bridge.updateCommand` answers the panel's Update button, which copies the
   * answer to the user's clipboard. Two properties matter: the method is on the
   * whitelist at all, and what comes back is the bare command line — the
   * multi-line explanation `browser_update` hands the model must not ride along,
   * and the command has to match the install it was asked about.
   */
  describe('bridge.updateCommand', () => {
    async function askUpdateCommand(
      overrides: Parameters<typeof startBridge>[0] = {},
    ): Promise<{ answer: BridgeFrame | undefined, frames: BridgeFrame[], ws: WebSocket }> {
      const h = await startBridge(overrides)
      harnesses.push(h)
      const { ws, frames } = await connect(h.url)
      send(ws, { t: 'hello', token: TOKEN, caps: CAPS })
      await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
      send(ws, { t: 'rpc', id: 'upd-1', method: 'bridge.updateCommand', payload: {} })
      await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'upd-1'))
      return { answer: frames.find((f) => f.t === 'rpc.result' && f.id === 'upd-1'), frames, ws }
    }

    it('accepts the method and answers a managed install with the one-line installer', async () => {
      const { answer, ws } = await askUpdateCommand({ updateCommand: () => updateCommand('managed', 'posix') })
      expect(answer).toEqual({ t: 'rpc.result', id: 'upd-1', ok: true, result: updateCommand('managed', 'posix') })
      const command = (answer as { result: string }).result
      expect(command).toBe(`curl -fsSL ${UPDATE_RAW_BASE}/scripts/install.sh | bash`)
      // The clipboard gets a command, not a report about one.
      expect(command).not.toContain('run this yourself')
      expect(command).not.toContain('browser bridge update')
      expect(command).not.toContain('\n')
      ws.close()
    })

    it('answers with whatever the injected command builds (the test seam)', async () => {
      const { answer, ws } = await askUpdateCommand({ updateCommand: () => updateCommand('checkout', 'posix') })
      expect(answer).toEqual({ t: 'rpc.result', id: 'upd-1', ok: true, result: './scripts/install.sh' })
      ws.close()
    })

    it('always answers the published installer, whatever this install is', async () => {
      // The default path is what production runs. It hands back the `curl … | bash` line even
      // on a checkout install — the user's ruling, so the button never depends on where the
      // host happens to live. The cost is recorded in the function it calls: on a checkout that
      // command installs the released tree, not the local one.
      const { answer, frames, ws } = await askUpdateCommand()
      const expected = updateCommand('managed', currentPlatform())
      expect(answer).toEqual({ t: 'rpc.result', id: 'upd-1', ok: true, result: expected })
      expect(String((answer as { result: string }).result)).toContain(`curl -fsSL ${UPDATE_RAW_BASE}/scripts/install.sh | bash`)
      // A payload the method does not read changes nothing.
      send(ws, { t: 'rpc', id: 'upd-2', method: 'bridge.updateCommand', payload: { install: 'checkout' } })
      await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'upd-2'))
      expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'upd-2'))
        .toEqual({ t: 'rpc.result', id: 'upd-2', ok: true, result: expected })
      ws.close()
    })
  })
})
