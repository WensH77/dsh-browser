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

  /**
   * Whether a `hello` is acknowledged automatically. Tests that need to observe
   * the open-but-unauthenticated window turn this off and answer by hand.
   */
  static autoAck = true

  static reset(): void {
    FakeSocket.instances.length = 0
    FakeSocket.autoAck = true
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
    if (frame.t !== 'hello' || !FakeSocket.autoAck) return
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
  /** Open an assistant page the way `panel/main.tsx` does, reporting its window. */
  connectAssistant: (windowId: number) => void
  /** Notifications the worker asked Chrome to clear, in order. */
  clearedNotifications: () => string[]
  /** Window updates the worker asked Chrome for (the attention nudge). */
  windowUpdates: () => Frame[]
  /** Pretend the assistant window is the focused one. */
  setAssistantWindowFocused: (focused: boolean) => void
  /** Report a failed top-frame load, the way `webNavigation.onErrorOccurred` does. */
  failLoad: (tabId: number, error?: string) => void
  /** Make Chrome's own frame readout say the current document failed to load. */
  setFrameErrorOccurred: (failed: boolean) => void
  /** Click an approval notification, the way the user does. */
  clickNotification: (approvalId: string) => void
  /** Side-panel opens the worker asked Chrome for, in order. */
  sidePanelOpens: () => Frame[]
  /** Client frames the extension sent to the bridge, in order. */
  sentFrames: () => Frame[]
  /** UI pushes the worker broadcast to the panel, in order. */
  uiPushes: () => Frame[]
  /** What the worker wrote to `chrome.storage.local` under the settings key. */
  storedSettings: () => Frame | undefined
  /** The affinity record the worker last wrote to `chrome.storage.session`. */
  storedAffinity: () => Frame | undefined
  /** Bind one session the way the host's page choice does, and wait for it. */
  bind: (tabId: number, sessionId: string) => Promise<void>
  /** Close a tab: the real `chrome.tabs.onRemoved` handler runs, as in Chrome. */
  closeTab: (tabId: number) => void
  /** Answer the pending `hello` when automatic acknowledgement is off. */
  acceptHandshake: () => void
  /** Fire the real `chrome.tabs.onActivated` handler. */
  activateTab: (tabId: number, windowId: number) => void
  /** Deliver a message the way this extension's content script would. */
  contentMessage: (message: unknown, sender?: Frame) => void
  /** Tab navigations the background performed, in order. */
  navigations: () => Frame[]
  /** Tabs the background asked Chrome to create, with the properties it passed. */
  tabCreations: () => Frame[]
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
  /**
   * Stand in for a content script, whose answer is what the page "did". Omitted
   * by default, so an action still fails at its dispatch step exactly as it did
   * before this parameter existed.
   */
  contentScript?: (message: Frame) => unknown,
  /**
   * Wait for the handshake to complete before returning. Off for tests that
   * must observe the open-but-unauthenticated window (`FakeSocket.autoAck` is
   * then false and the caller answers with `acceptHandshake`).
   */
  awaitConnected = true,
  /** Acknowledge the hello automatically; off to observe the handshake window. */
  autoAck = true,
  /** What chrome.storage.session holds at startup (the restored affinity table). */
  storedSession: Frame = {},
): Promise<Harness> {
  FakeSocket.reset()
  FakeSocket.autoAck = autoAck
  const messageListeners: Listener[] = []
  const notifications = vi.fn(async (_id: string, _options?: unknown) => 'notification-1')
  const runtimeMessages: Frame[] = []
  const storageWrites: Frame[] = []
  const sessionStorageWrites: Frame[] = []
  const tabRemovedListeners: Listener[] = []
  const tabActivatedListeners: Listener[] = []
  const closedTabs = new Set<number>()
  const navigations: Frame[] = []
  const tabCreations: Frame[] = []
  const connectListeners: Listener[] = []
  const clearedNotificationIds: string[] = []
  const windowUpdateCalls: Frame[] = []
  const navigationErrorListeners: Listener[] = []
  const notificationClickListeners: Listener[] = []
  const sidePanelOpenCalls: Frame[] = []
  let assistantWindowFocused = false
  let frameLoadFailed = false

  /** Open one assistant port the way the panel document does. */
  const connectAssistant = (windowId: number): void => {
    const messageListeners: Listener[] = []
    const port = {
      name: 'assistant',
      onMessage: { addListener: (listener: Listener) => { messageListeners.push(listener) } },
      onDisconnect: { addListener: () => undefined },
    }
    for (const listener of connectListeners) (listener as (value: unknown) => void)(port)
    for (const listener of messageListeners) {
      (listener as (value: unknown) => void)({ type: 'assistant.window', windowId })
    }
  }

  const chromeApi = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
      onConnect: { addListener: (listener: Listener) => { connectListeners.push(listener) } },
      onMessage: { addListener: (listener: Listener) => { messageListeners.push(listener) } },
      sendMessage: async (message: Frame) => { runtimeMessages.push(message) },
      openOptionsPage: async () => undefined,
    },
    storage: {
      local: {
        get: async () => ({ dshSettings: stored }),
        set: async (value: Frame) => { storageWrites.push(value) },
      },
      session: {
        get: async () => storedSession,
        set: async (value: Frame) => { sessionStorageWrites.push(value) },
        remove: async () => undefined,
      },
    },
    tabs: {
      query: async () => [activeTab],
      get: async (tabId?: number) => {
        if (tabId !== undefined && closedTabs.has(tabId)) throw new Error(`No tab with id: ${tabId}`)
        return activeTab
      },
      update: async (tabId: number, props?: { url?: string }) => {
        navigations.push({ kind: 'update', tabId, ...(props?.url === undefined ? {} : { url: props.url }) })
        return activeTab
      },
      goBack: async (tabId: number) => { navigations.push({ kind: 'goBack', tabId }) },
      goForward: async (tabId: number) => { navigations.push({ kind: 'goForward', tabId }) },
      reload: async (tabId: number) => { navigations.push({ kind: 'reload', tabId }) },
      create: async (props?: { url?: string; active?: boolean }) => {
        tabCreations.push({ ...props })
        return activeTab
      },
      // No content script in this fake. An approved call therefore fails at its
      // action step — which is fine: this spec is about whether a card was
      // raised, not about what the page did. A test that does care hands in one.
      sendMessage: async (_tabId: number, message: Frame) => {
        if (contentScript === undefined) throw new Error('Could not establish connection. Receiving end does not exist.')
        return contentScript(message)
      },
      onActivated: { addListener: (listener: Listener) => { tabActivatedListeners.push(listener) } },
      onUpdated: { addListener: () => undefined },
      onReplaced: { addListener: () => undefined },
      // Real listener on purpose: closing a tab is what prunes the binding, and
      // a test that skips this handler would test a state Chrome never reaches.
      onRemoved: { addListener: (listener: Listener) => { tabRemovedListeners.push(listener) } },
    },
    webNavigation: {
      // Force `listTabFrames` onto its single-main-frame fallback.
      getAllFrames: async () => { throw new Error('no frame tree in this fake') },
      // The worker asks Chrome about the current document when nothing was
      // recorded (a page that failed before the worker started).
      getFrame: async () => ({ errorOccurred: frameLoadFailed, url: activeTab.url }),
      onErrorOccurred: { addListener: (listener: Listener) => { navigationErrorListeners.push(listener) } },
      onCommitted: { addListener: () => undefined },
    },
    scripting: { executeScript: async () => [] },
    windows: {
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2,
      getLastFocused: async () => ({ id: 1 }),
      get: async (windowId?: number) => ({ id: windowId ?? 7, focused: assistantWindowFocused }),
      create: async () => ({ id: 7 }),
      update: async (windowId: number, props?: Frame) => {
        windowUpdateCalls.push({ windowId, ...props })
        return { id: windowId }
      },
      onFocusChanged: { addListener: () => undefined },
      onRemoved: { addListener: () => undefined },
    },
    alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
    notifications: {
      create: notifications,
      clear: async (id: string) => { clearedNotificationIds.push(id) },
      onClicked: { addListener: (listener: Listener) => { notificationClickListeners.push(listener) } },
    },
    action: {
      onClicked: { addListener: () => undefined },
    },
    sidePanel: {
      open: async (props?: { windowId?: number }) => { sidePanelOpenCalls.push({ ...props }) },
      setPanelBehavior: async () => undefined,
    },
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
  // The hello frame is the readiness signal both modes share: with automatic
  // acknowledgement it is followed by hello.ok, and without it the caller
  // answers by hand. Waiting for `open` alone would race that microtask.
  await vi.waitFor(() => {
    expect(socket.sent.some((raw) => (JSON.parse(raw) as Frame).t === 'hello')).toBe(true)
  })
  // The worker reports every state change to the UI: 'connected' means the real
  // handshake completed, so a `tool.call` frame will now be routed.
  if (awaitConnected) {
    await vi.waitFor(() => {
      expect(runtimeMessages.some((message) => message.type === 'push.status' && message.state === 'connected')).toBe(true)
    })
  }

  const results = (id: string): Frame[] => socket.sent
    .map((raw) => JSON.parse(raw) as Frame)
    .filter((frame) => frame.t === 'tool.result' && frame.id === id)

  const approvalIds = (): string[] => notifications.mock.calls
    .map((call) => call[0])
    .filter((value): value is string => typeof value === 'string' && value.startsWith(APPROVAL_NOTIFICATION_PREFIX))
    .map((value) => value.slice(APPROVAL_NOTIFICATION_PREFIX.length))

  /** Deliver one `tool.call` frame, the way the bridge plugin's dispatch does. */
  const deliverCall = (call: ToolCallSpec): void => socket.receive({
    t: 'tool.call',
    id: call.id,
    name: call.name,
    args: call.args ?? {},
    expiresAt: Date.now() + 30_000,
    ...call.sessionId === undefined ? {} : { sessionId: call.sessionId },
  })

  /** Wait for one call to settle and hand back its result frame. */
  const settleCall = async (id: string): Promise<Frame> => {
    await vi.waitFor(() => { expect(results(id)).toHaveLength(1) })
    return results(id)[0]!
  }

  return {
    call: deliverCall,
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
    settle: settleCall,
    approvalIds,
    approvalNotificationOptions: () => notifications.mock.calls
      .filter(([id]) => typeof id === 'string' && id.startsWith(APPROVAL_NOTIFICATION_PREFIX))
      .map(([, options]) => options as Frame),
    sentFrames: () => socket.sent.map((raw) => JSON.parse(raw) as Frame),
    connectAssistant,
    clearedNotifications: () => [...clearedNotificationIds],
    windowUpdates: () => [...windowUpdateCalls],
    setAssistantWindowFocused: (focused: boolean) => { assistantWindowFocused = focused },
    failLoad: (tabId: number, error = 'net::ERR_EMPTY_RESPONSE') => {
      for (const listener of navigationErrorListeners) {
        (listener as (value: unknown) => void)({ tabId, frameId: 0, url: activeTab.url, error })
      }
    },
    setFrameErrorOccurred: (failed: boolean) => { frameLoadFailed = failed },
    clickNotification: (approvalId: string) => {
      for (const listener of notificationClickListeners) {
        (listener as (value: unknown) => void)(`${APPROVAL_NOTIFICATION_PREFIX}${approvalId}`)
      }
    },
    sidePanelOpens: () => [...sidePanelOpenCalls],
    uiPushes: () => [...runtimeMessages],
    storedSettings: () => storageWrites.at(-1)?.['dshSettings'] as Frame | undefined,
    storedAffinity: () => sessionStorageWrites
      .filter((value) => value['dshTabAffinity'] !== undefined)
      .at(-1)?.['dshTabAffinity'] as Frame | undefined,
    bind: async (tabId, sessionId) => {
      const id = `bind-${sessionId}-${tabId}`
      deliverCall({ id, name: 'browser_bind_tab', args: { tabId }, sessionId })
      const frame = await settleCall(id)
      if (frame.ok !== true) throw new Error(`binding tab ${tabId} for ${sessionId} failed: ${JSON.stringify(frame)}`)
    },
    closeTab: (tabId) => {
      closedTabs.add(tabId)
      for (const listener of tabRemovedListeners) (listener as (tabId: number) => void)(tabId)
    },
    acceptHandshake: () => socket.receive({
      t: 'hello.ok',
      caps: { proto: 3, toolset: 5, debugger: false, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    }),
    activateTab: (tabId, windowId) => {
      for (const listener of tabActivatedListeners) (listener as (event: { tabId: number; windowId: number }) => void)({ tabId, windowId })
    },
    contentMessage: (message, sender) => {
      for (const listener of messageListeners) {
        (listener as (
          message: unknown,
          sender: unknown,
          sendResponse: (value: unknown) => void,
        ) => void)(
          message,
          { id: EXTENSION_ID, tab: { id: activeTab.id }, frameId: 0, url: activeTab.url, ...sender },
          () => undefined,
        )
      }
    },
    navigations: () => [...navigations],
    tabCreations: () => [...tabCreations],
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

describe('approval notification clicks', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await boot(APP_TAB, { bridgeUrl: BRIDGE_URL, statusMode: 'panel' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('opens the side panel on the click stack, with the window the approval came from', async () => {
    await harness.bind(APP_TAB.id, 's1')
    harness.call({ id: 'c1', name: 'browser_headers', args: { pattern: '/api/' }, sessionId: 's1' })
    const approvalId = await card(harness, 1)

    // Raising the card already tried to open the surface (panel form, no
    // gesture, so Chrome rejects it); only the click's own call matters here.
    const before = harness.sidePanelOpens().length
    harness.clickNotification(approvalId)

    // Nothing may be awaited before `sidePanel.open`: Chrome drops the user
    // gesture otherwise, which is exactly what made a clicked reminder do
    // nothing visible.
    expect(harness.sidePanelOpens().slice(before)).toEqual([{ windowId: 1 }])
    expect(harness.clearedNotifications()).toContain(`${APPROVAL_NOTIFICATION_PREFIX}${approvalId}`)

    harness.answer(approvalId, 'allow-once')
    await harness.settle('c1')
  })
})

describe('failed page loads', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await boot()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('names the load failure instead of calling the page protected', async () => {
    // The tab URL is still https, so every protocol check passes; only the
    // load record says this document is Chrome's error page.
    await harness.bind(APP_TAB.id, 's1')
    harness.failLoad(APP_TAB.id, 'net::ERR_EMPTY_RESPONSE')
    harness.call({ id: 'c1', name: 'browser_snapshot', args: {}, sessionId: 's1' })

    const message = JSON.stringify(await harness.settle('c1'))
    expect(message).toContain('net::ERR_EMPTY_RESPONSE')
    expect(message).toContain('browser_bind_interactive')
    expect(message).not.toContain('protected pages')
  })

  it('keeps every tab row parseable by the host, even for a failed page', async () => {
    // The host reads these rows back with `ID=<n> | <title> | <url>`; a note
    // appended here makes it drop the whole entry, hiding the page from the
    // binding question. The failed-load reason travels in the bind answer.
    harness.failLoad(APP_TAB.id)
    harness.call({ id: 'c1', name: 'browser_list_tabs', args: {}, sessionId: 's1' })

    const frame = await harness.settle('c1') as { result?: { text?: string } }
    const lines = String(frame.result?.text ?? '').split('\n')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).toMatch(/^ID=\d+ \| .* \| \S+$/)
    }
  })

  it('says a bound page never loaded, in the answer that bound it', async () => {
    harness.failLoad(APP_TAB.id)
    harness.call({ id: 'b1', name: 'browser_bind_tab', args: { tabId: APP_TAB.id }, sessionId: 's1' })

    const message = JSON.stringify(await harness.settle('b1'))
    expect(message).toContain('failed to load')
    expect(message).toContain('net::ERR_EMPTY_RESPONSE')
  })

  it('asks Chrome about the document when nothing was recorded', async () => {
    // A page that failed before this worker started has no record; Chrome can
    // still say the frame failed, just not which error.
    await harness.bind(APP_TAB.id, 's1')
    harness.setFrameErrorOccurred(true)
    harness.call({ id: 'c1', name: 'browser_snapshot', args: {}, sessionId: 's1' })

    expect(JSON.stringify(await harness.settle('c1'))).toContain('the page did not load')
  })
})

describe('background entry consent gate', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await boot()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('posts a notification when no assistant page can show the card', async () => {
    // No assistant page is open, so the card has nowhere to render: the status
    // window is opened and the OS notification is what reaches the user.
    await harness.bind(APP_TAB.id, 's1')
    harness.call({ id: 'c1', name: 'browser_headers', args: { pattern: '/api/' }, sessionId: 's1' })

    const approvalId = await card(harness, 1)
    expect(harness.approvalNotificationOptions()).toEqual([
      expect.objectContaining({ title: expect.stringContaining('awaiting approval') }),
    ])

    harness.answer(approvalId, 'allow-once')
    await harness.settle('c1')
  })

  it('notifies when the assistant window is not in front, without flashing it', async () => {
    harness.connectAssistant(9)
    await harness.bind(APP_TAB.id, 's1')
    harness.call({ id: 'c1', name: 'browser_headers', args: { pattern: '/api/' }, sessionId: 's1' })

    const approvalId = await card(harness, 1)
    expect(harness.uiPushes().some((message) => message.type === 'push.approval')).toBe(true)
    // A card rendered into a background window is not a reminder, so the OS
    // notification is posted. The window is not flashed: `drawAttention` is the
    // same API on Windows (taskbar flash) and reached nobody the notification
    // did not already reach.
    await vi.waitFor(() => {
      expect(harness.approvalNotificationOptions()).toHaveLength(1)
    })
    expect(harness.windowUpdates()).toEqual([])

    harness.answer(approvalId, 'allow-once')
    await harness.settle('c1')
  })

  it('leaves a focused assistant window alone', async () => {
    harness.connectAssistant(9)
    harness.setAssistantWindowFocused(true)
    await harness.bind(APP_TAB.id, 's1')
    harness.call({ id: 'c1', name: 'browser_headers', args: { pattern: '/api/' }, sessionId: 's1' })

    // The card goes to the window on screen, so there is nothing to nudge and
    // nothing to notify. `card()` counts notifications, so read the push here.
    const approvalId = await vi.waitFor(() => {
      const push = harness.uiPushes().find((message) => message.type === 'push.approval')
      expect(push).toBeDefined()
      const request = (push as { request: Frame }).request
      return request.id as string
    })
    expect(harness.windowUpdates()).toEqual([])
    expect(harness.approvalNotificationOptions()).toHaveLength(0)

    harness.answer(approvalId, 'allow-once')
    await harness.settle('c1')
  })

  it('raises one card for a session-scoped action and runs the repeat without asking again', async () => {
    // A page first: with no implicit binding, a call with no page is refused and
    // raises no card at all, so the grant this test is about needs a binding.
    await harness.bind(APP_TAB.id, 's1')
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
    await harness.bind(APP_TAB.id, 's1')
    harness.call({ id: 'c1', name: 'browser_headers', args: { pattern: '/api/' }, sessionId: 's1' })
    harness.answer(await card(harness, 1), 'allow-in-session')
    await harness.settle('c1')

    // A different action is a different power, so it asks on its own.
    harness.call({ id: 'c2', name: 'browser_back', args: {}, sessionId: 's1' })
    harness.answer(await card(harness, 2), 'allow-once')
    await harness.settle('c2')

    expect(harness.approvalIds()).toHaveLength(2)
  })

  it('tells the host both edges of the wait for a card', async () => {
    // The host cannot see the card, so without these two reports it can only
    // ask about silence — which fires for a slow page too. The edges have to
    // arrive from the extension's own op state, not from a timer here.
    const waits = () => harness.sentFrames().filter((frame) => frame.method === 'bridge.toolWaiting')
    await harness.bind(APP_TAB.id, 's1')
    harness.call({ id: 'c1', name: 'browser_headers', args: { pattern: '/api/' }, sessionId: 's1' })

    const approvalId = await card(harness, 1)
    expect(waits()).toEqual([
      expect.objectContaining({ t: 'rpc', payload: { id: 'c1', waiting: true } }),
    ])

    harness.answer(approvalId, 'allow-once')
    await harness.settle('c1')

    // Answered: the card is down, so the host must stop counting on it. The
    // call's own result is not a wait edge and must not be reported as one.
    await vi.waitFor(() => {
      expect(waits()).toEqual([
        expect.objectContaining({ t: 'rpc', payload: { id: 'c1', waiting: true } }),
        expect.objectContaining({ t: 'rpc', payload: { id: 'c1', waiting: false } }),
      ])
    })
  })

  it('reports the end of a wait whose feed entry the user cleared', async () => {
    // The panel's Clear button empties the feed while a card can still be up.
    // The wait edge belongs to the call, not to the entry that displayed it: a
    // lost `false` edge leaves the host asking about a wait that is over.
    const waits = () => harness.sentFrames().filter((frame) => frame.method === 'bridge.toolWaiting')
    await harness.bind(APP_TAB.id, 's1')
    harness.call({ id: 'c1', name: 'browser_headers', args: { pattern: '/api/' }, sessionId: 's1' })
    const approvalId = await card(harness, 1)
    await vi.waitFor(() => { expect(waits()).toHaveLength(1) })

    await harness.uiRequest({ type: 'ops.clear' })
    harness.answer(approvalId, 'allow-once')
    await harness.settle('c1')

    await vi.waitFor(() => {
      expect(waits().map((frame) => frame.payload)).toEqual([
        { id: 'c1', waiting: true },
        { id: 'c1', waiting: false },
      ])
    })
  })

  it('reports the end of a wait whose feed entry aged out', async () => {
    // Same edge, same reason, for the other way an entry leaves the feed: the
    // 30-entry cap. The card is up, so answering it still has to be reported.
    const waits = () => harness.sentFrames().filter((frame) => frame.method === 'bridge.toolWaiting')
    await harness.bind(APP_TAB.id, 's1')
    harness.call({ id: 'c1', name: 'browser_headers', args: { pattern: '/api/' }, sessionId: 's1' })
    const approvalId = await card(harness, 1)
    await vi.waitFor(() => { expect(waits()).toHaveLength(1) })

    for (let i = 0; i < 30; i += 1) {
      harness.call({ id: `filler-${i}`, name: 'browser_list_tabs', args: {}, sessionId: 's1' })
    }
    harness.answer(approvalId, 'allow-once')
    await harness.settle('c1')

    await vi.waitFor(() => {
      expect(waits().map((frame) => frame.payload)).toEqual([
        { id: 'c1', waiting: true },
        { id: 'c1', waiting: false },
      ])
    })
  })

  it('reports no wait when a session grant spares the user the card', async () => {
    // "Allow in this session" means no card goes up, so there is nothing for the
    // host to ask about: reporting a wait here would raise a question about a
    // prompt that never existed.
    const waits = () => harness.sentFrames().filter((frame) => frame.method === 'bridge.toolWaiting')
    await harness.bind(APP_TAB.id, 's1')
    harness.call({ id: 'c1', name: 'browser_headers', args: { pattern: '/api/' }, sessionId: 's1' })
    harness.answer(await card(harness, 1), 'allow-in-session')
    await harness.settle('c1')
    // One card, so exactly the two edges of that one wait.
    await vi.waitFor(() => { expect(waits()).toHaveLength(2) })

    harness.call({ id: 'c2', name: 'browser_headers', args: { pattern: '/api/' }, sessionId: 's1' })
    await harness.settle('c2')

    expect(harness.approvalIds()).toHaveLength(1)
    expect(waits().map((frame) => frame.payload)).toEqual([
      { id: 'c1', waiting: true },
      { id: 'c1', waiting: false },
    ])
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

  it('never binds a page no other extension may operate', async () => {
    // A `chrome-extension://` page accepts neither content scripts nor
    // `chrome.debugger`: "Cannot access a chrome-extension:// URL of different
    // extension" for every tool. The session must end this call with no page —
    // the refusal below is the same one any page-less call gets, and no bind
    // happens at all, so there is no unoperable binding to recover from.
    const other = await boot({ id: 99, windowId: 1, title: 'Some other extension', url: 'chrome-extension://abcdefghijklmnop/panel.html' })
    other.call({ id: 'p1', name: 'browser_get_text', args: {}, sessionId: 's1' })

    const frame = await other.settle('p1')

    expect(frame.ok).toBe(false)
    // Nothing was bound, so there was nothing to approve.
    expect(other.approvalIds()).toEqual([])
    // This session has no page at all, so the host may resolve it by letting the
    // user pick one from inside the refused call instead of failing it.
    expect((frame.error as { needsPageChoice?: unknown } | undefined)?.needsPageChoice).toBe(true)
    expect(other.storedAffinity()?.['sessionTabs']).toBeUndefined()
  })

  it('offers no page choice for a bound session whose own page became unoperable', async () => {
    // The session owns this tab. Chrome keeping the page to itself is not a
    // reason to move the session to some other page on its own: the answer's
    // three ways out (switch and Unbind, browser_navigate, browser_bind_interactive)
    // are the only moves, and the host must not read this refusal as a repair.
    const tab = { id: 42, windowId: 1, title: 'Orders', url: 'https://app.example/orders' }
    const bound = await boot(tab)
    await bound.bind(42, 's1')
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
    // The row says which page, not only which number: a bind to the wrong tab is otherwise
    // indistinguishable from the right one in the feed.
    const bind = ops.find((op) => op.name === 'browser_bind_tab') as { label?: string } | undefined
    expect(bind?.label).toBe('https://app.example/orders')
    expect(ops.filter((op) => op.name === 'browser_get_text')).toEqual([])
  })

  it('marks a read that succeeded with nothing found, in the push and in the snapshot', async () => {
    // The whole path this feature exists for: a real content script answers "no
    // match", the background answers the model `ok: true` as it always has, and
    // the operation the panel receives says the answer held no content.
    const harness = await boot(APP_TAB, { bridgeUrl: BRIDGE_URL }, (message) => {
      if (message.action !== 'browser_get_text') return { ok: true, result: { text: 'page' } }
      return { ok: true, result: { text: 'text search: no match for "kw" in the whole page (case-insensitive, 12 characters searched).' } }
    })
    await harness.bind(APP_TAB.id, 's1')

    harness.call({ id: 'n1', name: 'browser_get_text', args: { find: 'kw' }, sessionId: 's1' })
    const frame = await harness.settle('n1')

    // The model's half is unchanged: a success, and the sentence it always got.
    expect(frame.ok).toBe(true)
    const modelText = (frame.result as { text?: string } | undefined)?.text ?? ''
    expect(modelText).toContain('text search: no match for "kw" in the whole page')
    expect(Object.keys(frame.result as object)).toEqual(['text'])
    expect(JSON.stringify(frame)).not.toContain('noMatch')

    const pushed = harness.uiPushes()
      .filter((candidate) => candidate.type === 'push.op')
      .map((candidate) => candidate.op as { id?: string; name?: string; state?: string; noMatch?: unknown })
      .filter((op) => op.id === 'n1')
    expect(pushed.at(-1)).toMatchObject({ name: 'browser_get_text', state: 'done', noMatch: true })

    const state = await harness.uiRequest({ type: 'ui.state' }) as { recentOps?: Array<{ id?: string; noMatch?: unknown }> }
    expect((state.recentOps ?? []).find((op) => op.id === 'n1')).toMatchObject({ noMatch: true })
  })

  it('leaves a read that returned content unmarked', async () => {
    // The same path with a page that answered: the feed must not mark it, so the
    // mark above cannot be arriving from somewhere else.
    const harness = await boot(APP_TAB, { bridgeUrl: BRIDGE_URL }, () => (
      { ok: true, result: { text: 'Orders\nTotal 12' } }
    ))
    await harness.bind(APP_TAB.id, 's1')

    harness.call({ id: 'c1', name: 'browser_get_text', args: {}, sessionId: 's1' })
    await harness.settle('c1')

    const marked = harness.uiPushes()
      .filter((candidate) => candidate.type === 'push.op')
      .map((candidate) => candidate.op as { id?: string; noMatch?: unknown; state?: string })
      .filter((op) => op.id === 'c1')
    expect(marked.at(-1)).toMatchObject({ state: 'done' })
    expect(marked.at(-1)?.noMatch).toBeUndefined()
  })
})

/**
 * What a session gets when it has no page to operate.
 *
 * Binding used to happen implicitly on the first call of a page-less session:
 * it took whatever tab the user was looking at. Measured consequence — the
 * assistant's tab was closed, the user had moved on to another page, and the
 * next call quietly began operating that page. These cases pin the replacement:
 * a refusal the host can resolve by asking the user for a page, a release of the
 * dead binding, and the one competing-session answer that must survive the
 * removal of the implicit binding.
 */
describe('background entry page-less sessions', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** The affinity view one `ui.state` request reports. */
  async function affinity(harness: Harness): Promise<Frame> {
    const state = await harness.uiRequest({ type: 'ui.state' }) as Frame
    return state.affinity as Frame
  }

  /** How many affinity pushes the panel has received so far. */
  function affinityPushes(harness: Harness): number {
    return harness.uiPushes().filter((frame) => frame.type === 'push.affinity').length
  }

  it('refuses the next call after the bound tab was closed without taking the tab the user moved to', async () => {
    const tab = { id: 42, windowId: 1, title: 'Orders', url: 'https://app.example/orders' }
    const harness = await boot(tab)
    await harness.bind(42, 's1')

    // The user closes the page this session owned and carries on in another one.
    tab.id = 77
    tab.title = 'Inbox'
    tab.url = 'https://mail.example/inbox'
    harness.closeTab(42)
    await vi.waitFor(async () => {
      expect((await affinity(harness)).status).toBe('lost')
    })

    harness.call({ id: 'c1', name: 'browser_get_text', args: {}, sessionId: 's1' })
    const frame = await harness.settle('c1')

    expect(frame.ok).toBe(false)
    expect((frame.error as { code?: string }).code).toBe('content-unavailable')
    // The mark the host reads as "ask the user which page to use".
    expect((frame.error as { needsPageChoice?: unknown }).needsPageChoice).toBe(true)

    const state = await harness.uiRequest({ type: 'ui.state' }) as Frame
    // Nothing was bound — and in particular not the page the user is viewing.
    expect(state.controlled).toBeNull()
    expect((state.affinity as Frame).controlled).toBeNull()
    expect((state.affinity as Frame).status).toBe('lost')
    // Nothing reached the affinity record a worker restart rehydrates from.
    expect(harness.storedAffinity()?.['sessionTabs']).toBeUndefined()
    expect(harness.storedAffinity()?.['controlledTabId']).toBeUndefined()
  })

  it('refuses a page-less call that carries no session, and binds nothing', async () => {
    // The "never bound" case with no session at all: the call is answered
    // `missing`, which tells the host to ask the user for a page.
    const harness = await boot()
    harness.call({ id: 'c1', name: 'browser_get_text', args: {} })

    const frame = await harness.settle('c1')

    expect(frame.ok).toBe(false)
    expect((frame.error as { code?: string }).code).toBe('no-active-tab')
    expect((frame.error as { needsPageChoice?: unknown }).needsPageChoice).toBe(true)
    const state = await harness.uiRequest({ type: 'ui.state' }) as Frame
    expect(state.controlled).toBeNull()
    expect((state.affinity as Frame).status).toBe('unbound')
    expect((state.affinity as Frame).controlled).toBeNull()
  })

  it('refuses a session that never bound a page, and binds nothing', async () => {
    // The same case for a session: a session-scoped call with no entry is
    // `lost` to the affinity controller — "never bound" and "its tab closed"
    // are the same absence there — so the answer is the `content-unavailable`
    // refusal, which also carries `needsPageChoice`.
    const harness = await boot()
    harness.call({ id: 'c1', name: 'browser_get_text', args: {}, sessionId: 's1' })

    const frame = await harness.settle('c1')

    expect(frame.ok).toBe(false)
    expect((frame.error as { code?: string }).code).toBe('content-unavailable')
    expect((frame.error as { needsPageChoice?: unknown }).needsPageChoice).toBe(true)
    const state = await harness.uiRequest({ type: 'ui.state' }) as Frame
    expect(state.controlled).toBeNull()
    expect(harness.storedAffinity()?.['sessionTabs']).toBeUndefined()
  })

  it('still names the session holding the browser to a session with no page', async () => {
    // One session owns the browser at a time. This answer used to come out of
    // the implicit binding path; it is the one thing that path provided that
    // must not be lost with it, or a page-less session would be told "no page"
    // and would ask the user to choose a page another session is driving.
    const harness = await boot()
    await harness.bind(42, 'owner')

    harness.call({ id: 'c1', name: 'browser_get_text', args: {}, sessionId: 'other' })
    const frame = await harness.settle('c1')

    expect(frame.ok).toBe(false)
    const message = String((frame.error as { message?: string } | undefined)?.message)
    expect(message).toContain('owner')
    expect(message).toContain('https://app.example/orders')
    // Not a page problem the host may repair by asking which page to use.
    expect((frame.error as { needsPageChoice?: unknown }).needsPageChoice).toBeUndefined()
    // The holder keeps the browser.
    const state = await harness.uiRequest({ type: 'ui.state' }) as Frame
    expect(state.controlled).toMatchObject({ sessionId: 'owner', tabId: 42 })
  })

  it('releases the dead binding on the refusal instead of failing silently', async () => {
    // The release is the panel's Unbind path (`session.unbind`), so the refusal
    // has to show its effect: the affinity the panel reads is pushed again. The
    // close handler pruned the entry already, which is exactly why the push —
    // and not a surviving record — is the observable half of it.
    const harness = await boot()
    await harness.bind(42, 's1')
    harness.closeTab(42)
    await vi.waitFor(async () => {
      expect((await affinity(harness)).status).toBe('lost')
    })
    const pushesBefore = affinityPushes(harness)

    harness.call({ id: 'c1', name: 'browser_get_text', args: {}, sessionId: 's1' })
    const frame = await harness.settle('c1')

    expect(frame.ok).toBe(false)
    expect((frame.error as { needsPageChoice?: unknown }).needsPageChoice).toBe(true)
    expect(affinityPushes(harness)).toBeGreaterThan(pushesBefore)
    expect(harness.storedAffinity()?.['sessionTabs']).toBeUndefined()
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
    await zh.bind(APP_TAB.id, 's1')
    zh.call({ id: 'c1', name: 'browser_back', args: {}, sessionId: 's1' })
    await card(zh, 1)
    const zhNotification = zh.approvalNotificationOptions()
    expect(zhNotification[0]?.title).toBe('浏览器操作等待确认')

    const en = await boot()
    await en.bind(APP_TAB.id, 's1')
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
describe('background entry content navigation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('performs a top-frame navigation the content script hands over', async () => {
    const harness = await boot()
    await harness.bind(APP_TAB.id, 's1')

    harness.contentMessage({ type: 'DSH_CONTENT_NAVIGATE', url: 'https://app.example/next' })
    await vi.waitFor(() => {
      expect(harness.navigations()).toContainEqual({
        kind: 'update',
        tabId: APP_TAB.id,
        url: 'https://app.example/next',
      })
    })
  })

  it('moves history and reload onto the browser process too', async () => {
    const harness = await boot()
    await harness.bind(APP_TAB.id, 's1')

    harness.contentMessage({ type: 'DSH_CONTENT_HISTORY', delta: -1 })
    harness.contentMessage({ type: 'DSH_CONTENT_HISTORY', delta: 1 })
    harness.contentMessage({ type: 'DSH_CONTENT_RELOAD' })
    await vi.waitFor(() => {
      expect(harness.navigations()).toEqual(expect.arrayContaining([
        { kind: 'goBack', tabId: APP_TAB.id },
        { kind: 'goForward', tabId: APP_TAB.id },
        { kind: 'reload', tabId: APP_TAB.id },
      ]))
    })
  })

  it('refuses a navigation request that did not come from this extension\'s top frame of a controlled tab', async () => {
    const harness = await boot()
    const message = { type: 'DSH_CONTENT_NAVIGATE', url: 'https://app.example/next' }

    // Nothing bound yet.
    harness.contentMessage(message)
    // A subframe, another extension, and a malformed URL.
    await harness.bind(APP_TAB.id, 's1')
    harness.contentMessage(message, { frameId: 3 })
    harness.contentMessage(message, { id: 'some-other-extension' })
    harness.contentMessage({ type: 'DSH_CONTENT_NAVIGATE', url: 'javascript:alert(1)' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(harness.navigations().filter((entry) => entry.url !== undefined)).toHaveLength(0)
  })
})

/**
 * The only navigate that creates a tab must not take the user's focus.
 *
 * Every later navigate reuses the bound tab through `tabs.update`, so this is
 * the one place the question exists. The reported symptom was being pulled out
 * of the dsh chat on a session's first navigate — the hard-coded `active: true`.
 */
describe('background entry initial navigation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('opens the new tab behind the current one and says so in the result', async () => {
    const harness = await boot()
    harness.call({
      id: 'c1',
      name: 'browser_navigate',
      args: { url: 'https://app.example/next' },
      sessionId: 's1',
    })
    harness.answer(await card(harness, 1), 'allow-once')
    const frame = await harness.settle('c1')

    expect(frame.ok).toBe(true)
    expect(harness.tabCreations()).toEqual([{ url: 'https://app.example/next', active: false }])
    // The model has to know the user is not looking at the new tab: the known
    // background-tab behaviour (focus events, screenshot freshness) follows
    // from it, and the panel only shows the operation.
    expect(String((frame.result as Frame).text)).toContain('new background tab')
  })
})

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

/**
 * The bindings table the worker reports to the host.
 *
 * The dsh Web GUI marks the session holding the browser from this table, and
 * only the extension knows it: a bind and the panel's Unbind both change it,
 * and the host has no other way to learn about the release. The report is
 * fire-and-forget over the rpc channel, so these tests read the frames the
 * worker actually sent rather than an internal call.
 */
describe('background entry bindings report', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** The `bridge.bindings` frames the worker sent, in order. */
  function bindingsReports(harness: Harness): Frame[] {
    return harness.sentFrames().filter((frame) => frame.t === 'rpc' && frame.method === 'bridge.bindings')
  }

  /** The bindings array of one report, as the host reads it. */
  function reportedBindings(frame: Frame): unknown[] {
    const payload = frame.payload as { bindings?: unknown[] }
    return Array.isArray(payload.bindings) ? payload.bindings : []
  }

  it('reports an empty table on a fresh connection', async () => {
    const harness = await boot()

    // The first report waits for the restored affinity table, so it lands a
    // microtask after hello.ok — not synchronously with `boot()`.
    const reports = await vi.waitFor(() => {
      const seen = bindingsReports(harness)
      expect(seen.length).toBeGreaterThan(0)
      return seen
    })

    expect(reports[0]).toMatchObject({
      t: 'rpc',
      method: 'bridge.bindings',
      payload: {
        focusedSessionId: null,
        bindings: [],
      },
    })
    expect(typeof (reports[0]!.payload as { revision?: unknown }).revision).toBe('number')
  })

  it('reports the session and tab a bind created', async () => {
    const harness = await boot()
    await harness.bind(APP_TAB.id, 's1')

    const report = await vi.waitFor(() => {
      const bound = bindingsReports(harness).filter((frame) => reportedBindings(frame).length === 1)
      expect(bound.length).toBeGreaterThan(0)
      return bound.at(-1)!
    })

    expect(report.payload).toMatchObject({
      focusedSessionId: 's1',
      bindings: [{
        sessionId: 's1',
        tabId: APP_TAB.id,
        windowId: APP_TAB.windowId,
        title: APP_TAB.title,
      }],
    })
  })

  it('reports an empty table after the panel unbinds the session', async () => {
    const harness = await boot()
    await harness.bind(APP_TAB.id, 's1')
    // Wait for the bind report first, so the empty boot report cannot be
    // mistaken for the release this test is about.
    await vi.waitFor(() => {
      expect(bindingsReports(harness).some((frame) => reportedBindings(frame).length === 1)).toBe(true)
    })

    const answered = await harness.uiRequest({ type: 'session.unbind' }) as { accepted?: unknown }
    expect(answered.accepted).toBe(true)

    const report = await vi.waitFor(() => {
      const last = bindingsReports(harness).at(-1)
      expect(last).toBeDefined()
      expect(reportedBindings(last!)).toHaveLength(0)
      return last!
    })

    expect(report.payload).toMatchObject({ focusedSessionId: null, bindings: [] })
  })

  it('sends no binding report before the host accepts the handshake', async () => {
    // A restored binding plus a tab close, all while hello.ok is still pending:
    // this is the window in which affinity broadcasts really do fire (the
    // worker restores its table as it starts). The host accepts only `hello`
    // until it authenticates the socket, and closes anything else as
    // `1008 hello first` — so the report has to wait.
    const affinity = {
      controlledTabId: APP_TAB.id,
      sessionTabs: { s1: { ...APP_TAB } },
      focusedSessionId: 's1',
    }
    const harness = await boot(APP_TAB, { bridgeUrl: BRIDGE_URL }, undefined, false, false, {
      dshTabAffinity: affinity,
    })
    const affinityPushes = (): Frame[] => harness.uiPushes().filter((push) => push.type === 'push.affinity')
    await vi.waitFor(() => {
      expect(affinityPushes().length).toBeGreaterThan(0)
    })

    const pushesBefore = affinityPushes().length
    harness.closeTab(APP_TAB.id)
    await vi.waitFor(() => {
      expect(affinityPushes().length).toBeGreaterThan(pushesBefore)
    })
    // The panel heard about the close; the host did not, because the socket is
    // authenticating.
    expect(bindingsReports(harness)).toHaveLength(0)

    harness.acceptHandshake()
    const report = await vi.waitFor(() => {
      const seen = bindingsReports(harness)
      expect(seen.length).toBeGreaterThan(0)
      return seen.at(-1)!
    })

    // The first authenticated report is sent even though nothing changed since
    // the suppression above: a fresh connection starts from nothing on the host.
    expect(reportedBindings(report)).toHaveLength(0)
    expect(report.payload).toMatchObject({ focusedSessionId: null })
  })

  it('skips a report when an affinity broadcast left the table unchanged', async () => {
    const harness = await boot()
    await harness.bind(APP_TAB.id, 's1')
    await vi.waitFor(() => {
      expect(bindingsReports(harness).some((frame) => reportedBindings(frame).length === 1)).toBe(true)
    })
    const reportsBefore = bindingsReports(harness).length
    const affinityPushes = (): Frame[] => harness.uiPushes().filter((push) => push.type === 'push.affinity')
    const pushesBefore = affinityPushes().length

    // Switching to another tab bumps the affinity controller's revision for the
    // panel, but the session-to-tab table is untouched.
    harness.activateTab(APP_TAB.id + 1, APP_TAB.windowId)
    await vi.waitFor(() => {
      expect(affinityPushes().length).toBeGreaterThan(pushesBefore)
    })

    expect(bindingsReports(harness)).toHaveLength(reportsBefore)
  })
})
