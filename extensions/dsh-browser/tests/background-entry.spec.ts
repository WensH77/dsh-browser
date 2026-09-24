// @vitest-environment jsdom
/**
 * Coverage for the background entry itself.
 *
 * Every other spec loads one module; this one imports `src/background/index.ts`
 * with a chrome API fake and a fake WebSocket, so the worker's real boot path
 * runs: settings load, the real `BridgeClient` handshake, the real tool-call
 * router, and the real consent gate. That is what catches a wire that is
 * missing between modules — the class of bug where the gate logic is correct
 * and tested, but the entry never consults it.
 *
 * The case pinned here is "Allow in this session": the grant the user gave has
 * to silence the next card for that session and that action, and only that one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const EXTENSION_ID = 'edihbhncneajmmoomljfjacbhelaipgc'
const BRIDGE_URL = 'ws://127.0.0.1:3999/ext/bridge'
const APPROVAL_NOTIFICATION_PREFIX = 'dsh-browser-approval:'
const APP_TAB = { id: 42, windowId: 1, title: 'Orders', url: 'https://app.example/orders' }

type Frame = Record<string, unknown>
type Listener = (...args: never[]) => void

/**
 * The WebSocket the `BridgeClient` drives, with only what it touches: opening,
 * the `hello` it sends, and frames arriving from the bridge. Answering `hello`
 * with `hello.ok` is what moves the client into its connected state.
 */
class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly instances: FakeSocket[] = []

  static reset(): void {
    FakeSocket.instances.length = 0
  }

  readyState = FakeSocket.CONNECTING
  readonly url: string
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
    queueMicrotask(() => {
      if (this.readyState !== FakeSocket.CONNECTING) return
      this.readyState = FakeSocket.OPEN
      this.emit('open', {})
    })
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  send(data: string): void {
    this.sent.push(data)
    const frame = JSON.parse(data) as Frame
    if (frame.t !== 'hello') return
    queueMicrotask(() => {
      this.receive({
        t: 'hello.ok',
        caps: { proto: 3, toolset: 5, debugger: false, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
      })
    })
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return
    this.readyState = FakeSocket.CLOSED
    this.emit('close', { code: 1000, reason: '' })
  }

  /** Deliver one bridge frame to the client. */
  receive(frame: Frame): void {
    if (this.readyState !== FakeSocket.OPEN) return
    this.emit('message', { data: JSON.stringify(frame) })
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      (listener as (value: unknown) => void)(event)
    }
  }
}

interface ToolCallSpec {
  id: string
  name: string
  args?: Record<string, unknown>
  sessionId?: string
}

interface Harness {
  /** Deliver a `tool.call` frame the bridge plugin would send. */
  call: (call: ToolCallSpec) => void
  /** `tool.result` frames the extension has sent back for one call id. */
  results: (id: string) => Frame[]
  /** Wait for one call to settle, then return its result frame. */
  settle: (id: string) => Promise<Frame>
  /** Approval ids seen so far, in the order their cards were raised. */
  approvalIds: () => string[]
  /** Answer one approval the way the side panel's buttons do. */
  answer: (id: string, decision: string) => void
}

/** Boot the worker against the fakes and wait until it is really connected. */
async function boot(): Promise<Harness> {
  FakeSocket.reset()
  const messageListeners: Listener[] = []
  const notifications = vi.fn(async (_id: string, _options?: unknown) => 'notification-1')
  const runtimeMessages: Frame[] = []

  const chromeApi = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
      onConnect: { addListener: () => undefined },
      onMessage: { addListener: (listener: Listener) => { messageListeners.push(listener) } },
      sendMessage: async (message: Frame) => { runtimeMessages.push(message) },
      openOptionsPage: async () => undefined,
    },
    storage: {
      local: {
        get: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }),
        set: async () => undefined,
      },
      session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
    },
    tabs: {
      query: async () => [APP_TAB],
      get: async () => APP_TAB,
      update: async () => APP_TAB,
      create: async () => APP_TAB,
      // No content script in this fake. An approved call therefore fails at its
      // action step — which is fine: this spec is about whether a card was
      // raised, not about what the page did.
      sendMessage: async () => { throw new Error('Could not establish connection. Receiving end does not exist.') },
      onActivated: { addListener: () => undefined },
      onUpdated: { addListener: () => undefined },
      onReplaced: { addListener: () => undefined },
      onRemoved: { addListener: () => undefined },
    },
    webNavigation: {
      // Force `listTabFrames` onto its single-main-frame fallback.
      getAllFrames: async () => { throw new Error('no frame tree in this fake') },
    },
    scripting: { executeScript: async () => [] },
    windows: {
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2,
      getLastFocused: async () => ({ id: 1 }),
      get: async () => ({ id: 7 }),
      create: async () => ({ id: 7 }),
      update: async () => ({ id: 7 }),
      onFocusChanged: { addListener: () => undefined },
      onRemoved: { addListener: () => undefined },
    },
    alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
    notifications: {
      create: notifications,
      clear: async () => undefined,
      onClicked: { addListener: () => undefined },
    },
    action: {
      onClicked: { addListener: () => undefined },
      setBadgeBackgroundColor: async () => undefined,
      setBadgeText: async () => undefined,
    },
    sidePanel: { open: async () => undefined, setPanelBehavior: async () => undefined },
    downloads: { download: async () => 1, search: async () => [], onChanged: { addListener: () => undefined } },
    debugger: {
      attach: async () => undefined,
      detach: async () => undefined,
      sendCommand: async () => ({}),
      onEvent: { addListener: () => undefined },
      onDetach: { addListener: () => undefined },
    },
  }

  vi.stubGlobal('chrome', chromeApi)
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ wsUrl: BRIDGE_URL }) })))
  vi.resetModules()
  await import('../src/background/index.ts')

  const socket = await vi.waitFor(() => {
    const first = FakeSocket.instances[0]
    expect(first).toBeDefined()
    return first!
  })
  // The worker reports every state change to the UI: 'connected' means the real
  // handshake completed, so a `tool.call` frame will now be routed.
  await vi.waitFor(() => {
    expect(runtimeMessages.some((message) => message.type === 'push.status' && message.state === 'connected')).toBe(true)
  })

  const results = (id: string): Frame[] => socket.sent
    .map((raw) => JSON.parse(raw) as Frame)
    .filter((frame) => frame.t === 'tool.result' && frame.id === id)

  const approvalIds = (): string[] => notifications.mock.calls
    .map((call) => call[0])
    .filter((value): value is string => typeof value === 'string' && value.startsWith(APPROVAL_NOTIFICATION_PREFIX))
    .map((value) => value.slice(APPROVAL_NOTIFICATION_PREFIX.length))

  return {
    call: (call) => socket.receive({
      t: 'tool.call',
      id: call.id,
      name: call.name,
      args: call.args ?? {},
      expiresAt: Date.now() + 30_000,
      ...call.sessionId === undefined ? {} : { sessionId: call.sessionId },
    }),
    results,
    settle: async (id) => {
      await vi.waitFor(() => { expect(results(id)).toHaveLength(1) })
      return results(id)[0]!
    },
    approvalIds,
    answer: (id, decision) => {
      for (const listener of messageListeners) {
        (listener as (
          message: unknown,
          sender: unknown,
          sendResponse: (value: unknown) => void,
        ) => void)(
          { type: 'approval.response', id, decision },
          { url: `chrome-extension://${EXTENSION_ID}/panel/index.html` },
          () => undefined,
        )
      }
    },
  }
}

/** Wait for the nth card and return its approval id. */
async function card(harness: Harness, count: number): Promise<string> {
  const ids = await vi.waitFor(() => {
    const seen = harness.approvalIds()
    expect(seen).toHaveLength(count)
    return seen
  })
  return ids[count - 1]!
}

describe('background entry consent gate', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await boot()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('raises one card for a session-scoped action and runs the repeat without asking again', async () => {
    harness.call({ id: 'c1', name: 'browser_headers', args: { pattern: '/api/' }, sessionId: 's1' })
    harness.answer(await card(harness, 1), 'allow-in-session')
    await harness.settle('c1')

    // Same session, same action: the grant the user just gave is what has to
    // silence this call. Nothing answers a card for `c2` — with the entry's main
    // path consulting the grant the call settles on its own, and a path that
    // misses the grant instead sits waiting for a card nobody will answer.
    harness.call({ id: 'c2', name: 'browser_headers', args: { pattern: '/api/' }, sessionId: 's1' })
    await harness.settle('c2')

    expect(harness.approvalIds()).toHaveLength(1)
  })

  it('does not let one action grant silence a different action', async () => {
    harness.call({ id: 'c1', name: 'browser_headers', args: { pattern: '/api/' }, sessionId: 's1' })
    harness.answer(await card(harness, 1), 'allow-in-session')
    await harness.settle('c1')

    // A different action is a different power, so it asks on its own.
    harness.call({ id: 'c2', name: 'browser_back', args: {}, sessionId: 's1' })
    harness.answer(await card(harness, 2), 'allow-once')
    await harness.settle('c2')

    expect(harness.approvalIds()).toHaveLength(2)
  })
})
