/**
 * Background service worker: pure-tool bridge client.
 *
 * Owns the token-authenticated WebSocket to the dsh bridge, controlled-tab
 * tool dispatch, tab affinity, and the small message surface shared by the
 * status side panel, the options page, and the action popup. There is no chat,
 * no session list, no event stream, and no host-question relay: those belong
 * to standard dsh clients now.
 *
 * The bridge connects on load (auto-discovery when no URL is configured) and
 * a half-minute `alarms` keepalive re-arms the reconnect loop. A `stopped`
 * state (for example code 4000: another browser owns the single bridge slot)
 * is terminal until the popup asks for a manual reconnect or the worker
 * restarts.
 *
 * Runtime message contract (see shared/messages.ts):
 *   ui → bg: { type: 'ui.state' } ⇒ UiState snapshot
 *   ui → bg: { type: 'settings.get' } ⇒ Settings
 *   ui → bg: { type: 'settings.set', patch } ⇒ Settings
 *   ui → bg: { type: 'approval.response', id, decision }
 *   ui → bg: { type: 'reconnect' } | { type: 'open-options' }
 *   bg → ui: push.status / push.affinity / push.approval / push.approval-resolved
 *            / push.session-grants / push.op / push.ops / push.ops-cleared
 *
 * @module
 */

import {
  BRIDGE_CONFIG_PATH,
  BRIDGE_GDRIVE_MOVE_METHOD,
  BRIDGE_OPEN_GDRIVE_FOLDER_METHOD,
  BRIDGE_PATH,
  MAX_BINDABLE_TABS,
  formatBindableTab,
  type BridgeCaps,
} from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { BridgeClient, type BridgeNotice, type BridgeState } from './bridge.ts'
import { bridgeNotice } from './bridge-notice.ts'
import { approvalFailureAnswer, dispatchToolCall, resetTabSnapshot, type ToolAnswer, type ToolCall } from './tools.ts'
import { approvalPromptForCall, setActionTrustPolicy } from './authorization.ts'
import {
  allowsSessionScope,
  isApprovalDecision,
  type ApprovalAuthorization,
  type ApprovalPrompt,
  type ApprovalRequest,
  type ApprovalVerdict,
} from '../security/approval.ts'
import {
  SessionAllowance,
  scopeKeyForCall,
  type SessionGrantRevocation,
  type SessionGrantRevocationReason,
} from '../security/session-allowance.ts'
import { getUiLocale } from '../i18n.ts'
import {
  actionCoveredByTrustedOrigins,
  normalizeTrustedOrigin,
  originMatchesTrusted,
} from '../security/trusted-origins.ts'
import {
  TabAffinityController,
  type AffinityTab,
} from './tab-affinity.ts'
import { FocusedWindowTracker } from './focused-window.ts'
import { ApprovalCoordinator, type ApprovalRequestResult } from './approval-coordinator.ts'
import { unboundNavigateDestination as resolveUnboundNavigateDestination } from './navigate-consent.ts'
import { detachDevtoolsSession, isSessionAttached, primeSession } from './devtools.ts'
import { visionAvailable } from './capture.ts'
import { debugToolRefusal } from './debug-policy.ts'
import { affinityFailureAnswer } from './affinity-copy.ts'
import { isExportableGdriveUrl, parseGdriveExportUrl } from './gdrive-url.ts'
import { waitForTabCommit } from './tab-commit.ts'
import { clearTabRules } from './net-rules.ts'
import { isExtensionPageSender } from '../shared/message-sender.ts'
import {
  SETTINGS_DEFAULTS,
  SETTINGS_STORAGE_KEY,
  type Settings,
} from '../shared/settings.ts'
import {
  sendUiPush,
  sessionGrantsPush,
  type ControlledTabInfo,
  type RecentOp,
  type UiState,
} from '../shared/messages.ts'

/** Re-exported for any consumer that referenced the worker's settings type. */
export type { Settings } from '../shared/settings.ts'

export const STORAGE_KEY = SETTINGS_STORAGE_KEY

/**
 * 自动探测的候选端口：
 * - dsh web（CLI）默认 3080，端口被占时依次回退 3081 / 3090；
 * - DSH Desktop 默认由系统随机分配本地 Web 端口（`dsh-desktop.port: 0`），
 *   用户指南推荐固定为 43189（见 deepseek-harness-desktop docs/user-guide）；
 * - 14389 为历史桌面应用端口，保留兼容旧版。
 */
const DISCOVERY_PORTS = [3080, 3081, 3090, 14389, 43189]
const LEGACY_LOCAL_URL = 'ws://127.0.0.1:3080'

/** 探测本机 dsh 的桥地址：fetch /ext/bridge-config 直到成功。 */
async function discoverBridge(shouldContinue: () => boolean = () => true): Promise<string | undefined> {
  for (const port of DISCOVERY_PORTS) {
    if (!shouldContinue()) return undefined
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ext/bridge-config`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (!shouldContinue()) return undefined
      if (!response.ok) continue
      const body = await response.json() as { wsUrl?: unknown }
      if (typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')) return body.wsUrl
    } catch {
      // 该端口没有 dsh 或未挂桥：试下一个。
    }
  }
  return undefined
}

/** Avoid opening a noisy loopback WebSocket until the local bridge responds. */
async function probeBridge(url: string): Promise<boolean> {
  try {
    const target = new URL(url)
    if (target.hostname !== '127.0.0.1') return true
    target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
    target.pathname = BRIDGE_CONFIG_PATH
    target.search = ''
    target.hash = ''
    const response = await fetch(target, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return false
    const body = await response.json() as { wsUrl?: unknown }
    return typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')
  } catch {
    return false
  }
}

const BRIDGE_KEEPALIVE_ALARM = 'bridge-keepalive'
const TAB_AFFINITY_STORAGE_KEY = 'dshTabAffinity'

type StoredTabAffinity =
  | { controlledTabId: number; sessionTabs?: Record<string, AffinityTab>; focusedSessionId?: string }
  | { lost: true; sessionTabs?: Record<string, AffinityTab>; focusedSessionId?: string }

let settings: Settings = { ...SETTINGS_DEFAULTS }
let caps: BridgeCaps | null = null
/** Last handshake failure, cleared by the next successful handshake. */
let handshakeNotice: BridgeNotice | null = null
let bridge: BridgeClient | null = null
const tabAffinity = new TabAffinityController()
const focusedWindow = new FocusedWindowTracker()
/** Ephemeral allowlist: cleared when the worker restarts. */
const sessionTrustedActionOrigins = new Set<string>()
/**
 * Per-session, per-action grants from "Allow in this session". Also ephemeral:
 * a worker restart drops them, and so does unbinding the session or closing
 * the tab it was driving.
 */
const sessionAllowances = new SessionAllowance()
/** Tool calls that can still be withdrawn by a bridge `tool.cancel` frame. */
const activeToolCalls = new Map<string, AbortController>()

/**
 * Read the in-flight tool calls from the worker's own console.
 *
 * The service worker is an ES module, so nothing declared in this file is
 * reachable from DevTools by name — and nothing logs this map either, which made
 * "did that download call leak?" impossible to answer from outside. Read-only,
 * and it answers exactly that: the ids still held, empty once a call has
 * settled. A held entry also keeps its closure alive, so a non-empty answer
 * after the call finished means the call never settled.
 */
;(globalThis as { __dshInFlightToolCalls?: () => string[] }).__dshInFlightToolCalls =
  () => [...activeToolCalls.keys()]
/** Origin of the dsh host we connect to (http://host:port), used to keep the
 * dsh web page itself out of the bindable targets. */
let bridgeOrigin: string | undefined
let bridgeHostPort: string | undefined

/** 127.0.0.1 / localhost / [::1] are the same loopback host for us. */
function normalizedHostPort(url: URL): string {
  const host = url.hostname === 'localhost' || url.hostname === '[::1]' ? '127.0.0.1' : url.hostname
  return `${host}:${url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port}`
}

/** Chrome Memory Saver may discard long-idle background tabs; a controlled
 * tab must stay live so the agent can operate it while the user chats in the
 * dsh page. autoDiscardable:false only prevents future discards. */
function keepTabAlive(tabId: number): void {
  void chrome.tabs.update(tabId, { autoDiscardable: false } as chrome.tabs.UpdateProperties).catch(() => {})
}

/** Is this page the dsh web UI we connect to (any loopback alias)? */
function isDshPageUrl(pageUrl: string): boolean {
  if (bridgeHostPort === undefined) return false
  try {
    const parsed = new URL(pageUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return normalizedHostPort(parsed) === bridgeHostPort
  } catch {
    return false
  }
}
/** Approvals awaiting a user decision, mirrored for the popup's ui.state. */
const pendingApprovals = new Map<string, ApprovalRequest>()
/** Open assistant pages (side panel / floating window) that can show cards. */
let assistantPages = 0

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'assistant') return
  assistantPages += 1
  port.onDisconnect.addListener(() => { assistantPages = Math.max(0, assistantPages - 1) })
})
let lastPersistedAffinity: string | undefined
let affinityPersistence = Promise.resolve()

function normalizeSettings(candidate: Settings): Settings {
  const trusted = Array.isArray(candidate.trustedActionOrigins)
    ? [...new Set(candidate.trustedActionOrigins.map(normalizeTrustedOrigin).filter((entry): entry is string => entry !== undefined))].sort()
    : []
  const sharePageContent = candidate.sharePageContent === 'auto' || candidate.sharePageContent === 'off'
    ? candidate.sharePageContent
    : candidate.sharePageContent === 'ask' ? 'ask' : 'auto'
  // Unknown/absent values fall back to the floating window (the default form).
  const statusMode = candidate.statusMode === 'panel' ? 'panel' : 'floating'
  return {
    ...candidate,
    sharePageContent,
    trustedActionOrigins: trusted,
    approvalNotifications: candidate.approvalNotifications !== false,
    statusMode,
    allowCrossDomainNavigation: candidate.allowCrossDomainNavigation === true,
    allowExtensionDebug: candidate.allowExtensionDebug === true,
    trustJsExecution: candidate.trustJsExecution === true,
    blockedOrigins: Array.isArray(candidate.blockedOrigins)
      ? [...new Set(candidate.blockedOrigins.map(normalizeTrustedOrigin).filter((entry): entry is string => entry !== undefined))].sort()
      : [],
  }
}

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
  const loaded = normalizeSettings({ ...SETTINGS_DEFAULTS, ...(stored[SETTINGS_STORAGE_KEY] as Partial<Settings> | undefined) })
  if (loaded.bridgeUrl === LEGACY_LOCAL_URL || loaded.bridgeUrl === `${LEGACY_LOCAL_URL}/`) {
    loaded.bridgeUrl = ''
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: loaded })
  }
  return loaded
}

async function persistSettings(next: Partial<Settings>): Promise<void> {
  settings = normalizeSettings({ ...settings, ...next })
  setActionTrustPolicy({ trustJsExecution: settings.trustJsExecution })
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings })
}

/** Settings load is shared by every lazy connection trigger. */
const settingsReady = loadSettings().then((loaded) => {
  settings = loaded
  setActionTrustPolicy({ trustJsExecution: loaded.trustJsExecution })
})

function armBridgeKeepalive(): void {
  chrome.alarms.create(BRIDGE_KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
}


/** Live status for the current controlled tab, if any. */
function controlledTabInfo(): ControlledTabInfo | null {
  const focused = tabAffinity.focusedSession()
  if (focused === null) return null
  const tab = tabAffinity.getSessionTab(focused)
  if (tab === undefined) return null
  return {
    sessionId: focused,
    tabId: tab.tabId,
    title: tab.title,
    url: tab.url,
  }
}

/**
 * Handshake problem to show the user, or null when both halves agree. A failed
 * handshake is reported by the bridge client; an older or newer host that still
 * talks to us is derived from the version it echoes in `hello.ok`.
 */
function currentBridgeNotice(): BridgeNotice | null {
  return bridgeNotice(bridge?.state ?? 'stopped', caps, handshakeNotice)
}

function uiState(): UiState {
  // Grants belong to the session the panel is showing, which is the focused one.
  const sessionId = tabAffinity.focusedSession()
  return {
    bridgeState: bridge?.state ?? 'stopped',
    caps,
    notice: currentBridgeNotice(),
    affinity: tabAffinity.snapshot(),
    controlled: controlledTabInfo(),
    pendingApprovals: [...pendingApprovals.values()],
    recentOps: activeOps(),
    sessionGrants: sessionId === null ? [] : sessionAllowances.grantsFor(sessionId),
    grantRevocation: sessionId === null ? null : sessionAllowances.revocationFor(sessionId) ?? null,
  }
}

/** Toolbar status light: a badge dot reflecting the latest operation.
 * idle -> grey, running -> green, waiting (approval pending) -> yellow,
 * failed/error -> red. */
const BADGE_DOT = '\u25CF'
const ACTIVITY_COLORS: Record<RecentOp['state'] | 'idle', string> = {
  running: '#22a06b',
  waiting: '#d97706',
  done: '#9aa1ab',
  error: '#c9372c',
  cancelled: '#9aa1ab',
  idle: '#9aa1ab',
}

function setStatusBadge(color: string, visible: boolean, text = BADGE_DOT): void {
  void Promise.resolve(chrome.action.setBadgeBackgroundColor({ color })).catch(() => {})
  void Promise.resolve(chrome.action.setBadgeText({ text: visible ? text : '' })).catch(() => {})
}

/** Recompute the toolbar light from the front of the operation feed. Only
 * running/waiting/error light up; idle/done/cancelled keep the icon clean. */
function applyActivityBadge(): void {
  const top = activeOps()[0]
  const state = top === undefined ? 'idle' : top.state
  const visible = state === 'running' || state === 'waiting' || state === 'error'
  setStatusBadge(ACTIVITY_COLORS[state], visible)
}

/** Pending approvals take priority: a red '?' means someone must decide. */
function refreshBadge(): void {
  if (pendingApprovals.size > 0) {
    setStatusBadge('#c9372c', true, '?')
    return
  }
  applyActivityBadge()
}

function broadcastStatus(): void {
  sendUiPush({ type: 'push.status', state: bridge?.state ?? 'stopped', caps, notice: currentBridgeNotice() })
}

function broadcastTabAffinity(): void {
  sendUiPush({ type: 'push.affinity', state: tabAffinity.snapshot() })
  // Focus/bind changes switch which session's operations are shown.
  sendUiPush({ type: 'push.ops', ops: activeOps() })
  queueDevtoolsPriming()
}

/**
 * Tell the panel what one session holds now, and why it holds less than before.
 *
 * Nothing else reports a session grant: without this push the panel saw a card,
 * the user allowed it, and a later card simply appeared again — with no way to
 * learn that the binding change in between had thrown the grant away.
 *
 * @param sessionId - the session whose grants changed.
 * @param revocation - what was dropped and why; omitted when a grant was added.
 */
function broadcastSessionGrants(sessionId: string, revocation?: SessionGrantRevocation): void {
  sendUiPush(sessionGrantsPush(sessionId, sessionAllowances.grantsFor(sessionId), revocation))
}

/** Bound tabs we already hold an eager debugging session for. */
const primedTabs = new Set<number>()
/** Upper bound on simultaneous eager sessions; one bound tab is the normal case. */
const MAX_PRIMED_TABS = 3
let primingQueue: Promise<void> = Promise.resolve()

/**
 * Attach the debugger to every bound tab as soon as it is bound, so console
 * and network capture the page's own load rather than starting at the model's
 * first read. Detaches tabs that stopped being bound, and everything when the
 * user turns debugging off. Serialized and idempotent: affinity events are
 * frequent, and priming must never overlap itself.
 */
function queueDevtoolsPriming(): void {
  primingQueue = primingQueue.then(syncDevtoolsPriming, syncDevtoolsPriming)
}

async function syncDevtoolsPriming(): Promise<void> {
  await affinityReady
  const wanted = new Set<number>()
  if (settings.allowExtensionDebug && visionAvailable()) {
    for (const tab of Object.values(tabAffinity.sessionMap())) {
      wanted.add(tab.tabId)
      if (wanted.size >= MAX_PRIMED_TABS) break
    }
  }
  for (const tabId of [...primedTabs]) {
    if (wanted.has(tabId)) continue
    primedTabs.delete(tabId)
    await detachDevtoolsSession(tabId).catch(() => undefined)
  }
  for (const tabId of wanted) {
    // The user can dismiss the debugging notice, which detaches us; a stale
    // entry must not stop us from priming that tab again.
    if (primedTabs.has(tabId) && isSessionAttached(tabId)) continue
    primedTabs.delete(tabId)
    try {
      await primeSession(tabId)
      primedTabs.add(tabId)
    } catch {
      // Best effort: DevTools holds that tab, it is a protected page, or this
      // build has no chrome.debugger. The lazy path reports it if the model asks.
    }
  }
}

const APPROVAL_NOTIFICATION_PREFIX = 'dsh-browser-approval:'

function approvalNotificationId(id: string): string {
  return `${APPROVAL_NOTIFICATION_PREFIX}${id}`
}

function deliverApproval(request: ApprovalRequest): boolean {
  pendingApprovals.set(request.id, request)
  refreshBadge()
  if (assistantPages > 0) {
    // A live assistant page will render the card from push.approval.
    sendUiPush({ type: 'push.approval', request })
    return true
  }
  // No assistant UI is open: pop the floating window so the card is hard to
  // miss (side-panel mode cannot open without a gesture, so keep the OS
  // notification as the fallback there).
  openStatusSurface()
  notifyApproval(request)
  return true
}

function notifyApproval(request: ApprovalRequest): void {
  if (!settings.approvalNotifications) return
  const copy = getUiLocale() === 'zh'
    ? {
        title: '浏览器操作等待确认',
        message: '点击打开 dsh 浏览器助手，并在 60 秒内确认或拒绝。',
      }
    : {
        title: 'Browser action awaiting approval',
        message: 'Click to open dsh Browser Assistant, then allow or deny within 60 seconds.',
      }
  void Promise.resolve(chrome.notifications.create(approvalNotificationId(request.id), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
    title: copy.title,
    message: copy.message,
    requireInteraction: true,
  })).catch(() => {})
}

function clearApprovalNotification(id: string): void {
  void Promise.resolve(chrome.notifications.clear(approvalNotificationId(id))).catch(() => {})
}

function approvalResolved(id: string): void {
  pendingApprovals.delete(id)
  refreshBadge()
  clearApprovalNotification(id)
  sendUiPush({ type: 'push.approval-resolved', id })
}

const approvals = new ApprovalCoordinator({
  deliver: (request) => {
    if (deliverApproval(request)) return true
    notifyApproval(request)
    return false
  },
  notify: notifyApproval,
  clearNotification: clearApprovalNotification,
  resolved: approvalResolved,
})

function cancelPendingApprovals(sessionId?: string): void {
  approvals.cancelAll(sessionId)
}

/**
 * Drop everything a session was granted or is waiting on.
 *
 * "Allow in this session" earns its name here: the grant covers one session
 * driving the controlled tab, so it goes away with the binding that defined it —
 * the session is bound to another tab, that tab is closed or replaced, or the
 * user unbinds — and does not survive into a later session that happens to reuse
 * the tab.
 *
 * @param sessionId - the session losing its grants.
 * @param reason - what happened to the controlled tab, so the panel can explain
 *   why the next call asks again instead of leaving the user to guess.
 */
function forgetSession(sessionId: string, reason: SessionGrantRevocationReason): void {
  const revocation = sessionAllowances.revoke(sessionId, reason)
  cancelPendingApprovals(sessionId)
  if (revocation !== undefined) broadcastSessionGrants(sessionId, revocation)
}

function summarizeTab(tab: chrome.tabs.Tab): AffinityTab | null {
  if (tab.id === undefined) return null
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? '',
  }
}

function storedAffinity(): StoredTabAffinity | null {
  const state = tabAffinity.snapshot()
  const sessionTabs = tabAffinity.sessionMap()
  const hasSessionTabs = Object.keys(sessionTabs).length > 0
  const focusedSessionId = tabAffinity.focusedSession()
  const focus = focusedSessionId === null ? {} : { focusedSessionId }
  if (state.controlled !== null) {
    return {
      controlledTabId: state.controlled.tabId,
      ...(hasSessionTabs ? { sessionTabs } : {}),
      ...focus,
    }
  }
  return state.status === 'lost'
    ? { lost: true, ...(hasSessionTabs ? { sessionTabs } : {}), ...focus }
    : (hasSessionTabs ? { lost: true, sessionTabs, ...focus } : null)
}

function persistTabAffinity(): void {
  const record = storedAffinity()
  const serialized = JSON.stringify(record)
  if (serialized === lastPersistedAffinity) return
  lastPersistedAffinity = serialized
  affinityPersistence = affinityPersistence.catch(() => {}).then(async () => {
    if (record === null) await chrome.storage.session.remove(TAB_AFFINITY_STORAGE_KEY)
    else await chrome.storage.session.set({ [TAB_AFFINITY_STORAGE_KEY]: record })
  }).catch(() => {
    if (lastPersistedAffinity === serialized) lastPersistedAffinity = undefined
  })
}

/**
 * Record which tab the user is looking at.
 *
 * A focus change is not a rebinding: the session keeps operating the tab it was
 * bound to, and anything it is waiting on stays valid. That is the whole point
 * of "operate the page in the background" — and the approval card lives in the
 * dsh page, so a user who switches to another tab to reach it (Gmail, the
 * panel's own window) must not have the prompt withdrawn under them. Consent
 * still dies with the binding it was given for: unbind, tab close, or an
 * explicit bind elsewhere.
 */
function observeActiveSummary(summary: AffinityTab): void {
  if (!tabAffinity.observeActive(summary)) return
  persistTabAffinity()
  broadcastTabAffinity()
}

function observeActiveTab(tab: chrome.tabs.Tab): void {
  const summary = summarizeTab(tab)
  if (summary !== null) observeActiveSummary(summary)
}

async function syncActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const queryRevision = focusedWindow.beginQuery()
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab === undefined) return undefined
    if (!focusedWindow.commitQuery(tab.windowId, queryRevision)) return undefined
    observeActiveTab(tab)
    return tab
  } catch {
    return undefined
  }
}

async function restoreTabAffinity(): Promise<void> {
  let record: StoredTabAffinity | null = null
  try {
    const stored = await chrome.storage.session.get(TAB_AFFINITY_STORAGE_KEY)
    const candidate = stored[TAB_AFFINITY_STORAGE_KEY] as Partial<StoredTabAffinity> | undefined
    const controlledTabId = (candidate as { controlledTabId?: unknown } | undefined)?.controlledTabId
    const focusedSessionId = (candidate as { focusedSessionId?: unknown } | undefined)?.focusedSessionId
    const focus = typeof focusedSessionId === 'string' && focusedSessionId.trim() !== '' ? { focusedSessionId } : {}
    if (typeof controlledTabId === 'number' && Number.isInteger(controlledTabId) && controlledTabId >= 0) {
      const sessionTabs = (candidate as { sessionTabs?: Record<string, AffinityTab> }).sessionTabs
      record = {
        controlledTabId,
        ...(typeof sessionTabs === 'object' && sessionTabs !== null ? { sessionTabs } : {}),
        ...focus,
      }
    } else if ((candidate as { lost?: unknown } | undefined)?.lost === true) {
      const sessionTabs = (candidate as { sessionTabs?: Record<string, AffinityTab> }).sessionTabs
      record = {
        lost: true,
        ...(typeof sessionTabs === 'object' && sessionTabs !== null ? { sessionTabs } : {}),
        ...focus,
      }
    }
    lastPersistedAffinity = candidate === undefined || record !== null
      ? JSON.stringify(record)
      : undefined
  } catch {
    // Session storage is a survival aid, not a reason to disable the bridge.
  }

  if (record?.sessionTabs !== undefined) {
    const restoredSessions: Record<string, AffinityTab> = {}
    for (const [sid, storedTab] of Object.entries(record.sessionTabs)) {
      if (typeof storedTab?.tabId !== 'number' || !Number.isInteger(storedTab.tabId) || storedTab.tabId < 0) continue
      try {
        const live = summarizeTab(await chrome.tabs.get(storedTab.tabId))
        if (live !== null) restoredSessions[sid] = live
      } catch {
        // Closed tabs are deliberately pruned so the session fails closed.
      }
    }
    tabAffinity.restoreSessionTabs(restoredSessions)
  }
  tabAffinity.restoreFocusedSession(record?.focusedSessionId ?? null)
  // Bindings are exclusive, but a record written before that was enforced can
  // name several sessions. Keep the one the panel was showing and release the
  // rest, so a worker restart cannot leave two sessions on the browser.
  for (const dropped of tabAffinity.dropCompetingBindings(tabAffinity.focusedSession())) {
    forgetSession(dropped, 'rebind')
  }

  if (record !== null && 'controlledTabId' in record) {
    try {
      const controlled = summarizeTab(await chrome.tabs.get(record.controlledTabId))
      if (controlled === null) tabAffinity.restoreLost()
      else tabAffinity.restoreControlled(controlled)
    } catch {
      tabAffinity.restoreLost()
    }
  } else if (record?.lost === true) {
    tabAffinity.restoreLost()
  }

  await syncActiveTab()
  persistTabAffinity()
  broadcastTabAffinity()
}

const affinityReady = restoreTabAffinity()

/**
 * Bind a session's controlled tab on its first browser call. The chat panel
 * used to bind at prompt submission; with the pure-tool bridge the first
 * `tool.call` for an unbound session takes the page the user is currently
 * viewing (bindInitial semantics), so a chat-less agent can still operate a
 * real tab.
 *
 * @returns undefined once the session owns a tab, else the answer that settles
 * the call — "another session holds the browser" when that is why.
 */
async function ensureInitialTabBinding(sessionId?: string): Promise<ToolAnswer | undefined> {
  await affinityReady
  const alreadyBound = sessionId === undefined
    ? tabAffinity.resolveTarget().kind !== 'initial'
    : tabAffinity.hasBinding(sessionId)
  if (alreadyBound) return undefined
  // One controlled tab, one session: a second session cannot take the page by
  // calling a tool. Nothing is bound and nothing runs until the user frees it.
  const holder = sessionId === undefined ? undefined : tabAffinity.competingBinding(sessionId)
  if (holder !== undefined) return takenBindingAnswer(holder)
  try {
    const tab = await syncActiveTab()
    const summary = tab === undefined ? null : summarizeTab(tab)
    if (summary === null) return affinityFailureAnswer('missing')
    // Never hand the dsh web page itself to a session: the user chats there.
    // For a URL-less first call the user should switch to the target page (or
    // let browser_navigate open a fresh, separately approved tab).
    if (isDshPageUrl(summary.url)) return affinityFailureAnswer('missing')
    if (tabAffinity.bindInitial(summary, sessionId)) {
      keepTabAlive(summary.tabId)
      persistTabAffinity()
      broadcastTabAffinity()
    }
    return undefined
  } catch {
    return affinityFailureAnswer('missing')
  }
}

/** The answer for a call that wants a browser another session already owns. */
function takenBindingAnswer(holder: { sessionId: string; tab: AffinityTab }): ToolAnswer {
  return affinityFailureAnswer('taken', { sessionId: holder.sessionId, url: holder.tab.url })
}


/** Resolve one stable tab target without allowing a manual switch to drift it. */
async function resolveToolTab(sessionId?: string): Promise<Pick<chrome.tabs.Tab, 'id' | 'url' | 'windowId'> | ToolAnswer> {
  await affinityReady
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resolution = tabAffinity.resolveTarget(sessionId)
    if (resolution.kind === 'handoff') return affinityFailureAnswer('handoff')
    if (resolution.kind === 'lost') {
      // A session-scoped call with no binding yet auto-binds the page the
      // user is currently viewing (pure-tool bridge has no chat prompt to
      // bind on). A previously bound tab that was closed re-binds on the
      // next call; failing that, report the tab as unavailable.
      if (sessionId !== undefined && sessionId.trim() !== '') {
        const bindingFailure = await ensureInitialTabBinding(sessionId)
        if (bindingFailure !== undefined) return bindingFailure
        continue
      }
      return affinityFailureAnswer('lost')
    }
    if (resolution.kind === 'initial') {
      const bindingFailure = await ensureInitialTabBinding(sessionId)
      if (bindingFailure !== undefined) return bindingFailure
      continue
    }
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      const summary = summarizeTab(tab)
      if (summary === null) return affinityFailureAnswer('missing')
      keepTabAlive(summary.tabId)
      if (tabAffinity.observeTab(summary)) broadcastTabAffinity()
      const current = tabAffinity.resolveTarget(sessionId)
      if (current.kind === 'handoff') return affinityFailureAnswer('handoff')
      if (current.kind === 'lost') return affinityFailureAnswer('lost')
      if (current.kind === 'target' && current.tab.tabId === summary.tabId) return tab
    } catch {
      const affectedSessions = tabAffinity.sessionIdsForTab(resolution.tab.tabId)
      if (tabAffinity.removeTab(resolution.tab.tabId)) {
        for (const sid of affectedSessions) forgetSession(sid, 'closed')
        persistTabAffinity()
        broadcastTabAffinity()
      }
      return affinityFailureAnswer('lost')
    }
  }
  return affinityFailureAnswer('handoff')
}

async function authorizeToolCall(
  call: ToolCall,
  prompt: ApprovalPrompt,
  signal: AbortSignal,
  windowId: number,
  sessionId?: string,
): Promise<ApprovalAuthorization> {
  if (signal.aborted) return 'cancelled'
  if (actionCoveredByTrustedOrigins(
    prompt,
    sessionTrustedActionOrigins,
    settings.trustedActionOrigins,
  )) {
    return 'approved'
  }
  const result: ApprovalRequestResult = await approvals.request(prompt, signal, windowId, sessionId)
  if (signal.aborted) return 'cancelled'
  if (result.status !== 'decision') {
    // The prompt expired with nobody watching. The call has not run and the
    // worker is still alive, so the caller may raise a fresh prompt instead of
    // failing an operation the model already asked for.
    return result.status === 'timed-out' ? 'renew' : result.status
  }
  const { decision } = result
  if (decision === 'always-allow-reads' && prompt.kind === 'read') {
    await persistSettings({ sharePageContent: 'auto' })
    return 'approved'
  }
  if (decision === 'trust-session' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    sessionTrustedActionOrigins.add(prompt.origins[0]!)
    return 'approved'
  }
  if (decision === 'trust-origin' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    await persistSettings({ trustedActionOrigins: [...settings.trustedActionOrigins, prompt.origins[0]!] })
    return 'approved'
  }
  // The decision itself was only "once": the grant the user actually chose
  // covers the rest of this session, so record it before the action runs.
  if (allowsSessionScope(decision, { kind: prompt.kind, action: prompt.action, sessionId })
    && sessionId !== undefined) {
    sessionAllowances.remember(sessionId, scopeKeyForCall(call.name, call.args ?? {}), call.name)
    broadcastSessionGrants(sessionId)
    return 'approved'
  }
  return decision === 'allow-once' ? 'approved' : 'denied'
}

/**
 * Whether this call is already covered by a grant the user gave this session.
 *
 * Every consent gate reads this before it raises anything, so a granted action
 * neither shows a card nor rings a notification for the rest of the session.
 * The gate that forgets it is a gate that keeps asking after the user already
 * answered — which is what this predicate exists to prevent, so treat it as the
 * first line of every new gate rather than an optimization.
 */
function coveredBySessionGrant(call: ToolCall): boolean {
  return sessionAllowances.allows(call.sessionId, scopeKeyForCall(call.name, call.args ?? {}))
}

/**
 * Consent for one page-tool call: waiting → running as consent settles.
 *
 * A grant this session already holds ends the question before the card is
 * shown, which is the whole point of "Allow in this session": the user answered
 * once, for this session and this action, and is not asked again. The grant
 * short-circuits the *prompt* only — `dispatchToolCall` still re-reads the
 * frames and re-checks the page boundary after this returns, so a granted call
 * is no less fail-closed than a prompted one.
 */
async function authorizeCall(call: ToolCall, prompt: ApprovalPrompt, windowId: number, signal: AbortSignal): Promise<ApprovalAuthorization> {
  if (coveredBySessionGrant(call)) {
    settleOp(call.id, 'running')
    return 'approved'
  }
  settleOp(call.id, 'waiting')
  const authorization = await authorizeToolCall(call, prompt, signal, windowId, call.sessionId)
  if (authorization === 'approved') settleOp(call.id, 'running')
  return authorization
}

/**
 * The answer for a call whose prompt expired while nobody was looking.
 *
 * The operation never started, so the honest answer is "not approved yet" plus
 * the one action that can fix it: the model asks again, which raises a fresh
 * 60-second prompt in the side panel.
 */
function gatedToolRenewalAnswer(prompt: ApprovalPrompt): ToolAnswer {
  return {
    ok: false,
    error: {
      code: 'timeout',
      message: `The approval prompt for "${prompt.action}" expired before the user answered it. `
        + 'Nothing ran — call the tool again to raise a fresh prompt in the side panel.',
    },
  }
}

/** Window an approval may anchor to when no controlled tab exists yet. */
async function approvalAnchorWindowId(): Promise<number> {
  try {
    const window = await chrome.windows.getLastFocused()
    if (window.id !== undefined) return window.id
  } catch {
    // Fall through to Chrome's own current-window sentinel.
  }
  return chrome.windows.WINDOW_ID_CURRENT
}

/**
 * Consent + open for an unbound session's first navigate.
 *
 * The destination is approved first and the tab is created only after approval,
 * so a denied or unanswered call issues no request at all. Returns undefined
 * when the call is not that case, leaving the bound-tab path to handle it.
 *
 * @param call - the tool call under dispatch.
 * @param authorize - approval bridge supplied by the caller (UI + trust policy).
 * @returns the settled answer when this path handled the call, else undefined.
 */
async function authorizeUnboundNavigate(
  call: ToolCall,
  authorize: (prompt: ApprovalPrompt) => Promise<ApprovalVerdict>,
): Promise<ToolAnswer | undefined> {
  const destination = unboundNavigateDestination(call)
  if (destination === undefined) return undefined
  const sessionId = call.sessionId
  if (sessionId === undefined || sessionId.trim() === '') return undefined
  // A fresh tab is still a binding, so a navigate cannot take the browser away
  // from the session that owns it. Checked before the destination prompt: there
  // is no point approving a URL this call is not allowed to open.
  const holder = tabAffinity.competingBinding(sessionId)
  if (holder !== undefined) return takenBindingAnswer(holder)
  const policyFailure = destinationPolicyFailure(destination.href)
  if (policyFailure !== undefined) return policyFailure
  // No session-grant check here on purpose: `browser_navigate` cannot hold one
  // (see SESSION_SCOPABLE_ACTIONS), so this path is always a fresh prompt, and
  // the destination it approves is the destination it opens.
  const prompt = approvalPromptForCall(call, settings.sharePageContent, [])
  if (prompt === undefined) return undefined
  const authorization = await authorize(prompt)
  if (authorization !== 'approved') return approvalFailureAnswer(prompt, authorization)
  const opened = await openBoundTab(sessionId, destination)
  if (!opened) {
    return {
      ok: false,
      error: {
        code: 'no-active-tab',
        message: `Approved navigation to ${destination.href}, but the new tab could not be opened or bound. Retry the call.`,
      },
    }
  }
  return {
    ok: true,
    result: {
      text: `Navigating to ${destination.href} in a new tab. The new tab has started loading; `
        + 'call browser_snapshot (or browser_wait) to read it once it has rendered.',
    },
  }
}

/** 把协商的快照预算下发到受控页（尚未绑定时使用活动页）。 */
async function pushBudgetToControlledTab(negotiated: BridgeCaps): Promise<void> {
  await affinityReady
  const resolution = tabAffinity.resolveTarget()
  const tabId = resolution.kind === 'target'
    ? resolution.tab.tabId
    : resolution.kind === 'initial'
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id
      : undefined
  if (tabId === undefined) return
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'DSH_BUDGET',
      budget: { maxItems: negotiated.maxInteractiveItems, maxChars: negotiated.snapshotMaxChars },
    })
  } catch {
    // 页面尚未注入 content script：下一次快照仍用默认预算，可接受。
  }
}

/**
 * A session with no bound tab that asks to navigate gets a brand-new tab
 * (_blank-like: same profile, login state preserved) instead of hijacking
 * whatever page happens to be active — in particular the dsh web chat page.
 * The session is bound to the fresh tab, so later calls operate it even in
 * the background.
 *
 * Consent ordering: the destination is approved BEFORE the tab exists. The
 * earlier shape created the tab first, which meant a denied or unanswered
 * navigate still loaded the URL — a real request the user never authorized.
 */

/** The http(s) destination of an unbound-session navigate, or undefined when this is not that case. */
function unboundNavigateDestination(call: ToolCall): URL | undefined {
  const sessionId = call.sessionId
  const bound = sessionId === undefined ? undefined : tabAffinity.getSessionTab(sessionId)
  return resolveUnboundNavigateDestination(
    {
      name: call.name,
      ...sessionId === undefined ? {} : { sessionId },
      args: call.args,
      ...bound === undefined ? {} : { boundUrl: bound.url },
    },
    isDshPageUrl,
  )
}

/** Open the destination in a fresh tab and bind the session to it. */
async function openBoundTab(sessionId: string, destination: URL): Promise<boolean> {
  const created = await chrome.tabs.create({ url: destination.href, active: true })
  // `create` resolves before the destination commits: binding that snapshot
  // leaves the session pointing at an empty URL, and the next tool call fails
  // with "this page does not support browser operations". Wait for the commit,
  // falling back to the create-time snapshot if the tab is slow or closed.
  const committed = created.id === undefined ? undefined : await waitForTabCommit(created.id)
  const summary = summarizeTab(committed ?? created)
  if (summary === null) return false
  await affinityReady
  if (tabAffinity.hasBinding(sessionId)) return true
  if (!tabAffinity.bindNewSession(sessionId, summary)) return true
  keepTabAlive(summary.tabId)
  persistTabAffinity()
  broadcastTabAffinity()
  return true
}

/** Read-only activity feed shown in the assistant (operations, not chat). */
const RECENT_OPS_MAX = 30
let recentOps: RecentOp[] = []

/** Operations of the currently focused (bound) session only. */
function activeOps(): RecentOp[] {
  const focused = tabAffinity.focusedSession()
  return focused === null ? [] : recentOps.filter((op) => op.sessionId === focused)
}

/** Whether a single op should reach the UI right now. */
function opVisible(op: RecentOp): boolean {
  const focused = tabAffinity.focusedSession()
  return focused !== null && op.sessionId === focused
}

function recordOpStart(call: ToolCall): void {
  const op: RecentOp = { id: call.id, name: call.name, args: call.args ?? {}, sessionId: call.sessionId, state: 'running', startedAt: Date.now() }
  recentOps = [op, ...recentOps.filter((o) => o.id !== op.id)].slice(0, RECENT_OPS_MAX)
  refreshBadge()
  if (opVisible(op)) sendUiPush({ type: 'push.op', op })
}

/** Attach what the page resolved for an operation, so the feed can name it. */
function labelOp(id: string, label: string): void {
  const index = recentOps.findIndex((op) => op.id === id)
  if (index === -1) return
  const op = { ...recentOps[index]!, label }
  recentOps = [op, ...recentOps.filter((o) => o.id !== id)].slice(0, RECENT_OPS_MAX)
  if (opVisible(op)) sendUiPush({ type: 'push.op', op })
}

function settleOp(id: string, state: RecentOp['state']): void {
  const index = recentOps.findIndex((op) => op.id === id)
  if (index === -1) return
  const op = { ...recentOps[index]!, state, ...(state === 'running' || state === 'waiting' ? {} : { endedAt: Date.now() }) }
  recentOps = [op, ...recentOps.filter((o) => o.id !== id)].slice(0, RECENT_OPS_MAX)
  refreshBadge()
  if (opVisible(op)) sendUiPush({ type: 'push.op', op })
}

function originOfUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

function hostnameOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

/** Whether this URL is a Google Doc/Sheet that the export path owns. */
function isDriveFileUrl(value: string): boolean {
  return isExportableGdriveUrl(value)
}

/** Settings-policy guard: blocked list, Drive-file routing, cross-host navigation. */
/** Refuse an origin the user blocked, whatever operation is about to touch it. */
function blockedOriginFailure(url: string): ToolAnswer | undefined {
  const origin = originOfUrl(url)
  if (origin !== undefined && originMatchesTrusted(origin, settings.blockedOrigins)) {
    return { ok: false, error: { code: 'action-failed', message: `Operations on ${origin} are blocked in Settings (blocked list).` } }
  }
  return undefined
}

/**
 * Destination-only navigation policy: blocked origins, and Google Docs/Sheets
 * that this bridge exports rather than opens, are decided before any consent
 * prompt or tab creation. Slides and Drive files are ordinary pages here.
 */
function destinationPolicyFailure(destinationUrl: string): ToolAnswer | undefined {
  const blocked = blockedOriginFailure(destinationUrl)
  if (blocked !== undefined) return blocked
  if (isDriveFileUrl(destinationUrl)) {
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: 'This is a Google Doc or Sheet, which this bridge exports instead of opening: read it with google_drive_export. '
          + '(Slides and Drive files are ordinary pages — navigate to those and read them with the page tools.)',
      },
    }
  }
  return undefined
}

function operationGuard(call: ToolCall, tab: { url?: string }): ToolAnswer | undefined {
  if (call.name === 'browser_navigate') {
    const destinationUrl = typeof call.args?.url === 'string' ? call.args.url : ''
    const destinationFailure = destinationPolicyFailure(destinationUrl)
    if (destinationFailure !== undefined) return destinationFailure
    // Default policy: stay on the host of the currently bound page. Initial
    // navigation (new-tab binding) and explicit "bind to the page" are the
    // supported ways to switch; same domain with another host (e.g. another
    // environment) counts as different.
    if (!settings.allowCrossDomainNavigation) {
      const currentHost = hostnameOf(tab.url ?? '')
      const destinationHost = hostnameOf(destinationUrl)
      if (currentHost !== undefined && destinationHost !== undefined && currentHost !== destinationHost) {
        return {
          ok: false,
          error: { code: 'action-failed', message: 'Navigation to a different host is blocked by default (the agent may only navigate within the host of the currently bound page). '
            + 'Switch pages with initial navigation or "bind to the page", or enable "Allow cross-domain navigation" in the extension options.' },
        }
      }
    }
    return undefined
  }
  // Reads and actions on the current controlled page.
  const blockedBySettings = blockedOriginFailure(tab.url ?? '')
  if (blockedBySettings !== undefined) return blockedBySettings
  const pageUrl = tab.url ?? ''
  if (isDriveFileUrl(pageUrl)) {
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: 'This page is a Google Doc or Sheet. Read it with google_drive_export using its URL instead of page tools. '
          + '(Slides and Drive files are read with the page tools.)',
      },
    }
  }
  return undefined
}

/** One-shot extension -> host internal RPC calls (options buttons etc.). */
const pendingBridgeRpcs = new Map<string, {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}>()

function bridgeRpc(method: string, payload: unknown): Promise<unknown> {
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const socket = bridge
    if (socket === null) { reject(new Error('Bridge is not connected')); return }
    pendingBridgeRpcs.set(id, { resolve, reject })
    socket.send({ t: 'rpc', id, method, payload })
    setTimeout(() => {
      const pending = pendingBridgeRpcs.get(id)
      if (pending !== undefined) {
        pendingBridgeRpcs.delete(id)
        pending.reject(new Error(`Bridge RPC ${method} timed out`))
      }
    }, 15_000)
  })
}

function settleBridgeRpc(id: string, ok: boolean, result: unknown): void {
  const pending = pendingBridgeRpcs.get(id)
  if (pending === undefined) return
  pendingBridgeRpcs.delete(id)
  if (ok) pending.resolve(result)
  else pending.reject(new Error(result instanceof Error ? result.message : String(result)))
}

/**
 * Fail every internal RPC still waiting on the socket.
 *
 * Without this, a dropped connection left callers waiting out the 15-second
 * timer and then reporting a *timeout* — a wrong reason for what actually
 * happened, and 15 seconds of a button doing nothing.
 */
function settlePendingBridgeRpcs(reason: string): void {
  if (pendingBridgeRpcs.size === 0) return
  const waiting = [...pendingBridgeRpcs.values()]
  pendingBridgeRpcs.clear()
  for (const pending of waiting) pending.reject(new Error(reason))
}

interface PendingDownload {
  resolve: (filename: string) => void
  reject: (error: Error) => void
  filename: string | undefined
}

const pendingDownloads = new Map<number, PendingDownload>()

chrome.downloads.onChanged.addListener((delta) => {
  const pending = pendingDownloads.get(delta.id)
  if (pending === undefined) return
  // filename usually arrives in an early delta (creation/interruption), not
  // necessarily in the 'complete' one — cache whichever we see first.
  if (delta.filename?.current !== undefined && delta.filename.current !== '') {
    pending.filename = delta.filename.current
  }
  if (delta.state?.current === 'complete') {
    pendingDownloads.delete(delta.id)
    if (pending.filename !== undefined) pending.resolve(pending.filename)
    else pending.reject(new Error('Google export produced no downloadable file (the account may lack access, or a consent/login page was returned)'))
  } else if (delta.state?.current === 'interrupted') {
    pendingDownloads.delete(delta.id)
    pending.reject(new Error(delta.error?.current != null ? `Download interrupted: ${delta.error.current}` : 'Download was interrupted'))
  }
})

async function downloadToPath(url: string, filename: string, timeoutMs = 120_000): Promise<string> {
  const id = await chrome.downloads.download({
    url,
    filename: `dsh-gdrive/${filename}`,
    conflictAction: 'uniquify',
    saveAs: false,
  })
  // The promise is created -- and its settle callbacks are assigned -- before
  // the first await. `onChanged` deletes the map entry and settles through
  // these callbacks, so a download that completes while we are still seeding
  // the filename must still settle the caller: assigning them later (as this
  // used to) left the real resolve unset and the call hanging until the host
  // timed out, with the entry and timer leaked.
  let settleResolve: (filename: string) => void = () => {}
  let settleReject: (error: Error) => void = () => {}
  const pending: PendingDownload = {
    filename: undefined,
    resolve: (value) => settleResolve(value),
    reject: (error) => settleReject(error),
  }
  const settled = new Promise<string>((resolve, reject) => {
    settleResolve = resolve
    settleReject = reject
  })
  pendingDownloads.set(id, pending)
  // Seed the filename immediately from the download record when available.
  const found = await chrome.downloads.search({ id }).catch(() => [])
  if (found.length > 0 && found[0]?.filename !== undefined && pending.filename === undefined) {
    pending.filename = found[0].filename
  }
  const timer = setTimeout(() => {
    if (pendingDownloads.get(id) === pending) {
      pendingDownloads.delete(id)
      settleReject(new Error('Download timed out'))
    }
  }, timeoutMs)
  return settled.finally(() => { clearTimeout(timer) })
}

/**
 * Download via the real browser session, then move it into the session folder.
 */

async function downloadGdriveFile(target: { id: string; kind: string }, url: string, ext: string, sessionId: string | undefined, name?: string): Promise<{ filePath: string }> {
  const source = await downloadToPath(url, name ?? `${target.kind}-${target.id}.${ext}`)
  const move = await bridgeRpc(BRIDGE_GDRIVE_MOVE_METHOD, { sourcePath: source, sessionId: sessionId ?? 'anonymous' })
  const filePath = typeof (move as { filePath?: unknown })?.filePath === 'string' ? (move as { filePath: string }).filePath : String(move)
  return { filePath }
}

/** Tools the background answers itself (no page content script involved). */
const VIRTUAL_TOOL_NAMES = new Set(['browser_list_tabs', 'browser_bind_tab', 'gdrive.fetch'])

/** Chrome-internal or otherwise unbindable pages never enter the list. */
function isBindableTabUrl(url: string | undefined): boolean {
  return url !== undefined && /^https?:/i.test(url) && !isDshPageUrl(url)
}

/**
 * Consent for a background-answered call runs through the same gate as a page
 * action: trust (session or persistent) short-circuits it, and a decision,
 * denial, timeout, or missing panel settles with the standard answer.
 *
 * @returns undefined when the call may proceed, else the settled answer.
 */
async function virtualToolGate(call: ToolCall, controller: AbortController): Promise<ToolAnswer | undefined> {
  const url = typeof call.args?.url === 'string' ? call.args.url : ''
  const blocked = blockedOriginFailure(url)
  if (blocked !== undefined) return blocked
  if (coveredBySessionGrant(call)) return undefined
  const prompt = approvalPromptForCall(call, settings.sharePageContent, [])
  if (prompt === undefined) return undefined
  settleOp(call.id, 'waiting')
  const authorization = await authorizeToolCall(call, prompt, controller.signal, await approvalAnchorWindowId(), call.sessionId)
  if (authorization === 'approved') {
    settleOp(call.id, 'running')
    return undefined
  }
  // `renew` is not a refusal: the prompt expired, so tell the model to ask again.
  if (authorization === 'renew') {
    return gatedToolRenewalAnswer(prompt)
  }
  return approvalFailureAnswer(prompt, authorization)
}

/** Fetch one Drive export with the user's logged-in session (already approved by the caller). */
async function gdriveFetch(call: ToolCall, signal: AbortSignal): Promise<ToolAnswer> {
  const url = typeof call.args?.url === 'string' ? call.args.url : ''
  if (url.trim() === '') {
    return { ok: false, error: { code: 'bad-args', message: 'gdrive.fetch requires a url argument' } }
  }
  const target = parseGdriveExportUrl(url)
  if ('error' in target) {
    return { ok: false, error: { code: 'bad-args', message: target.error } }
  }
  const requestedFormat = typeof call.args?.format === 'string' ? call.args.format : undefined
  const ext = requestedFormat === 'html' ? 'html' : target.kind === 'docs' ? 'md' : 'xlsx'
  const downloadUrl = target.kind === 'docs'
    ? `https://docs.google.com/document/d/${target.id}/export?format=${ext}`
    : target.exportUrl
  try {
    // Spreadsheets are downloaded once, as the whole xlsx workbook; the host
    // asks which sheet to analyze and splits the matching CSV(s) itself.
    const { filePath } = await downloadGdriveFile(target, downloadUrl, ext, call.sessionId)
    if (signal.aborted) return { ok: false, error: { code: 'bridge-closed', message: 'Export was cancelled' } }
    return { ok: true, result: { text: JSON.stringify({ ok: true, kind: target.kind, ext, filePath }) } }
  } catch (error: unknown) {
    return { ok: false, error: { code: 'action-failed', message: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * Answer a virtual tool call. browser_list_tabs returns the open web tabs as
 * stable "ID=<n> | <title> | <url>" lines for the model to present through
 * ask_user_question; browser_bind_tab binds this session to the chosen tab
 * and broadcasts the affinity change so the assistant refreshes.
 */
async function handleVirtualTool(call: ToolCall, signal: AbortSignal): Promise<ToolAnswer> {
  if (call.name === 'browser_list_tabs') {
    const tabs = await chrome.tabs.query({})
    const lines: string[] = []
    for (const tab of tabs) {
      if (tab.id === undefined || !isBindableTabUrl(tab.url)) continue
      lines.push(formatBindableTab({ id: tab.id, title: tab.title ?? '', url: tab.url ?? '' }))
      if (lines.length >= MAX_BINDABLE_TABS) break
    }
    if (signal.aborted) return { ok: false, error: { code: 'bridge-closed', message: 'Tool call was cancelled' } }
    const text = lines.length === 0
      ? 'No bindable web tabs are open (open a page first).'
      : lines.join('\n')
    return { ok: true, result: { text } }
  }
  if (call.name === 'gdrive.fetch') {
    return gdriveFetch(call, signal)
  }
  if (call.name === 'browser_bind_tab') {
    const sessionId = call.sessionId
    if (sessionId === undefined || sessionId.trim() === '') {
      return { ok: false, error: { code: 'action-failed', message: 'No session is attached to this call' } }
    }
    // Binding is how a session takes the browser, so it is the one call that
    // has to lose when another session already owns the controlled tab. Failing
    // here — rather than rebinding — is what keeps it to one session at a time.
    const holder = tabAffinity.competingBinding(sessionId)
    if (holder !== undefined) return takenBindingAnswer(holder)
    const rawId = (call.args as { tabId?: unknown }).tabId
    if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId < 0) {
      return { ok: false, error: { code: 'bad-args', message: 'tabId must be a tab ID from browser_list_tabs' } }
    }
    const tab = await chrome.tabs.get(rawId)
    const summary = summarizeTab(tab)
    if (summary === null || !isBindableTabUrl(summary.url)) {
      return { ok: false, error: { code: 'no-active-tab', message: 'That tab is not a bindable web page' } }
    }
    const policyBlocked = blockedOriginFailure(summary.url)
    if (policyBlocked !== undefined) return policyBlocked
    await affinityReady
    if (signal.aborted) return { ok: false, error: { code: 'bridge-closed', message: 'Tool call was cancelled' } }
    // The session is being pointed at another tab: its grants named the old one.
    forgetSession(sessionId, 'rebind')
    resetTabSnapshot(summary.tabId)
    tabAffinity.bindNewSession(sessionId, summary)
    keepTabAlive(summary.tabId)
    persistTabAffinity()
    broadcastTabAffinity()
    return { ok: true, result: { text: `Bound session to tab ${summary.tabId}: ${summary.title}` } }
  }
  return { ok: false, error: { code: 'action-failed', message: `Unknown virtual tool ${call.name}` } }
}

/** Route one tool.call frame to the user-approved controlled tab. */
function routeToolCall(call: ToolCall): void {
  if (bridge === null) return
  activeToolCalls.get(call.id)?.abort()
  const controller = new AbortController()
  activeToolCalls.set(call.id, controller)
  const expiryTimer = call.expiresAt === undefined
    ? undefined
    : setTimeout(() => {
        console.warn('[dsh-browser] tool call expired before approval:', call.id, call.name)
        controller.abort()
      }, Math.max(0, call.expiresAt - Date.now()))
  const budget = caps === null
    ? undefined
    : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
  recordOpStart(call)
  if (VIRTUAL_TOOL_NAMES.has(call.name)) {
    void (async () => {
      let answer: ToolAnswer
      try {
        // Gated virtual actions (Drive export) take consent before their
        // download; trust short-circuits exactly as it does for page actions.
        answer = await virtualToolGate(call, controller) ?? await handleVirtualTool(call, controller.signal)
      } catch (error: unknown) {
        answer = { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }
      }
      if (controller.signal.aborted) {
        if (activeToolCalls.get(call.id) === controller) {
          settleOp(call.id, 'cancelled')
          bridge?.send({ t: 'tool.result', id: call.id, ok: false, error: { code: 'action-failed', message: 'Tool call was cancelled' } })
        }
        return
      }
      const socket = bridge
      if (socket === null) return
      if (answer.ok) {
        settleOp(call.id, 'done')
        socket.send({ t: 'tool.result', id: call.id, ok: true, result: answer.result })
      } else {
        settleOp(call.id, 'error')
        socket.send({ t: 'tool.result', id: call.id, ok: false, error: answer.error! })
      }
    })().finally(() => {
      if (expiryTimer !== undefined) clearTimeout(expiryTimer)
      if (activeToolCalls.get(call.id) === controller) activeToolCalls.delete(call.id)
    })
    return
  }
  void Promise.resolve()
    // Consent comes before any request leaves the browser: an unapproved
    // first navigate must not load its destination.
    .then(() => authorizeUnboundNavigate(call, async (prompt): Promise<ApprovalVerdict> => {
      settleOp(call.id, 'waiting')
      // A navigate is never renewable, so nothing here has to be asked twice.
      const authorization = await authorizeToolCall(call, prompt, controller.signal, await approvalAnchorWindowId(), call.sessionId)
      if (authorization === 'approved') {
        settleOp(call.id, 'running')
        return 'approved'
      }
      return authorization === 'renew' ? 'timed-out' : authorization
    }))
    .then((early) => early ?? debugToolRefusal(call.name, settings.allowExtensionDebug) ?? resolveToolTab(call.sessionId))
    .then((target) => 'ok' in target
    ? target
    : (operationGuard(call, target as { url?: string }) ?? dispatchToolCall(
        call,
        settings.sharePageContent,
        budget,
        (prompt) => authorizeCall(call, prompt, target.windowId, controller.signal),
        controller.signal,
        target,
        () => target.id !== undefined && tabAffinity.allowsTarget(target.id, call.sessionId),
      ))).then(
    (answer) => {
      if (controller.signal.aborted) {
        if (activeToolCalls.get(call.id) === controller) {
          settleOp(call.id, 'cancelled')
          bridge?.send({
            t: 'tool.result',
            id: call.id,
            ok: false,
            error: { code: 'action-failed', message: 'Tool call was cancelled' },
          })
        }
        return
      }
      const socket = bridge
      if (socket === null) return
      if (answer.ok) {
        if (typeof answer.result === 'object' && answer.result !== null) {
          const label = (answer.result as { label?: unknown }).label
          if (typeof label === 'string' && label.trim() !== '') labelOp(call.id, label)
        }
        settleOp(call.id, 'done')
        socket.send({ t: 'tool.result', id: call.id, ok: true, result: answer.result })
      } else {
        settleOp(call.id, 'error')
        socket.send({ t: 'tool.result', id: call.id, ok: false, error: answer.error! })
      }
    },
    (error: unknown) => {
      if (controller.signal.aborted) {
        if (activeToolCalls.get(call.id) === controller) {
          settleOp(call.id, 'cancelled')
          bridge?.send({
            t: 'tool.result',
            id: call.id,
            ok: false,
            error: { code: 'action-failed', message: 'Tool call was cancelled' },
          })
        }
        return
      }
      settleOp(call.id, 'error')
      bridge?.send({
        t: 'tool.result',
        id: call.id,
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
      })
    },
  ).finally(() => {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    if (activeToolCalls.get(call.id) === controller) activeToolCalls.delete(call.id)
  })
}

function cancelToolCall(id: string): void {
  console.warn('[dsh-browser] host cancelled tool call:', id)
  activeToolCalls.get(id)?.abort()
}

function cancelAllToolCalls(): void {
  for (const controller of activeToolCalls.values()) controller.abort()
  activeToolCalls.clear()
}

/** (Re)start the bridge with the current settings. 零配置：地址留空时自动探测；回环连接无需 token。 */
async function startBridge(): Promise<void> {
  let url = settings.bridgeUrl
  if (url.trim() === '') {
    const discovered = await discoverBridge()
    if (discovered === undefined) return
    url = discovered
  }
  // 手动填的地址常只有主机部分（如 ws://127.0.0.1:3080）；桥路径是协议
  // 常量，缺省时自动补全，避免连到根路径失败。
  try {
    const parsed = new URL(url)
    if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = BRIDGE_PATH
    url = parsed.toString()
    const origin = new URL(url)
    bridgeOrigin = `${origin.protocol === 'wss:' ? 'https:' : 'http:'}//${origin.host}`
    bridgeHostPort = normalizedHostPort(new URL(bridgeOrigin))
  } catch {
    // 非法 URL 原样交给 WebSocket 构造函数报错。
  }
  if (bridge === null) {
    // What the UI was last told. `onStateChange` fires on every emit, including
    // the ones a restart produces on its way back up; acting on each one logged
    // a reconnect storm and threw away in-flight work for no reason.
    let reportedState: BridgeState | 'initial' = 'initial'
    const client = new BridgeClient({
      onStateChange: (state) => {
        if (state !== reportedState) {
          if (state === 'connected') {
            console.info('[dsh-browser] bridge state', reportedState, '-> connected')
          } else if (state !== 'connecting') {
            // `connecting` is the ordinary first step of every attempt, including
            // a restart's; only a state the user would notice is worth a warning.
            console.warn(`[dsh-browser] bridge state ${state} -> cancelling in-flight tool calls`)
            cancelAllToolCalls()
            settlePendingBridgeRpcs(`Bridge RPC failed: the bridge is ${state}.`)
          }
          reportedState = state
        }
        broadcastStatus()
      },
      onFrame: (frame) => {
        if (frame.t === 'tool.call') routeToolCall(frame)
        else if (frame.t === 'tool.cancel') cancelToolCall(frame.id)
        else if (frame.t === 'rpc.result') settleBridgeRpc(frame.id, frame.ok, frame.ok ? frame.result : frame.error)
      },
      onHelloOk: (negotiated) => {
        caps = negotiated
        broadcastStatus()
        void pushBudgetToControlledTab(negotiated)
      },
      onNotice: (notice) => {
        handshakeNotice = notice
        broadcastStatus()
      },
    },
    probeBridge,
    // Read at handshake time, so flipping the setting reaches the host on the
    // reconnect the settings handler triggers.
    () => settings.allowExtensionDebug)
    bridge = client
  }
  bridge.start(url, settings.token)
}

// ---- UI messages (status side panel / options / action popup) ----

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return
  // Every request below is privileged: `settings.set` can repoint the bridge and
  // rewrite the token, and `approval.response` is the user's consent. Only this
  // extension's own pages may send them — a content script runs in a page's
  // origin and must never be able to answer an approval or widen a setting.
  if (!isExtensionPageSender(sender, `chrome-extension://${chrome.runtime.id}/`)) return
  const request = message as { type?: unknown }
  switch (request.type) {
    case 'ui.state':
      sendResponse(uiState())
      return
    case 'settings.get':
      sendResponse(settings)
      return
    case 'settings.set': {
      const patch = (message as { patch?: unknown }).patch
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return
      void settingsReady.then(async () => {
        const previousConnection = {
          bridgeUrl: settings.bridgeUrl,
          token: settings.token,
          allowExtensionDebug: settings.allowExtensionDebug,
        }
        const next = await persistSettings(patch as Partial<Settings>)
        const connectionChanged = settings.bridgeUrl !== previousConnection.bridgeUrl
          || settings.token !== previousConnection.token
          // The capability travels in `hello`, so a flip needs a fresh handshake.
          || settings.allowExtensionDebug !== previousConnection.allowExtensionDebug
        if (connectionChanged) restartBridge()
        // Turning debugging off must release the eager sessions it allowed.
        queueDevtoolsPriming()
        sendResponse(next)
      }, (error: unknown) => {
        // A save that cannot complete must still answer, or the settings page
        // waits on a port that will never close cleanly.
        console.warn('[dsh-browser] settings save failed', error)
        sendResponse(settings)
      })
      return true
    }
    case 'approval.response': {
      const approval = message as { id?: unknown; decision?: unknown }
      if (typeof approval.id === 'string' && isApprovalDecision(approval.decision)) {
        approvals.respond(approval.id, approval.decision)
      }
      sendResponse({ accepted: true })
      return
    }
    case 'ops.clear':
      recentOps = []
      refreshBadge()
      sendUiPush({ type: 'push.ops', ops: [] })
      sendUiPush({ type: 'push.ops-cleared' })
      sendResponse({ accepted: true })
      return
    case 'session.unbind': {
      const sessionId = tabAffinity.focusedSession()
      if (sessionId !== null && tabAffinity.unbindSession(sessionId)) {
        forgetSession(sessionId, 'unbound')
        persistTabAffinity()
        broadcastTabAffinity()
        sendResponse({ accepted: true })
      } else {
        sendResponse({ accepted: false })
      }
      return
    }
    case 'open-export-folder':
      void bridgeRpc(BRIDGE_OPEN_GDRIVE_FOLDER_METHOD, {}).then(
        () => sendResponse({ accepted: true }),
        () => sendResponse({ accepted: false }),
      )
      return true
    case 'reconnect': {
      // The answer depends on work that can fail; the UI must hear about that
      // failure instead of waiting for a port that will never answer.
      void settingsReady.then(() => startBridge()).then(
        () => sendResponse({ accepted: true }),
        (error: unknown) => {
          console.warn('[dsh-browser] reconnect failed', error)
          sendResponse({ accepted: false })
        },
      )
      return true
    }
    case 'open-options':
      void chrome.runtime.openOptionsPage().catch(() => {})
      sendResponse({ accepted: true })
      return
    default:
      return
  }
})

/** Drop a healthy socket authenticated with stale connection settings and reconnect. */
function restartBridge(): void {
  bridge?.stop()
  bridge = null
  caps = null
  cancelAllToolCalls()
  // A deliberate reconnect also invalidates anything waiting on the old socket.
  settlePendingBridgeRpcs('Bridge RPC failed: the connection was restarted.')
  broadcastStatus()
  void startBridge()
}

// ---- Notifications ----

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return
  const id = notificationId.slice(APPROVAL_NOTIFICATION_PREFIX.length)
  const windowId = approvals.windowId(id)
  if (windowId === undefined) return
  clearApprovalNotification(id)
  // Notification clicks are extension user gestures; both panel APIs require
  // the call to remain inside this handler.
  void openStatusSurface(windowId)
})

// ---- Tab affinity ----

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void affinityReady.then(() => {
    const activationRevision = focusedWindow.acceptActivation(windowId)
    if (activationRevision === null) return
    // Mark the switch before awaiting metadata so an already-running trusted
    // action cannot slip through the handoff boundary.
    observeActiveSummary({ tabId, windowId, title: '', url: '' })
    return chrome.tabs.get(tabId).then((tab) => {
      if (focusedWindow.isCurrent(activationRevision)) observeActiveTab(tab)
    }).catch(() => {})
  })
})

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  void affinityReady.then(() => {
    if (!tabAffinity.tracks(tabId)) return
    const summary = summarizeTab(tab)
    if (summary !== null && tabAffinity.observeTab(summary)) broadcastTabAffinity()
  })
})

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void affinityReady.then(() => {
    const affectedSessions = tabAffinity.sessionIdsForTab(removedTabId)
    if (!tabAffinity.replaceTab(removedTabId, addedTabId)) return
    for (const sid of affectedSessions) forgetSession(sid, 'replaced')
    resetTabSnapshot(removedTabId)
    resetTabSnapshot(addedTabId)
    persistTabAffinity()
    broadcastTabAffinity()
    return chrome.tabs.get(addedTabId).then((tab) => {
      const summary = summarizeTab(tab)
      if (summary !== null && tabAffinity.observeTab(summary)) broadcastTabAffinity()
    }).catch(() => {})
  })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  // Debugging sessions and their rules belong to the tab; drop both with it.
  primedTabs.delete(tabId)
  void detachDevtoolsSession(tabId)
  void clearTabRules(tabId).catch(() => undefined)
  void affinityReady.then(() => {
    const affectedSessions = tabAffinity.sessionIdsForTab(tabId)
    if (!tabAffinity.removeTab(tabId)) return
    for (const sid of affectedSessions) forgetSession(sid, 'closed')
    persistTabAffinity()
    broadcastTabAffinity()
  })
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  focusedWindow.markFocused(windowId)
  void affinityReady.then(() => syncActiveTab())
})

chrome.windows.onRemoved.addListener((windowId) => {
  if (floatingWindowId === windowId) floatingWindowId = undefined
})

// ---- Keepalive ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BRIDGE_KEEPALIVE_ALARM) return
  // `stopped` is intentionally terminal until an explicit popup reconnect or a
  // worker restart. In particular, code 4000 means another browser owns the
  // single bridge slot and the keepalive must not reclaim it.
  if (bridge === null) {
    void settingsReady.then(() => startBridge())
    return
  }
  // A client that exists but is not connected still needs the wake-up: the
  // previous condition only rebuilt a client that was `null`, which is exactly
  // the case that cannot happen after the first attempt — so this path was dead
  // and a stalled client could never be revived.
  if (bridge.state === 'reconnecting') bridge.retry()
})

// ---- Boot ----

interface FirefoxSidebarAction {
  open(): Promise<void> | void
}

/** The floating status window we last opened, re-focused when still alive. */
let floatingWindowId: number | undefined

/** Open the persistent status surface chosen in Settings (side panel or floating popup). */
function openStatusSurface(windowId?: number): void {
  if (settings.statusMode === 'panel') {
    if (import.meta.env.EXT_TARGET === 'firefox') {
      const sidebar = (chrome as unknown as { sidebarAction?: FirefoxSidebarAction }).sidebarAction
      if (sidebar === undefined) return
      void Promise.resolve(sidebar.open()).catch(() => {})
      return
    }
    // chrome.sidePanel.open must run synchronously inside the user gesture;
    // any await before it drops the gesture and the open is rejected. The
    // action click gives us the window id synchronously, so open right away.
    if (windowId !== undefined) {
      void chrome.sidePanel.open({ windowId }).catch(() => {})
      return
    }
    void Promise.resolve(chrome.windows.getLastFocused()).then((win) => {
      if (win.id !== undefined) {
        void chrome.sidePanel.open({ windowId: win.id }).catch(() => {})
      }
    }).catch(() => {})
    return
  }
  // Floating popup: refocus the window we opened if it still exists.
  void Promise.resolve(
    floatingWindowId === undefined
      ? Promise.resolve(false)
      : chrome.windows.get(floatingWindowId).then((win) => win !== undefined).catch(() => false),
  ).then((alive) => {
    if (alive && floatingWindowId !== undefined) {
      void chrome.windows.update(floatingWindowId, { focused: true }).catch(() => {})
      return
    }
    void chrome.windows.create({
      url: chrome.runtime.getURL('panel/index.html'),
      type: 'popup',
      width: 380,
      height: 560,
    }).then((win) => {
      if (win.id !== undefined) floatingWindowId = win.id
    }).catch(() => {})
  })
}

// The toolbar icon opens the whole assistant in the configured form
// (floating window by default, or the side panel). Approvals live inside
// the assistant, so there is no separate action popup.
chrome.action.onClicked.addListener((tab) => {
  void openStatusSurface(tab?.windowId)
})

// Pre-rewrite builds set openPanelOnActionClick so the icon opened the side
// panel; that behavior persists in Chrome and would swallow onClicked.
// Clear it explicitly so the icon click reaches the handler above.
if (import.meta.env.EXT_TARGET !== 'firefox') {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {})
}

armBridgeKeepalive()
refreshBadge()

// Eager connection: the pure-tool bridge claims its slot on load so a
// dsh session can drive this Chrome without any panel interaction.
void settingsReady.then(() => { startBridge() })
