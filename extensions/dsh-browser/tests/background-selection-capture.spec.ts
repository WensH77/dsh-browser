// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

function chromeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    addListener: vi.fn((listener: (...args: T) => void) => { listeners.add(listener) }),
    removeListener: vi.fn((listener: (...args: T) => void) => { listeners.delete(listener) }),
    emit: (...args: T) => { for (const listener of listeners) listener(...args) },
  }
}

function panelPort() {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const postMessage = vi.fn()
  const port = { name: 'dsh-panel', postMessage, onMessage, onDisconnect } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port, postMessage }
}

function tab(tabId: number): chrome.tabs.Tab {
  return {
    id: tabId,
    index: 0,
    pinned: false,
    highlighted: true,
    active: true,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    windowId: 1,
    title: `Tab ${tabId}`,
    url: `https://example.com/${tabId}`,
  }
}

const sender = { id: 'test-extension', tab: tab(1), frameId: 0 } as chrome.runtime.MessageSender

const capture = {
  text: 'dsh plugin: Chrome sidebar extension',
  truncated: false,
  title: 'Lum1104/dsh-browser',
  url: 'https://example.com/1',
}

function mockChrome(sharePageContent: 'auto' | 'off' = 'auto') {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onMessage = chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>()
  const onUpdated = chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>()
  const onRemoved = chromeEvent<[number]>()
  const sendMessage = vi.fn(async () => {})
  const query = vi.fn(async () => [tab(1)])
  vi.stubGlobal('chrome', {
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: chromeEvent<[chrome.alarms.Alarm]>() },
    notifications: {
      create: vi.fn(async () => ''),
      clear: vi.fn(async () => true),
      onClicked: chromeEvent<[string]>(),
    },
    action: { onClicked: chromeEvent<[chrome.tabs.Tab]>() },
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
      onMessage,
    },
    sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
    storage: {
      local: {
        get: vi.fn(async () => ({ dshSettings: { sharePageContent } })),
        set: vi.fn(async () => {}),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => tab(tabId)),
      query,
      sendMessage,
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated,
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved,
    },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: chromeEvent<[number]>() },
  } as unknown as typeof chrome)
  return { onConnect, onMessage, onRemoved, onUpdated, query, sendMessage }
}

async function connectPanelForTest(sharePageContent: 'auto' | 'off' = 'auto') {
  const chromeMock = mockChrome(sharePageContent)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
  await import('../src/background/index.ts')
  await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })

  const panel = panelPort()
  chromeMock.onConnect.emit(panel.port)
  await vi.waitFor(() => {
    expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'selection' }))
  })
  panel.postMessage.mockClear()
  // Both the runtime (content scripts) and the port (panel) carry onMessage.
  return { ...chromeMock, ...panel, runtimeMessages: chromeMock.onMessage, panelMessages: panel.onMessage }
}

function selectionMessages(postMessage: ReturnType<typeof vi.fn>): unknown[] {
  return postMessage.mock.calls
    .map(([message]) => message as { type?: string; selection?: unknown })
    .filter((message) => message.type === 'selection')
    .map((message) => message.selection)
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('page selection capture', () => {
  it('arms the content scripts once a panel is open', async () => {
    const { sendMessage } = await connectPanelForTest()

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(1, { type: 'DSH_SELECTION_WATCH', enabled: true })
    })
  })

  it('tells a freshly loaded document whether to watch selections', async () => {
    const { runtimeMessages } = await connectPanelForTest()
    const respond = vi.fn()

    runtimeMessages.emit({ type: 'DSH_CONTENT_READY' }, sender, respond)

    expect(respond).toHaveBeenCalledWith({ selectionWatch: true })
  })

  it('broadcasts a capture from the page the user is looking at', async () => {
    const { runtimeMessages, postMessage } = await connectPanelForTest()

    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())

    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })
    expect(selectionMessages(postMessage)[0]).toMatchObject({
      text: capture.text,
      title: capture.title,
      url: capture.url,
    })
  })

  it('ignores a capture from a tab the user is not on', async () => {
    const { runtimeMessages, postMessage } = await connectPanelForTest()

    runtimeMessages.emit(
      { type: 'DSH_SELECTION', selection: capture },
      { ...sender, tab: tab(7) } as chrome.runtime.MessageSender,
      vi.fn(),
    )
    // The visible tab's own selection proves the rejected one never landed.
    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: { ...capture, text: 'visible tab' } }, sender, vi.fn())

    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })
    expect(selectionMessages(postMessage)[0]).toMatchObject({ text: 'visible tab' })
  })

  it('never captures while page sharing is off', async () => {
    const { runtimeMessages, postMessage, sendMessage } = await connectPanelForTest('off')
    const respond = vi.fn()

    runtimeMessages.emit({ type: 'DSH_CONTENT_READY' }, sender, respond)
    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(respond).toHaveBeenCalledWith({ selectionWatch: false })

    expect(selectionMessages(postMessage)).toHaveLength(0)
    expect(sendMessage).not.toHaveBeenCalledWith(1, { type: 'DSH_SELECTION_WATCH', enabled: true })
  })

  it('drops the quote when its page navigates away', async () => {
    const { runtimeMessages, onUpdated, postMessage } = await connectPanelForTest()
    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())
    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })

    onUpdated.emit(1, { status: 'loading', url: 'https://example.com/next' }, tab(1))

    expect(selectionMessages(postMessage)).toEqual([expect.objectContaining({ text: capture.text }), null])
  })

  it('drops the quote when its tab closes', async () => {
    const { runtimeMessages, onRemoved, postMessage } = await connectPanelForTest()
    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())
    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })

    onRemoved.emit(1)

    expect(selectionMessages(postMessage).at(-1)).toBeNull()
  })

  it('clears the quote for every panel when one of them sends or dismisses it', async () => {
    const { runtimeMessages, panelMessages, postMessage } = await connectPanelForTest()
    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())
    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })

    panelMessages.emit({ type: 'selection.clear' })

    expect(selectionMessages(postMessage).at(-1)).toBeNull()
  })

  it('disarms the content scripts when the last panel closes', async () => {
    const { onDisconnect, sendMessage } = await connectPanelForTest()
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(1, { type: 'DSH_SELECTION_WATCH', enabled: true })
    })

    onDisconnect.emit()

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(1, { type: 'DSH_SELECTION_WATCH', enabled: false })
    })
  })
})
