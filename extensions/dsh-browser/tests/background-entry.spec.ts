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
  /** Deliver one UI request the way a panel page would, and await its response. */
  uiRequest: (message: unknown) => Promise<unknown>
  /** `tool.result` frames the extension has sent back for one call id. */
  results: (id: string) => Frame[]
  /** Wait for one call to settle, then return its result frame. */
  settle: (id: string) => Promise<Frame>
  /** Approval ids seen so far, in the order their cards were raised. */
  approvalIds: () => string[]
  /** Options of each approval notification raised, in the same order. */
  approvalNotificationOptions: () => Frame[]
  /** Answer one approval the way the side panel's buttons do. */
  answer: (id: string, decision: string) => void
  /** Client frames the extension sent to the bridge, in order. */
  sentFrames: () => Frame[]
  /** What the worker wrote to `chrome.storage.local` under the settings key. */
  storedSettings: () => Frame | undefined
}

/**
 * Boot the worker against the fakes and wait until it is really connected.
 *
 * `stored` is the settings object the fake storage already holds, which is how
 * one test models an install from before a setting existed: the object simply
 * has no key for it.
 */
async function boot(
  activeTab: typeof APP_TAB = APP_TAB,
  stored: Frame = { bridgeUrl: BRIDGE_URL },
): Promise<Harness> {
  FakeSocket.reset()
  const messageListeners: Listener[] = []
  const notifications = vi.fn(async (_id: string, _options?: unknown) => 'notification-1')
  const runtimeMessages: Frame[] = []
  const storageWrites: Frame[] = []

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
        get: async () => ({ dshSettings: stored }),
        set: async (value: Frame) => { storageWrites.push(value) },
      },
      session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
    },
    tabs: {
      query: async () => [activeTab],
      get: async () => activeTab,
      update: async () => activeTab,
      create: async () => activeTab,
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
    uiRequest: (message) => new Promise((resolve) => {
      for (const listener of messageListeners) {
        (listener as (
          message: unknown,
          sender: unknown,
          sendResponse: (value: unknown) => void,
        ) => void)(
          message,
          { url: `chrome-extension://${EXTENSION_ID}/panel/index.html` },
          resolve,
        )
      }
    }),
    results,
    settle: async (id) => {
      await vi.waitFor(() => { expect(results(id)).toHaveLength(1) })
      return results(id)[0]!
    },
    approvalIds,
    approvalNotificationOptions: () => notifications.mock.calls
      .filter(([id]) => typeof id === 'string' && id.startsWith(APPROVAL_NOTIFICATION_PREFIX))
      .map(([, options]) => options as Frame),
    sentFrames: () => socket.sent.map((raw) => JSON.parse(raw) as Frame),
    storedSettings: () => storageWrites.at(-1)?.['dshSettings'] as Frame | undefined,
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

  it('answers the debug-log readout with no tab, no approval and no session', async () => {
    // This readout is what someone runs *because* the debugging tools fail, so
    // it must not need a bound tab or a consent card to answer.
    harness.call({ id: 'log-1', name: 'browser_debug_log', args: {} })

    const frame = await harness.settle('log-1')

    expect(frame.ok).toBe(true)
    expect(String((frame.result as { text?: string } | undefined)?.text)).toContain('worker-start')
    expect(harness.approvalIds()).toEqual([])
  })

  it('answers the panel Log button with the newest events', async () => {
    const response = await harness.uiRequest({ type: 'debug.log' }) as { log?: string }

    expect(response.log).toContain('worker-start')
  })

  it('refuses to auto-bind a page that belongs to another extension', async () => {
    // Measured report: the session auto-bound whichever tab was active, and a
    // `chrome-extension://` page accepts neither content scripts nor
    // `chrome.debugger`, so every tool failed with
    // "Cannot access a chrome-extension:// URL of different extension".
    const other = await boot({ id: 99, windowId: 1, title: 'Some other extension', url: 'chrome-extension://abcdefghijklmnop/panel.html' })
    other.call({ id: 'p1', name: 'browser_get_text', args: {}, sessionId: 's1' })

    const frame = await other.settle('p1')

    expect(frame.ok).toBe(false)
    expect(String((frame.error as { message?: string } | undefined)?.message)).toContain('another extension')
    expect(String((frame.error as { message?: string } | undefined)?.message)).toContain('Unbind')
    // Nothing was bound, so there was nothing to approve.
    expect(other.approvalIds()).toEqual([])
    // This session has no page at all, so the host may resolve it by letting the
    // user pick one from inside the refused call instead of failing it.
    expect((frame.error as { needsPageChoice?: unknown } | undefined)?.needsPageChoice).toBe(true)
  })

  it('offers no page choice for a bound session whose own page became unoperable', async () => {
    // The session owns this tab. Chrome keeping the page to itself is not a
    // reason to move the session to some other page on its own: the answer's
    // three ways out (switch and Unbind, browser_navigate, browser_bind_interactive)
    // are the only moves, and the host must not read this refusal as a repair.
    const tab = { id: 42, windowId: 1, title: 'Orders', url: 'https://app.example/orders' }
    const bound = await boot(tab)
    // First call binds the session (the action itself fails: this fake has no
    // content script, which is not an affinity problem).
    bound.call({ id: 'p1', name: 'browser_get_text', args: {}, sessionId: 's1' })
    await bound.settle('p1')
    tab.url = 'chrome://settings/'
    bound.call({ id: 'p2', name: 'browser_get_text', args: {}, sessionId: 's1' })

    const frame = await bound.settle('p2')

    expect(frame.ok).toBe(false)
    expect(String((frame.error as { message?: string } | undefined)?.message)).toContain('chrome://settings/')
    expect((frame.error as { needsPageChoice?: unknown } | undefined)?.needsPageChoice).toBeUndefined()
  })

  it('keeps a refusal the host resolves out of the operation feed', async () => {
    // The reported symptom: a red `browser_get_text` above every "List tabs" /
    // "Bind tab" pair, for a call the host had already resolved by binding a
    // page and running it again. The feed is what happened to the page, and
    // this call never reached one — the debug ring keeps the record.
    const tab = { id: 42, windowId: 1, title: 'New tab', url: 'chrome://newtab/' }
    const harness = await boot(tab)
    harness.call({ id: 'p1', name: 'browser_get_text', args: {}, sessionId: 's1' })
    const frame = await harness.settle('p1')
    expect((frame.error as { needsPageChoice?: unknown } | undefined)?.needsPageChoice).toBe(true)

    // The host then does what the plugin does: list the pages, bind one, retry.
    tab.url = 'https://app.example/orders'
    tab.title = 'Orders'
    harness.call({ id: 'l1', name: 'browser_list_tabs', args: {}, sessionId: 's1' })
    await harness.settle('l1')
    harness.call({ id: 'b1', name: 'browser_bind_tab', args: { tabId: 42 }, sessionId: 's1' })
    await harness.settle('b1')

    const state = await harness.uiRequest({ type: 'ui.state' }) as { recentOps?: Array<{ name?: string; state?: string }> }
    const ops = state.recentOps ?? []
    // The bind is there, so the feed really is this session's: the refused call
    // is missing on purpose, not because the list is empty.
    expect(ops.some((op) => op.name === 'browser_bind_tab' && op.state === 'done')).toBe(true)
    expect(ops.filter((op) => op.name === 'browser_get_text')).toEqual([])
  })
})

/**
 * Where the interface language comes from, end to end.
 *
 * The setting is stored in the extension, so the worker is what every other
 * surface reads it from: it applies the stored value to the modules that word
 * user-facing copy, hands it to the panel and the options page in `ui.state`,
 * and reports it to the host over the bridge so the two dsh questions can be
 * worded the same way.
 */
describe('background entry UI language', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** The `bridge.uiLanguage` frames the worker sent, in order. */
  function languageReports(harness: Harness): Frame[] {
    return harness.sentFrames().filter((frame) => frame.t === 'rpc' && frame.method === 'bridge.uiLanguage')
  }

  it('reports English to the host on a fresh connection', async () => {
    const harness = await boot()

    const reports = languageReports(harness)

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ t: 'rpc', method: 'bridge.uiLanguage', payload: { language: 'en' } })
  })

  it('serves English to the UI for an install that predates the setting', async () => {
    // An install from before `uiLanguage` existed has no key for it in storage;
    // the load must land on the default rather than on undefined.
    const harness = await boot(APP_TAB, { bridgeUrl: BRIDGE_URL })

    const state = await harness.uiRequest({ type: 'ui.state' }) as { locale?: unknown }

    expect(state.locale).toBe('en')
    expect(languageReports(harness)[0]).toMatchObject({ payload: { language: 'en' } })
  })

  it('starts from the stored language', async () => {
    const harness = await boot(APP_TAB, { bridgeUrl: BRIDGE_URL, uiLanguage: 'zh' })

    const state = await harness.uiRequest({ type: 'ui.state' }) as { locale?: unknown }

    expect(state.locale).toBe('zh')
    expect(languageReports(harness)[0]).toMatchObject({ payload: { language: 'zh' } })
  })

  it('persists a language change, shows it to the UI, and tells the host', async () => {
    const harness = await boot()
    expect(languageReports(harness)).toHaveLength(1)

    await harness.uiRequest({ type: 'settings.set', patch: { uiLanguage: 'zh' } })

    expect(harness.storedSettings()?.['uiLanguage']).toBe('zh')
    expect((await harness.uiRequest({ type: 'ui.state' }) as { locale?: unknown }).locale).toBe('zh')
    // No reconnect happened, so the second report is what carries the change.
    expect(languageReports(harness)).toHaveLength(2)
    expect(languageReports(harness)[1]).toMatchObject({ payload: { language: 'zh' } })
  })

  it('words the system notification in the language the setting selects', async () => {
    // Notifications are the one surface with no page to render copy in, so the
    // worker's own locale state has to be the setting.
    const zh = await boot(APP_TAB, { bridgeUrl: BRIDGE_URL, uiLanguage: 'zh' })
    zh.call({ id: 'c1', name: 'browser_back', args: {}, sessionId: 's1' })
    await card(zh, 1)
    const zhNotification = zh.approvalNotificationOptions()
    expect(zhNotification[0]?.title).toBe('浏览器操作等待确认')

    const en = await boot()
    en.call({ id: 'c2', name: 'browser_back', args: {}, sessionId: 's1' })
    await card(en, 1)
    expect(en.approvalNotificationOptions()[0]?.title).toBe('Browser action awaiting approval')
  })
})

/**
 * The Update button's request, end to end through the real worker.
 *
 * The panel asks the background, the background asks the host over the rpc
 * channel, and the answer is what the panel copies. The wire that can silently
 * go missing is the middle one — a handler that answers `{ error }` without ever
 * sending the rpc, or one that sends a method name the host does not have — so
 * this drives the real entry with the fakes and reads the frames it sent.
 */
describe('background entry update command', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** The `bridge.updateCommand` frames the worker sent, in order. */
  function updateRequests(harness: Harness): Frame[] {
    return harness.sentFrames().filter((frame) => frame.t === 'rpc' && frame.method === 'bridge.updateCommand')
  }

  /** The first request's id, once the worker has sent it. */
  async function firstRequest(harness: Harness): Promise<Frame> {
    return await vi.waitFor(() => {
      const [first] = updateRequests(harness)
      expect(first).toBeDefined()
      return first!
    })
  }

  it('asks the host for the command and answers the panel with it', async () => {
    const harness = await boot()
    // Nothing is asked at boot: the command is fetched per press, because the
    // install mode and path behind it can change.
    expect(updateRequests(harness)).toHaveLength(0)

    const answered = harness.uiRequest({ type: 'update-command' })
    const request = await firstRequest(harness)
    expect(request.payload).toEqual({})

    FakeSocket.instances[0]!.receive({
      t: 'rpc.result',
      id: request.id,
      ok: true,
      result: './scripts/install.sh',
    })

    await expect(answered).resolves.toEqual({ command: './scripts/install.sh' })
  })

  it('answers the panel with an error when the host refuses the method', async () => {
    // An older host: `method-not-allowed`. The panel must be able to tell this
    // apart from a copied command, so it gets no `command` field at all.
    const harness = await boot()

    const answered = harness.uiRequest({ type: 'update-command' })
    const request = await firstRequest(harness)
    FakeSocket.instances[0]!.receive({
      t: 'rpc.result',
      id: request.id,
      ok: false,
      error: { code: 'method-not-allowed', message: 'bridge refuses RPC method bridge.updateCommand' },
    })

    const response = await answered as { command?: unknown, error?: unknown }
    expect(response.command).toBeUndefined()
    expect(String(response.error)).toContain('bridge refuses RPC method bridge.updateCommand')
  })
})
