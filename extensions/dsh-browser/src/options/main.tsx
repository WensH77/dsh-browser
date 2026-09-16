import { useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { getUiLocale } from '../i18n.ts'
import { sendUiRequest, type UiState } from '../shared/messages.ts'
import { noticeText } from '../shared/notice-copy.ts'
import './styles.css'
import { SETTINGS_DEFAULTS, type Settings } from '../shared/settings.ts'
import { policyRails } from './rails.ts'

const zh = {
  title: 'dsh 浏览器助手',
  lede: '这份面板决定模型可以碰你浏览器的哪些部分。',
  ledger: '当前策略',
  railReads: '读取页面',
  railActions: '页面动作',
  railJs: '执行 JS',
  railNav: '导航',
  readsOff: '禁止：内容不出页面',
  readsAsk: '每次读取都询问',
  readsAuto: '自动读取',
  actionsNone: '每次动作都询问',
  actionsTrusted: (n: number) => `信任 ${n} 个站点，免询问`,
  jsOff: '每次执行都询问',
  jsTrusted: '信任站点可直接执行',
  jsNoTrust: '信任列表为空，仍需每次询问',
  railScale: '轨道 = 免询问的范围；满格表示任何站点都不再询问（禁止名单除外）。',
  navSame: '仅同主机，仍需询问',
  navAny: '任意主机，信任站点免询问',
  secConnection: '连接',
  bridgeUrl: '桥地址',
  bridgeUrlHint: '留空自动探测本机 dsh',
  token: 'Token',
  tokenHint: '留空 = 本机回环免 token',
  secConsent: '同意',
  share: '页面内容共享',
  shareAuto: '自动读取',
  shareAsk: '每次询问',
  shareOff: '禁止读取',
  debugAllow: '允许 dsh 使用浏览器调试能力',
  debugAllowHint: '默认关闭：截图、控制台、网络、页面内执行 JS 都不注册，模型看不到也调不到这些工具。开启后走 Chrome 的 debugger 权限，被操作的标签页不能同时开着 DevTools。',
  jsDisabled: '调试能力已关闭',
  jsNeedsDebug: '需要先开启上面的调试能力。',
  jsTrust: '信任的站点也可直接执行 JS',
  jsTrustHint: '默认关闭：即使在信任的站点上，执行 JS 也每次询问。开启后，信任列表里的站点不再询问。',
  notifications: '没有面板时用系统通知提醒审批',
  secBoundaries: '边界',
  trusted: '信任的动作源',
  trustedHint: '这里的站点执行动作不再询问。',
  blocked: '禁止名单',
  blockedHint: '读取、动作、导航、绑定一律拒绝。',
  addOrigin: '添加站点…',
  addOriginInvalid: '看起来不是网址，例如 https://example.com 或 https://*.example.com',
  removeOrigin: '移除',
  bulkEdit: '批量编辑',
  bulkDone: '完成',
  emptyTrusted: '列表为空：每次动作都会询问。',
  emptyBlocked: '列表为空：没有站点被拒绝。',
  bulkHint: '每行一个；https://*.example.com 覆盖整域。',
  crossDomain: '允许跨域名导航',
  crossDomainHint: '默认关闭：只能在同一台主机的页面间导航，换站请用「绑定网页」或首次导航。',
  secAssistant: '助手形态',
  statusPanel: '侧边栏',
  statusFloating: '浮动弹窗',
  statusHint: '点击工具栏图标时打开哪种形态（默认浮动弹窗）。',
  secExports: 'Google 导出',
  openExport: '打开导出目录',
  openExportHint: '在文件管理器中打开 ~/.dsh/gdrive（按会话存放的导出文件），可自行清理。',
  save: '保存更改',
  saved: '已保存',
  note: '纯浏览器工具桥：聊天与会话管理用 dsh 官方界面。',
  bridgeConnected: '已连接',
  bridgeConnecting: '连接中',
  bridgeReconnecting: '重连中',
  bridgeStopped: '未连接',
  controlled: '受控页面',
}

const en = {
  title: 'dsh Browser Assistant',
  lede: 'This panel decides which parts of your browser the model may touch.',
  ledger: 'Current policy',
  railReads: 'Page reads',
  railActions: 'Page actions',
  railJs: 'JavaScript',
  railNav: 'Navigation',
  readsOff: 'blocked: content stays in the page',
  readsAsk: 'asks on every read',
  readsAuto: 'reads without asking',
  actionsNone: 'asks on every action',
  actionsTrusted: (n: number) => `trusted on ${n} origin${n === 1 ? '' : 's'}`,
  jsOff: 'asks on every call',
  jsTrusted: 'runs on trusted origins',
  jsNoTrust: 'no trusted origins yet, so it still asks',
  railScale: 'A rail measures how much runs without asking; full means “never asks, on any site”, blocked origins aside.',
  navSame: 'same host, prompts stay',
  navAny: 'any host; trusted skip',
  secConnection: 'Connection',
  bridgeUrl: 'Bridge address',
  bridgeUrlHint: 'Empty discovers the local dsh',
  token: 'Token',
  tokenHint: 'Empty = loopback needs no token',
  secConsent: 'Consent',
  share: 'Page content sharing',
  shareAuto: 'Read automatically',
  shareAsk: 'Ask each time',
  shareOff: 'Block reads',
  debugAllow: 'Allow browser debugging',
  debugAllowHint: 'Off by default: screenshots, console, network, and page evaluation are not registered at all, so the model never sees them. On, they use Chrome’s debugger permission and that tab cannot have DevTools open.',
  jsDisabled: 'debugging is off',
  jsNeedsDebug: 'Turn on browser debugging above first.',
  jsTrust: 'Trusted origins may also run JavaScript',
  jsTrustHint: 'Off by default: running JavaScript asks every time, even on a trusted origin. On, origins in the trust list stop asking.',
  notifications: 'Notify me when no panel is open',
  secBoundaries: 'Boundaries',
  trusted: 'Trusted action origins',
  trustedHint: 'Actions on these origins run without asking.',
  blocked: 'Blocked origins',
  blockedHint: 'Reads, actions, navigation and binding are refused here.',
  addOrigin: 'Add an origin…',
  addOriginInvalid: 'That does not look like a site, e.g. https://example.com or https://*.example.com',
  removeOrigin: 'Remove',
  bulkEdit: 'Edit as list',
  bulkDone: 'Done',
  emptyTrusted: 'Empty: every action asks first.',
  emptyBlocked: 'Empty: nothing is refused.',
  bulkHint: 'One per line; https://*.example.com covers the whole domain.',
  crossDomain: 'Allow cross-domain navigation',
  crossDomainHint: 'Off by default: navigation stays on the bound page’s host. Switch hosts with “bind to the page” or a first navigation.',
  secAssistant: 'Assistant form',
  statusPanel: 'Side panel',
  statusFloating: 'Floating window',
  statusHint: 'Which form opens when the toolbar icon is clicked (floating window by default).',
  secExports: 'Google exports',
  openExport: 'Open export folder',
  openExportHint: 'Reveal ~/.dsh/gdrive in the file manager (session-named exports) so you can clean it up.',
  save: 'Save changes',
  saved: 'Saved',
  note: 'A pure browser-tool bridge: chat and sessions live in the official dsh UI.',
  bridgeConnected: 'connected',
  bridgeConnecting: 'connecting',
  bridgeReconnecting: 'reconnecting',
  bridgeStopped: 'not connected',
  controlled: 'Controlled page',
}

const locale = getUiLocale()
const copy = locale === 'zh' ? zh : en

/** Read the four consent axes out of the settings the user is editing right now. */
/** Split an entry into its scheme and the part the user actually recognises. */
function splitOrigin(entry: string): { scheme: string; host: string } {
  const match = /^(https?:\/\/)(.*)$/i.exec(entry)
  return match === null ? { scheme: '', host: entry } : { scheme: match[1]!, host: match[2]! }
}

/** Loose check so a typo is named in the UI instead of failing at save time. */
function looksLikeOrigin(value: string): boolean {
  if (/\s/.test(value)) return false
  return /^(https?:\/\/)?(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(value)
}

/**
 * One consent boundary as a list of origins: the entries stay readable rows,
 * with a raw textarea behind “edit as list” for pasting a batch.
 */
function OriginLedger(props: {
  title: string
  hint: string
  tone: 'allow' | 'deny'
  entries: string[]
  empty: string
  onChange: (next: string[]) => void
}): ReactElement {
  const [draft, setDraft] = useState('')
  const [bulk, setBulk] = useState(false)
  const [invalid, setInvalid] = useState(false)

  const add = (): void => {
    const value = draft.trim()
    if (value === '') return
    if (!looksLikeOrigin(value)) {
      setInvalid(true)
      return
    }
    if (!props.entries.includes(value)) props.onChange([...props.entries, value])
    setDraft('')
    setInvalid(false)
  }

  return (
    <section className={`origins origins--${props.tone}`}>
      <header className="origins__head">
        <h3>{props.title}</h3>
        <span className="origins__count">{props.entries.length}</span>
      </header>

      {bulk ? (
        <textarea
          rows={5}
          spellCheck={false}
          aria-label={props.title}
          value={props.entries.join('\n')}
          onChange={(e) => { props.onChange(e.target.value.split('\n').map((line) => line.trim()).filter((line) => line !== '')) }}
        />
      ) : props.entries.length === 0 ? (
        <p className="origins__empty">{props.empty}</p>
      ) : (
        <ul className="origins__list">
          {props.entries.map((entry) => {
            const parts = splitOrigin(entry)
            return (
              <li className="origin" key={entry}>
                <span className="origin__text">
                  {parts.scheme !== '' && <span className="origin__scheme">{parts.scheme}</span>}
                  <span className="origin__host">{parts.host}</span>
                </span>
                <button
                  type="button"
                  className="origin__remove"
                  title={copy.removeOrigin}
                  aria-label={`${copy.removeOrigin}: ${entry}`}
                  onClick={() => { props.onChange(props.entries.filter((candidate) => candidate !== entry)) }}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {!bulk && (
        <div className="origins__add">
          <input
            type="text"
            spellCheck={false}
            placeholder={copy.addOrigin}
            aria-label={`${props.title}: ${copy.addOrigin}`}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setInvalid(false) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
          />
          <button type="button" className="button button--quiet button--small" onClick={add}>+</button>
        </div>
      )}

      {invalid && <p className="origins__error" role="alert">{copy.addOriginInvalid}</p>}
      <footer className="origins__foot">
        <span className="hint">{bulk ? copy.bulkHint : props.hint}</span>
        <button type="button" className="linkish" onClick={() => { setBulk(!bulk); setInvalid(false) }}>
          {bulk ? copy.bulkDone : copy.bulkEdit}
        </button>
      </footer>
    </section>
  )
}

/** A labelled section of the form. */
function Section(props: { eyebrow: string; title: string; hint?: string; children: ReactElement }): ReactElement {
  return (
    <section className="card">
      <header className="card__head">
        <span className="eyebrow">{props.eyebrow}</span>
        <h2>{props.title}</h2>
        {props.hint !== undefined && <p className="hint">{props.hint}</p>}
      </header>
      <div className="card__body">{props.children}</div>
    </section>
  )
}

export function OptionsApp(): ReactElement {
  const [settings, setSettings] = useState<Settings>({ ...SETTINGS_DEFAULTS })
  const [state, setState] = useState<UiState | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void sendUiRequest({ type: 'settings.get' }).then((value) => {
      if (typeof value === 'object' && value !== null) setSettings(value as Settings)
    }).catch(() => {})
    void sendUiRequest({ type: 'ui.state' }).then((value) => {
      if (typeof value === 'object' && value !== null) setState(value as UiState)
    }).catch(() => {})
  }, [])

  const bridge = state?.bridgeState ?? 'connecting'
  const bridgeLabel = bridge === 'connected'
    ? copy.bridgeConnected
    : bridge === 'reconnecting' ? copy.bridgeReconnecting : bridge === 'stopped' ? copy.bridgeStopped : copy.bridgeConnecting

  const rails = useMemo(() => policyRails(settings, copy), [settings])
  const patch = (next: Partial<Settings>): void => {
    setSettings({ ...settings, ...next })
    setSaved(false)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void sendUiRequest({
      type: 'settings.set',
      patch: {
        bridgeUrl: settings.bridgeUrl.trim(),
        token: settings.token,
        sharePageContent: settings.sharePageContent,
        trustedActionOrigins: settings.trustedActionOrigins,
        approvalNotifications: settings.approvalNotifications,
        statusMode: settings.statusMode,
        allowCrossDomainNavigation: settings.allowCrossDomainNavigation,
        blockedOrigins: settings.blockedOrigins,
        allowExtensionDebug: settings.allowExtensionDebug,
        trustJsExecution: settings.trustJsExecution,
      },
    }).then(() => { setSaved(true) }).catch(() => {})
  }

  return (
    <main className="page">
      <header className="masthead">
        <h1>{copy.title}</h1>
        <p className="lede">{copy.lede}</p>
        <p className={`bridge bridge--${bridge}`}>
          <span className="bridge__dot" aria-hidden="true" />
          {bridgeLabel}
          {state?.controlled != null && (
            <span className="bridge__page">{copy.controlled}: {state.controlled.title || state.controlled.url}</span>
          )}
        </p>
        {state?.notice != null && (
          <p className="bridge__notice" role="status">{noticeText(state.notice, locale)}</p>
        )}
      </header>

      <section className="ledger" aria-label={copy.ledger}>
        <span className="eyebrow">{copy.ledger}</span>
        <ul>
          {rails.map((rail) => (
            <li className="rail" key={rail.label}>
              <span className="rail__label">{rail.label}</span>
              <span className={`rail__track rail__track--${rail.tone}`} aria-hidden="true">
                <span className="rail__fill" style={{ width: `${rail.level * 100}%` }} />
              </span>
              <span className="rail__value">{rail.value}</span>
            </li>
          ))}
        </ul>
        <p className="ledger__scale">{copy.railScale}</p>
      </section>

      <form onSubmit={submit}>
        <Section eyebrow="01" title={copy.secConnection}>
          <>
            <label className="field">
              <span className="field__label">{copy.bridgeUrl}</span>
              <input
                type="text"
                spellCheck={false}
                placeholder={copy.bridgeUrlHint}
                value={settings.bridgeUrl}
                onChange={(e) => { patch({ bridgeUrl: e.target.value }) }}
              />
            </label>
            <label className="field">
              <span className="field__label">{copy.token}</span>
              <input
                type="password"
                value={settings.token}
                onChange={(e) => { patch({ token: e.target.value }) }}
              />
              <small className="hint">{copy.tokenHint}</small>
            </label>
          </>
        </Section>

        <Section eyebrow="02" title={copy.secConsent}>
          <>
            <label className="field">
              <span className="field__label">{copy.share}</span>
              <select
                value={settings.sharePageContent}
                onChange={(e) => { patch({ sharePageContent: e.target.value as Settings['sharePageContent'] }) }}
              >
                <option value="auto">{copy.shareAuto}</option>
                <option value="ask">{copy.shareAsk}</option>
                <option value="off">{copy.shareOff}</option>
              </select>
            </label>
            <label className="field field--check">
              <input
                type="checkbox"
                checked={settings.allowExtensionDebug}
                onChange={(e) => { patch({ allowExtensionDebug: e.target.checked }) }}
              />
              <span>
                <span className="field__label">{copy.debugAllow}</span>
                <small className="hint">{copy.debugAllowHint}</small>
              </span>
            </label>
            <label className={`field field--check${settings.allowExtensionDebug ? '' : ' field--muted'}`}>
              <input
                type="checkbox"
                disabled={!settings.allowExtensionDebug}
                checked={settings.trustJsExecution}
                onChange={(e) => { patch({ trustJsExecution: e.target.checked }) }}
              />
              <span>
                <span className="field__label">{copy.jsTrust}</span>
                <small className="hint">{settings.allowExtensionDebug ? copy.jsTrustHint : copy.jsNeedsDebug}</small>
              </span>
            </label>
            <label className="field field--check">
              <input
                type="checkbox"
                checked={settings.approvalNotifications}
                onChange={(e) => { patch({ approvalNotifications: e.target.checked }) }}
              />
              <span className="field__label">{copy.notifications}</span>
            </label>
          </>
        </Section>

        <Section eyebrow="03" title={copy.secBoundaries}>
          <>
            <div className="pair">
              <OriginLedger
                title={copy.trusted}
                hint={copy.trustedHint}
                tone="allow"
                empty={copy.emptyTrusted}
                entries={settings.trustedActionOrigins}
                onChange={(next) => { patch({ trustedActionOrigins: next }) }}
              />
              <OriginLedger
                title={copy.blocked}
                hint={copy.blockedHint}
                tone="deny"
                empty={copy.emptyBlocked}
                entries={settings.blockedOrigins}
                onChange={(next) => { patch({ blockedOrigins: next }) }}
              />
            </div>
            <label className="field field--check">
              <input
                type="checkbox"
                checked={settings.allowCrossDomainNavigation}
                onChange={(e) => { patch({ allowCrossDomainNavigation: e.target.checked }) }}
              />
              <span>
                <span className="field__label">{copy.crossDomain}</span>
                <small className="hint">{copy.crossDomainHint}</small>
              </span>
            </label>
          </>
        </Section>

        <Section eyebrow="04" title={copy.secAssistant}>
          <label className="field">
            <select
              value={settings.statusMode}
              onChange={(e) => { patch({ statusMode: e.target.value as Settings['statusMode'] }) }}
            >
              <option value="floating">{copy.statusFloating}</option>
              <option value="panel">{copy.statusPanel}</option>
            </select>
            <small className="hint">{copy.statusHint}</small>
          </label>
        </Section>

        <Section eyebrow="05" title={copy.secExports} hint={copy.openExportHint}>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => { void sendUiRequest({ type: 'open-export-folder' }) }}
          >
            {copy.openExport}
          </button>
        </Section>

        <footer className="actions">
          <p className="note">{copy.note}</p>
          <div className="actions__buttons">
            {saved && <span className="saved" role="status">{copy.saved}</span>}
            <button type="submit" className="button button--primary">{copy.save}</button>
          </div>
        </footer>
      </form>
    </main>
  )
}

const root = document.getElementById('root')
if (root === null) throw new Error('options root missing')
createRoot(root).render(<OptionsApp />)
