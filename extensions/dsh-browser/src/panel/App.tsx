import { useEffect, useState, type ReactElement } from 'react'
import { getUiLocale } from '../i18n.ts'
import { opLabel, type OpCopy } from './op-label.ts'
import { sendUiRequest, type SessionGrantsPush, type UiState } from '../shared/messages.ts'
import { noticeText } from '../shared/notice-copy.ts'
import { decisionButtons } from './approval-buttons.ts'
import { applySessionGrantsPush, grantsLine, revocationLine, type SessionGrantsView } from './session-grants.ts'

const zh = {
  appName: 'AI 浏览器助手',
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
  allowInSession: '本会话内允许',
  sessionGrants: '本会话已授予：',
  sessionGrantsNone: '无',
  grantSeparator: '、',
  revokedRebind: '受控标签页已更换，本会话授权已失效——再调用会重新询问',
  revokedClosed: '受控标签页已关闭，本会话授权已失效——再调用会重新询问',
  revokedReplaced: '受控标签页被替换，本会话授权已失效——再调用会重新询问',
  revokedUnbound: '本会话已解除关联，授权已失效——再调用会重新询问',
  revokedCountBefore: '（',
  revokedCountAfter: ' 项授权）',
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
  opEval: '执行 JS',
  opBlock: '阻断请求',
  opHeaders: '改写请求头',
  opCapture: '页面截图',
  opConsole: '查看控制台',
  opNetwork: '查看网络请求',
  opDialog: '回应页面弹窗',
  opElement: '元素',
  opPress: '按键',
  opScroll: '滚动',
  opSnapshot: '读取页面快照',
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
  appName: 'AI Browser Assistant',
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
  allowInSession: 'Allow in this session',
  sessionGrants: 'Session grants: ',
  sessionGrantsNone: 'none',
  grantSeparator: ', ',
  revokedRebind: 'The controlled tab changed, so this session\'s grants were dropped — the next call asks again',
  revokedClosed: 'The controlled tab closed, so this session\'s grants were dropped — the next call asks again',
  revokedReplaced: 'The controlled tab was replaced, so this session\'s grants were dropped — the next call asks again',
  revokedUnbound: 'The session was unbound, so its grants were dropped — the next call asks again',
  revokedCountBefore: ' (',
  // `(s)` follows the message `browser_network` already uses for "1 rule(s)": a count of
  // one is common here, and “(1 grants)” would read as a bug.
  revokedCountAfter: ' grant(s))',
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
  opEval: 'Run JS',
  opBlock: 'Block requests',
  opHeaders: 'Rewrite headers',
  opCapture: 'Screenshot page',
  opConsole: 'View console',
  opNetwork: 'View network requests',
  opDialog: 'Answer page dialog',
  opElement: 'element',
  opPress: 'Press',
  opScroll: 'Scroll',
  opSnapshot: 'Read page snapshot',
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

const locale = getUiLocale()
const copy = locale === 'zh' ? zh : en

function statusLabel(state: string): string {
  switch (state) {
    case 'connected': return copy.connected
    case 'connecting': return copy.connecting
    case 'reconnecting': return copy.reconnecting
    default: return copy.stopped
  }
}

function fmtClock(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function opTitle(op: import('../shared/messages.ts').RecentOp): string {
  const started = fmtClock(op.startedAt)
  const span = op.endedAt === undefined ? `started ${started}` : `started ${started} · ended ${fmtClock(op.endedAt)}`
  let args = ''
  try {
    args = JSON.stringify(op.args)
  } catch {
    args = '(unserializable arguments)'
  }
  return `${op.name}${op.label === undefined ? '' : ` · ${op.label}`}\n${span}\n${args}`
}

/**
 * The code an operation ran, when it ran code.
 *
 * `browser_eval` carries a whole expression. Crammed onto one line after its
 * label it was cut to the first few characters with no sign that anything was
 * missing — `执行 JS (() => { const f = document.forms.mainform; i…` — so the
 * feed could not be scanned and the code could not be read. It gets its own
 * line, wrapping, and the full text; the row's tooltip still carries every
 * argument as JSON.
 */
function opCode(op: import('../shared/messages.ts').RecentOp): string | undefined {
  if (op.name !== 'browser_eval') return undefined
  const expression = op.args?.expression
  return typeof expression === 'string' && expression.trim() !== '' ? expression.trim() : undefined
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
        const push = message as { state: UiState['bridgeState']; caps: UiState['caps']; notice: UiState['notice'] }
        setUi((prev) => prev === null ? null : { ...prev, bridgeState: push.state, caps: push.caps, notice: push.notice })
      } else if (type === 'push.affinity') {
        // Affinity changes (bind/unbind/focus) also affect controlled and the
        // ops list; reload the full ui.state so the UI follows immediately.
        refresh()
      } else if (type === 'push.session-grants') {
        const push = message as SessionGrantsPush
        setUi((prev) => {
          if (prev === null) return prev
          const view = applySessionGrantsPush(push, prev.controlled?.sessionId, {
            grants: prev.sessionGrants,
            grantRevocation: prev.grantRevocation,
          })
          return { ...prev, sessionGrants: view.grants, grantRevocation: view.grantRevocation }
        })
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
  const grantsView: SessionGrantsView = {
    grants: ui?.sessionGrants ?? [],
    grantRevocation: ui?.grantRevocation ?? null,
  }
  const showsGrants = grantsView.grants.length > 0 || grantsView.grantRevocation !== null

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

      {ui?.notice != null && (
        <p className="panel__notice" role="status">{noticeText(ui.notice, locale)}</p>
      )}

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
                  {decisionButtons(request, copy).map((button) => (
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

        {showsGrants && (
          <section className="grants">
            {/* Keys, not tool names: `browser_network#mock` and `browser_network`
                are separate grants, and listing both as `browser_network` would
                hide which of them a later call is still allowed to make. */}
            <p className="grants__line">{grantsLine(grantsView, copy)}</p>
            {grantsView.grantRevocation !== null && (
              <p className="grants__revoked" role="status">{revocationLine(grantsView.grantRevocation, copy)}</p>
            )}
          </section>
        )}

        {ops.length > 0 && (
          <section className="ops">
            <div className="ops__label">{copy.operations}</div>
            <ol className="ops__list">
              {/* Newest first, and no `reverse()`: the store already keeps the
                  newest operation at index 0. Reversing put the newest at the
                  BOTTOM of the list, so with a long feed the entry that just
                  happened landed below the fold and the only way to find it was
                  to scroll -- while the oldest entry sat at the top. */}
              {[...(ui?.recentOps ?? [])].slice(0, 15).map((op) => {
                const stateText = opStateLabel(op.state)
                const code = opCode(op)
                return (
                  <li className="ops__row" key={op.id} title={opTitle(op)}>
                    <time className="ops__time">{fmtClock(op.startedAt)}</time>
                    <span className={`ops__dot ops__dot--${op.state}`} />
                    <span className="ops__content">
                      <span className="ops__text">{opLabel(op, copy as OpCopy)}</span>
                      {code !== undefined && <code className="ops__code">{code}</code>}
                      <span className="ops__meta">
                        {/* The chip would just repeat a label that already fell back to the tool name. */}
                        {opLabel(op, copy as OpCopy) !== op.name && <span className="ops__tool">{op.name}</span>}
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
