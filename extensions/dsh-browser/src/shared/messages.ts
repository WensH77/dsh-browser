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
import type { BridgeNotice, BridgeState } from '../background/bridge.ts'
import type { TabAffinityState } from '../background/tab-affinity.ts'
import type { ApprovalDecision, ApprovalRequest } from '../security/approval.ts'
import type { SessionGrant, SessionGrantRevocation } from '../security/session-allowance.ts'
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
  /** Element the action actually resolved, reported by the page at execution time. */
  label?: string
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
  /** Handshake problem to show the user, or null when the pair agrees. */
  notice: BridgeNotice | null
  affinity: TabAffinityState
  controlled: ControlledTabInfo | null
  pendingApprovals: ApprovalRequest[]
  recentOps: RecentOp[]
  /** "Allow in this session" grants the controlled session holds right now. */
  sessionGrants: SessionGrant[]
  /**
   * Why the grants before those went away, or null.
   *
   * Carried in the snapshot as well as in the push, so a panel opened (or
   * reopened) after the fact can still explain why the next call asks again.
   */
  grantRevocation: SessionGrantRevocation | null
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
  | { type: 'push.status'; state: BridgeState; caps: BridgeCaps | null; notice: BridgeNotice | null }
  | { type: 'push.affinity'; state: TabAffinityState }
  | { type: 'push.approval'; request: ApprovalRequest }
  | { type: 'push.approval-resolved'; id: string }
  | { type: 'push.op'; op: RecentOp }
  | { type: 'push.ops'; ops: RecentOp[] }
  | { type: 'push.ops-cleared' }
  /**
   * The session's grants changed: one was given, or all of them were dropped.
   *
   * `sessionId` is what lets a panel watching one session ignore the others —
   * grants are per session, and a push for a session nobody is looking at must
   * not replace the list on screen.
   */
  | {
      type: 'push.session-grants'
      sessionId: string
      grants: SessionGrant[]
      revocation?: SessionGrantRevocation
    }

/** The grant-bearing fields of one `push.session-grants` frame. */
export type SessionGrantsPush = Extract<UiPush, { type: 'push.session-grants' }>

/**
 * Build one `push.session-grants` frame.
 *
 * The shape lives beside the type and the two ends that read it, so a field
 * renamed on one side fails a test here instead of quietly emptying the panel's
 * list of grants.
 *
 * @param sessionId - the session whose grants changed.
 * @param grants - what that session holds now.
 * @param revocation - what went away and why, omitted when a grant was added.
 * @returns the frame to broadcast.
 */
export function sessionGrantsPush(
  sessionId: string,
  grants: SessionGrant[],
  revocation?: SessionGrantRevocation,
): SessionGrantsPush {
  return {
    type: 'push.session-grants',
    sessionId,
    grants,
    ...revocation === undefined ? {} : { revocation },
  }
}

/** How long a UI request waits for the background before giving up. */
const UI_REQUEST_TIMEOUT_MS = 5_000

/**
 * Fire a request and await its response value.
 *
 * Fails with a message that names the request and what happened, because the
 * failure that matters here — the background did not answer — arrives from
 * Chrome as "The message port closed before a response was received", which
 * says nothing about which request died or whose side stalled. A request that
 * never settles is worse still: the UI would wait forever with no error at all.
 *
 * @param message - the request to deliver.
 * @returns the response value, or undefined for a request nobody handles.
 */
export function sendUiRequest(message: UiRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (act: () => void): void => {
      if (settled) return
      settled = true
      act()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`The background did not answer "${message.type}" within ${UI_REQUEST_TIMEOUT_MS}ms.`)))
    }, UI_REQUEST_TIMEOUT_MS)
    try {
      if (typeof chrome === 'undefined' || chrome.runtime === undefined) {
        clearTimeout(timer)
        resolve(undefined)
        return
      }
      chrome.runtime.sendMessage(message, (response: unknown) => {
        const error = chrome.runtime.lastError
        clearTimeout(timer)
        if (error !== undefined) {
          finish(() => reject(new Error(`"${message.type}" failed: ${error.message}`)))
        } else {
          finish(() => { resolve(response) })
        }
      })
    } catch (error: unknown) {
      clearTimeout(timer)
      finish(() => { reject(error instanceof Error ? error : new Error(String(error))) })
    }
  })
}

/** Broadcast a push; a missing receiver (no UI open) is not an error. */
export function sendUiPush(message: UiPush): void {
  if (typeof chrome === 'undefined' || chrome.runtime === undefined) return
  void chrome.runtime.sendMessage(message).catch(() => {})
}
