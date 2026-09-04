import { useEffect, useState, type ReactElement } from 'react'
import { getUiLocale } from '../i18n.ts'
import { sendUiRequest, type UiState } from '../shared/messages.ts'
import type { ApprovalDecision, ApprovalRequest } from '../security/approval.ts'

const zh = {
  appName: 'dsh 浏览器助手',
  connecting: '连接中…',
  connected: '已连接',
  reconnecting: '重连中…',
  stopped: '未连接',
  idle: '当前没有正在操作的页面。让 dsh 打开一个网址(首次导航会自动新开标签页并绑定本会话)，或在会话中发送“绑定网页”指定某个标签页。',
  operating: '操作',
  session: '会话',
  settings: '设置',
  reconnect: '重连',
  pendingApprovals: '等待确认的浏览器操作',
  allowOnce: '允许一次',
  deny: '拒绝',
  alwaysAllowReads: '始终允许读取',
  trustOrigin: '信任此网站',
  read: '读取',
  action: '操作',
  operations: '最近操作',
  opRunning: '执行中',
  opWaiting: '等待中',
  opFailed: '失败',
  opCancelled: '已取消',
  opNavigate: '导航到',
  opClick: '点击',
  opType: '输入',
  opPress: '按键',
  opScroll: '滚动',
  opSnapshot: '读取页面',
  opGetText: '读取文本',
  opWait: '等待',
  opBack: '后退',
  opForward: '前进',
  opReload: '刷新',
  opListTabs: '列出标签页',
  opBindTab: '绑定标签页',
  opChars: '个字符',
  clear: '清除',
  unbind: '解除关联',
  bound: '当前页面',
}
const en = {
  appName: 'dsh Browser Assistant',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  stopped: 'Disconnected',
  idle: 'No page is being operated. Ask dsh to open a URL (the first navigation opens a new tab and binds this session to it), or send "bind to the page" in the session to choose a tab.',
  operating: 'Operation',
  session: 'Session',
  settings: 'Settings',
  reconnect: 'Reconnect',
  pendingApprovals: 'Browser actions awaiting approval',
  allowOnce: 'Allow once',
  deny: 'Deny',
  alwaysAllowReads: 'Always allow reads',
  trustOrigin: 'Trust this site',
  read: 'Read',
  action: 'Action',
  operations: 'Operations',
  opRunning: 'Running',
  opWaiting: 'Waiting',
  opFailed: 'Failed',
  opCancelled: 'Cancelled',
  opNavigate: 'Navigate to',
  opClick: 'Click',
  opType: 'Type',
  opPress: 'Press',
  opScroll: 'Scroll',
  opSnapshot: 'Read page',
  opGetText: 'Read text',
  opWait: 'Wait',
  opBack: 'Go back',
  opForward: 'Go forward',
  opReload: 'Reload',
  opListTabs: 'List tabs',
  opBindTab: 'Bind tab',
  opChars: ' chars',
  clear: 'Clear',
  unbind: 'Unbind',
  bound: 'Bound page',
}

const copy = getUiLocale() === 'zh' ? zh : en

function statusLabel(state: string): string {
  switch (state) {
    case 'connected': return copy.connected
    case 'connecting': return copy.connecting
    case 'reconnecting': return copy.reconnecting
    default: return copy.stopped
  }
}

function opLabel(op: import('../shared/messages.ts').RecentOp): string {
  const a = op.args
  const url = typeof a.url === 'string' ? a.url : ''
  const index = typeof a.index === 'number' ? a.index : undefined
  const text = typeof a.text === 'string' ? a.text : ''
  const ms = typeof a.ms === 'number' ? a.ms : undefined
  const direction = typeof a.direction === 'string' ? a.direction : ''
  const tabId = typeof a.tabId === 'number' ? a.tabId : undefined
  const key = typeof a.key === 'string' ? a.key : ''
  const trunc = (value: string, max = 96): string => value.length <= max ? value : `${value.slice(0, max - 1)}…`
  switch (op.name) {
    case 'browser_navigate': return `${copy.opNavigate} ${trunc(url)}`
    case 'browser_click': return `${copy.opClick} [${index ?? '?'}]`
    case 'browser_type': return `${copy.opType} ${text.length}${copy.opChars}`
    case 'browser_press': return `${copy.opPress} ${key}`
    case 'browser_scroll': return `${copy.opScroll} ${direction}`
    case 'browser_wait': return `${copy.opWait}${ms !== undefined ? ` ${ms}ms` : ''}`
    case 'browser_snapshot': return copy.opSnapshot
    case 'browser_get_text': return copy.opGetText
    case 'browser_back': return copy.opBack
    case 'browser_forward': return copy.opForward
    case 'browser_reload': return copy.opReload
    case 'browser_list_tabs': return copy.opListTabs
    case 'browser_bind_tab': return `${copy.opBindTab} ${tabId ?? ''}`.trim()
    default: return op.name
  }
}

function fmtClock(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function opTitle(op: import('../shared/messages.ts').RecentOp): string {
  const started = fmtClock(op.startedAt)
  return op.endedAt === undefined ? `started ${started}` : `started ${started} · ended ${fmtClock(op.endedAt)}`
}

function opStateLabel(state: string): string | undefined {
  switch (state) {
    case 'running': return copy.opRunning
    case 'waiting': return copy.opWaiting
    case 'error': return copy.opFailed
    case 'cancelled': return copy.opCancelled
    default: return undefined
  }
}

function decisionButtons(request: ApprovalRequest): Array<{ id: ApprovalDecision; label: string }> {
  const buttons: Array<{ id: ApprovalDecision; label: string }> = [
    { id: 'allow-once', label: copy.allowOnce },
    { id: 'deny', label: copy.deny },
  ]
  if (request.kind === 'read') buttons.splice(1, 0, { id: 'always-allow-reads', label: copy.alwaysAllowReads })
  if (request.kind === 'action' && request.canTrust && request.origins.length === 1) {
    buttons.push({ id: 'trust-origin', label: copy.trustOrigin })
  }
  return buttons
}

export function App(): ReactElement {
  const [ui, setUi] = useState<UiState | null>(null)

  useEffect(() => {
    let active = true
    const refresh = (): void => {
      void sendUiRequest({ type: 'ui.state' }).then((state) => {
        if (active && state !== undefined) setUi(state as UiState)
      }).catch(() => {})
    }
    refresh()
    const onMessage = (message: unknown): void => {
      if (typeof message !== 'object' || message === null) return
      const type = (message as { type?: string }).type
      if (type === 'push.approval' || type === 'push.approval-resolved') {
        refresh()
      } else if (type === 'push.ops-cleared') {
        setUi((prev) => prev === null ? prev : { ...prev, recentOps: [] })
      } else if (type === 'push.ops') {
        const push = message as { ops: import('../shared/messages.ts').RecentOp[] }
        setUi((prev) => prev === null ? prev : { ...prev, recentOps: push.ops })
      } else if (type === 'push.op') {
        const push = message as { op: import('../shared/messages.ts').RecentOp }
        setUi((prev) => prev === null
          ? prev
          : {
              ...prev,
              recentOps: [push.op, ...(prev.recentOps ?? []).filter((o) => o.id !== push.op.id)].slice(0, 30),
            })
      } else if (type === 'push.status') {
        const push = message as { state: UiState['bridgeState']; caps: UiState['caps'] }
        setUi((prev) => prev === null ? null : { ...prev, bridgeState: push.state, caps: push.caps })
      } else if (type === 'push.affinity') {
        // Affinity changes (bind/unbind/focus) also affect controlled and the
        // ops list; reload the full ui.state so the UI follows immediately.
        refresh()
      }
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => {
      active = false
      chrome.runtime.onMessage.removeListener(onMessage)
    }
  }, [])

  const state = ui?.bridgeState ?? 'stopped'
  const connected = state === 'connected'
  const controlled = ui?.controlled ?? null
  const operating = connected && controlled !== null
  const pending = ui?.pendingApprovals ?? []
  const ops = ui?.recentOps ?? []

  return (
    <div className="panel">
      <header className="panel__header">
        <span className={`dot ${connected ? 'dot--on' : 'dot--off'}`} />
        <span className="panel__state">{statusLabel(state)}</span>
        <span className="panel__header-fill" />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          title={copy.reconnect}
          onClick={() => { void sendUiRequest({ type: 'reconnect' }) }}
        >
          {copy.reconnect}
        </button>
      </header>

      <main className="panel__body">
        {pending.length > 0 && (
          <section className="approvals">
            <div className="approvals__label">{copy.pendingApprovals}</div>
            {pending.map((request) => (
              <article className="approvals__card" key={request.id}>
                <div className="approvals__head">
                  <strong>{request.kind === 'read' ? copy.read : copy.action}: {request.action}</strong>
                </div>
                <div className="approvals__body">
                  {request.summary}
                  {request.origins.length > 0 && <span className="approvals__origins">{request.origins.join(', ')}</span>}
                </div>
                <div className="approvals__actions">
                  {decisionButtons(request).map((button) => (
                    <button
                      type="button"
                      key={button.id}
                      className={button.id === 'allow-once' ? 'btn btn--sm btn--primary' : 'btn btn--sm btn--ghost'}
                      onClick={() => { void sendUiRequest({ type: 'approval.response', id: request.id, decision: button.id }) }}
                    >
                      {button.label}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </section>
        )}

        {ops.length > 0 && (
          <section className="ops">
            <div className="ops__label">{copy.operations}</div>
            <ol className="ops__list">
              {[...(ui?.recentOps ?? [])].slice(0, 15).reverse().map((op) => {
                const stateText = opStateLabel(op.state)
                return (
                  <li className="ops__row" key={op.id} title={opTitle(op)}>
                    <span className={`ops__dot ops__dot--${op.state}`} />
                    <span className="ops__content">
                      <span className="ops__text">{opLabel(op)}</span>
                      <span className="ops__meta">
                        <time>{fmtClock(op.startedAt)}</time>
                        {stateText !== undefined && <span className={`ops__state ops__state--${op.state}`}>{stateText}</span>}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ol>
          </section>
        )}

        {operating
          ? (
            <section className="operating">
              <div className="operating__label">{copy.operating}</div>
              <div className="operating__title" title={controlled.title || controlled.url}>
                {controlled.title || controlled.url}
              </div>
              <div className="operating__url" title={controlled.url}>{controlled.url}</div>
              <div className="operating__session">
                {copy.session}: <span className="operating__session-value">{controlled.sessionId}</span>
              </div>
            </section>
          )
          : (connected && ops.length === 0 ? <p className="panel__idle">{copy.idle}</p> : <span />)}
      </main>

      <footer className="panel__footer">
        <span className="panel__footer-actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={ops.length === 0}
            onClick={() => { void sendUiRequest({ type: 'ops.clear' }) }}
          >
            {copy.clear}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={controlled === null}
            onClick={() => { void sendUiRequest({ type: 'session.unbind' }) }}
          >
            {copy.unbind}
          </button>
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => { void sendUiRequest({ type: 'open-options' }) }}
        >
          {copy.settings}
        </button>
      </footer>
    </div>
  )
}
