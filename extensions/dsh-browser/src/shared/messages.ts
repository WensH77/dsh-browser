/**
 * Minimal message contract between the pure-tool extension pages (status side
 * panel, options, action popup) and the background service worker.
 *
 * No persistent ports: pages request state over `chrome.runtime.sendMessage`
 * and subscribe to one-way `push.*` broadcasts for live updates.
 *
 * @module
 */

import type { BridgeCaps } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { BridgeState } from '../background/bridge.ts'
import type { TabAffinityState } from '../background/tab-affinity.ts'
import type { ApprovalDecision, ApprovalRequest } from '../security/approval.ts'
import type { Settings } from './settings.ts'

/** One recent browser operation shown read-only in the assistant. */
export interface RecentOp {
  id: string
  name: string
  args: Record<string, unknown>
  state: 'running' | 'waiting' | 'done' | 'error' | 'cancelled'
  /** Agent session the operation belongs to (hidden until that session is bound). */
  sessionId?: string
  /** Epoch ms when the operation started. */
  startedAt: number
  /** Epoch ms when the operation settled (done/error/cancelled). */
  endedAt?: number
}

/** What the status side panel shows as the currently controlled page. */
export interface ControlledTabInfo {
  sessionId: string
  tabId: number
  title: string
  url: string
}

/** Snapshot a UI page asks for on open. */
export interface UiState {
  bridgeState: BridgeState
  caps: BridgeCaps | null
  affinity: TabAffinityState
  controlled: ControlledTabInfo | null
  pendingApprovals: ApprovalRequest[]
  recentOps: RecentOp[]
}

/** One-way messages a UI page may send to the background. */
export type UiRequest =
  | { type: 'ui.state' }
  | { type: 'settings.get' }
  | { type: 'settings.set'; patch: Partial<Settings> }
  | { type: 'approval.response'; id: string; decision: ApprovalDecision }
  | { type: 'reconnect' }
  | { type: 'open-options' }
  | { type: 'open-export-folder' }
  | { type: 'ops.clear' }
  | { type: 'session.unbind' }

/** Push broadcasts from the background to any open UI page. */
export type UiPush =
  | { type: 'push.status'; state: BridgeState; caps: BridgeCaps | null }
  | { type: 'push.affinity'; state: TabAffinityState }
  | { type: 'push.approval'; request: ApprovalRequest }
  | { type: 'push.approval-resolved'; id: string }
  | { type: 'push.op'; op: RecentOp }
  | { type: 'push.ops'; ops: RecentOp[] }
  | { type: 'push.ops-cleared' }

/** Fire a request and await its response value. */
export function sendUiRequest(message: UiRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      if (typeof chrome === 'undefined' || chrome.runtime === undefined) {
        resolve(undefined)
        return
      }
      chrome.runtime.sendMessage(message, (response: unknown) => {
        const error = chrome.runtime.lastError
        if (error !== undefined) reject(new Error(error.message))
        else resolve(response)
      })
    } catch (error: unknown) {
      reject(error)
    }
  })
}

/** Broadcast a push; a missing receiver (no UI open) is not an error. */
export function sendUiPush(message: UiPush): void {
  if (typeof chrome === 'undefined' || chrome.runtime === undefined) return
  void chrome.runtime.sendMessage(message).catch(() => {})
}
