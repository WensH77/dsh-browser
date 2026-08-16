/**
 * Panel ↔ background port client. The panel never touches the bridge or the
 * gateway directly; everything goes through the service worker's port.
 *
 * Firefox note: unlike Chrome, a Firefox MV3 background event page is NOT kept
 * alive by an open `runtime.connect` port — it may be unloaded and later
 * resumed as a fresh context, which invalidates the panel's port without the
 * background noticing. To survive that, this client:
 *   - routes every send through a guarded helper (no "postMessage on
 *     disconnected port" throws escape),
 *   - listens for `onDisconnect` and transparently re-establishes the port,
 *     re-binding the same listeners so the UI keeps working after a Firefox
 *     event-page wake.
 *
 * @module
 */

import type { BridgeCaps, RespondResult } from '@deepseek-ai/dsh-bridge-browser/src/protocol.ts'
import type { ServerFrame } from '@deepseek-ai/dsh-bridge-browser/src/protocol.ts'
import type { BridgeState } from '../background/bridge.ts'
import type { Settings } from '../background/index.ts'
import type { ApprovalDecision, ApprovalRequest } from '../security/approval.ts'
import { getUiLocale } from '../i18n.ts'

/** Panel-side subset of the extension settings. */
export type PanelSettings = Settings

interface RpcResultMessage {
  type: 'rpc.result'
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

interface RespondResultMessage {
  type: 'respond.result'
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

interface StatusMessage {
  type: 'status'
  state: BridgeState
  caps: BridgeCaps | null
}

interface EventMessage {
  type: 'event'
  frame: ServerFrame
}

interface ApprovalRequestMessage {
  type: 'approval.request'
  request: ApprovalRequest
}

interface ApprovalResolvedMessage {
  type: 'approval.resolved'
  id: string
}

type BackgroundMessage = RpcResultMessage | RespondResultMessage | StatusMessage | EventMessage | ApprovalRequestMessage | ApprovalResolvedMessage

/** The panel API surface. */
export interface PanelApi {
  rpc<T = unknown>(method: string, payload?: unknown): Promise<T>
  respond(rpcId: string, result: RespondResult): Promise<unknown>
  onStatus(callback: (state: BridgeState, caps: BridgeCaps | null) => void): () => void
  onEvent(callback: (frame: ServerFrame) => void): () => void
  onApprovalRequest(callback: (request: ApprovalRequest) => void): () => void
  onApprovalResolved(callback: (id: string) => void): () => void
  respondToApproval(id: string, decision: ApprovalDecision): void
  updateSettings(settings: Partial<PanelSettings>): void
  requestStatus(): void
}

/** Connect to the background service worker and return the panel API. */
export function connectPanel(): PanelApi {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const pendingResponses = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const statusListeners = new Set<(state: BridgeState, caps: BridgeCaps | null) => void>()
  const eventListeners = new Set<(frame: ServerFrame) => void>()
  const approvalListeners = new Set<(request: ApprovalRequest) => void>()
  const approvalResolvedListeners = new Set<(id: string) => void>()

  let port: chrome.runtime.Port | null = null
  /** Set while a reconnect is in flight so a burst of failures only re-connects once. */
  let reconnecting = false

  function failAll(error: Error): void {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
    for (const entry of pendingResponses.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pendingResponses.clear()
  }

  function onMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const msg = message as BackgroundMessage
    switch (msg.type) {
      case 'rpc.result': {
        const entry = pending.get(msg.id)
        if (entry === undefined) return
        pending.delete(msg.id)
        // The bridge relays the gateway's ServerResponse envelope verbatim
        // ({ type, rpcId, result: { ok, value | error } }); unwrap the value
        // so callers get the business payload, and surface business errors.
        const envelope = msg.result as { result?: { ok?: boolean; value?: unknown; error?: { message?: string } } } | undefined
        const business = envelope?.result
        if (msg.ok && business?.ok !== false) entry.resolve(business?.value)
        else entry.reject(new Error(business?.error?.message ?? msg.error?.message
          ?? (getUiLocale() === 'zh' ? 'RPC 请求失败' : 'RPC request failed')))
        break
      }
      case 'respond.result': {
        const entry = pendingResponses.get(msg.id)
        if (entry === undefined) return
        pendingResponses.delete(msg.id)
        clearTimeout(entry.timer)
        if (msg.ok) entry.resolve(msg.result)
        else entry.reject(new Error(msg.error?.message
          ?? (getUiLocale() === 'zh' ? '回答提交失败' : 'Failed to send the answer')))
        break
      }
      case 'status':
        for (const listener of statusListeners) listener(msg.state, msg.caps)
        break
      case 'event':
        for (const listener of eventListeners) listener(msg.frame)
        break
      case 'approval.request':
        for (const listener of approvalListeners) listener(msg.request)
        break
      case 'approval.resolved':
        for (const listener of approvalResolvedListeners) listener(msg.id)
        break
    }
  }

  /** Bind a fresh port's listeners and attach the disconnect/reconnect hook. */
  function attach(next: chrome.runtime.Port): void {
    port = next
    next.onMessage.addListener(onMessage)
    next.onDisconnect.addListener(() => {
      // Reject anything still awaiting the old port, then reconnect.
      failAll(new Error(getUiLocale() === 'zh' ? '后台连接已断开' : 'Background connection lost'))
      void reconnect()
    })
  }

  function connect(): void {
    try {
      const next = chrome.runtime.connect({ name: 'dsh-panel' })
      attach(next)
      // A fresh port knows nothing about the UI yet; ask for the current state.
      safeSend({ type: 'request-status' })
    } catch {
      // Background unavailable right now; a later rpc() will retry the connect.
      port = null
    }
  }

  function reconnect(): Promise<void> {
    if (reconnecting) return Promise.resolve()
    reconnecting = true
    // Give Firefox's event page a moment to (re)start before connecting.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        reconnecting = false
        connect()
        resolve()
      }, 150)
    })
  }

  /** Guarded send: never throws on a stale port, and reconnects on failure. */
  function safeSend(message: unknown): boolean {
    const current = port
    if (current !== null) {
      try {
        current.postMessage(message)
        return true
      } catch {
        // Port is dead (e.g. Firefox event page was unloaded). Reconnect.
        void reconnect()
      }
    }
    return false
  }

  connect()

  return {
    rpc<T>(method: string, payload?: unknown): Promise<T> {
      const id = crypto.randomUUID()
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as T), reject })
        safeSend({ type: 'rpc', id, method, payload })
      })
    },
    respond(rpcId, result) {
      const id = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingResponses.delete(id)
          reject(new Error(getUiLocale() === 'zh' ? '回答提交超时，请重试' : 'Sending the answer timed out. Try again.'))
        }, 35_000)
        pendingResponses.set(id, { resolve, reject, timer })
        safeSend({ type: 'respond', id, rpcId, result })
      })
    },
    onStatus(callback) {
      statusListeners.add(callback)
      return () => { statusListeners.delete(callback) }
    },
    onEvent(callback) {
      eventListeners.add(callback)
      return () => { eventListeners.delete(callback) }
    },
    onApprovalRequest(callback) {
      approvalListeners.add(callback)
      return () => { approvalListeners.delete(callback) }
    },
    onApprovalResolved(callback) {
      approvalResolvedListeners.add(callback)
      return () => { approvalResolvedListeners.delete(callback) }
    },
    respondToApproval(id, decision) {
      safeSend({ type: 'approval.response', id, decision })
    },
    updateSettings(next) {
      safeSend({ type: 'settings', settings: next })
    },
    requestStatus() {
      safeSend({ type: 'request-status' })
    },
  }
}
