import { useEffect, useState, type FormEvent, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { getUiLocale } from '../i18n.ts'
import { sendUiRequest } from '../shared/messages.ts'
import './styles.css'
import { SETTINGS_DEFAULTS, type Settings } from '../shared/settings.ts'

const zh = {
  title: 'dsh 浏览器助手设置',
  bridgeUrl: '桥地址(留空=自动探测)',
  bridgeUrlHint: '例如 ws://127.0.0.1:3080',
  token: 'Token(留空=本机回环免 token)',
  share: '页面内容共享',
  shareAuto: '自动(允许读取页面内容)',
  shareAsk: '每次询问',
  shareOff: '关闭',
  notifications: '无界面时用系统通知提醒审批',
  trusted: '信任的动作源(每行一个源,如 https://example.com;支持 https://*.example.com 整域通配)',
  save: '保存',
  saved: '已保存',
  status: '助手形态',
  statusPanel: '侧边栏',
  statusFloating: '浮动弹窗(自由小窗)',
  statusHint: '点击工具栏图标打开助手时的形态(浮动弹窗为默认)。',
  allowCross: '允许跨域名导航(默认关闭)',
  allowCrossHint: 'Agent 只能在同一台主机的页面间导航(初始打开与“绑定网页”是换站的两种正规方式);同域名但主机不同(如另一套环境)也算不同。',
  blockedOrigins: '禁止名单(每行一个源,如 https://compass.example.com)',
  blockedOriginsHint: '名单内的站点一律禁止操作(读取/动作/导航进入/绑定);支持 https://*.example.com 整域禁止。',
  openExport: '打开导出目录',
  openExportHint: '在文件管理器中打开 ~/.dsh/gdrive(存放按会话导出的 Google 文件),可自行清理。',
  note: '本插件是纯浏览器工具桥:聊天与会话管理请使用 dsh 官方界面。',
}
const en = {
  title: 'dsh Browser Assistant Settings',
  bridgeUrl: 'Bridge URL (empty = auto-discover)',
  bridgeUrlHint: 'e.g. ws://127.0.0.1:3080',
  token: 'Token (empty = loopback skips the token)',
  share: 'Page content sharing',
  shareAuto: 'Automatic (allow page reads)',
  shareAsk: 'Ask each time',
  shareOff: 'Off',
  notifications: 'Notify via OS notification when no UI is open',
  trusted: 'Trusted action origins (one per line, e.g. https://example.com; wildcards like https://*.example.com cover the domain and its subdomains)',
  save: 'Save',
  saved: 'Saved',
  status: 'Assistant form',
  statusPanel: 'Side panel',
  statusFloating: 'Floating window',
  statusHint: 'Which form opens when the toolbar icon is clicked (floating window by default).',
  allowCross: 'Allow cross-domain navigation (default off)',
  allowCrossHint: 'The agent may only navigate within the host of the currently bound page (initial navigation and “bind to the page” are the supported ways to switch hosts); a different host on the same domain (e.g. another environment) counts as different.',
  blockedOrigins: 'Blocked origins (one per line, e.g. https://compass.example.com)',
  blockedOriginsHint: 'Operations on these origins are always refused (reads, actions, navigation in, binding). Wildcard entries such as https://*.example.com block the whole domain.',
  openExport: 'Open export folder',
  openExportHint: 'Reveal ~/.dsh/gdrive in the file manager (session-named Google exports live here) so you can clean it up.',
  note: 'This extension is a pure browser-tool bridge: use the official dsh UI for chat and sessions.',
}

const copy = getUiLocale() === 'zh' ? zh : en

export function OptionsApp(): ReactElement {
  const [settings, setSettings] = useState<Settings>({ ...SETTINGS_DEFAULTS })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void sendUiRequest({ type: 'settings.get' }).then((value) => {
      if (typeof value === 'object' && value !== null) setSettings(value as Settings)
    }).catch(() => {})
  }, [])

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
      },
    }).then(() => { setSaved(true) }).catch(() => {})
  }

  return (
    <main className="options">
      <h1>{copy.title}</h1>
      <p className="options__note">{copy.note}</p>
      <form onSubmit={submit}>
        <label>
          <span>{copy.bridgeUrl}</span>
          <input
            type="text"
            placeholder={copy.bridgeUrlHint}
            value={settings.bridgeUrl}
            onChange={(e) => setSettings({ ...settings, bridgeUrl: e.target.value })}
          />
        </label>
        <label>
          <span>{copy.token}</span>
          <input
            type="password"
            value={settings.token}
            onChange={(e) => setSettings({ ...settings, token: e.target.value })}
          />
        </label>
        <label>
          <span>{copy.share}</span>
          <select
            value={settings.sharePageContent}
            onChange={(e) => setSettings({ ...settings, sharePageContent: e.target.value as Settings['sharePageContent'] })}
          >
            <option value="auto">{copy.shareAuto}</option>
            <option value="ask">{copy.shareAsk}</option>
            <option value="off">{copy.shareOff}</option>
          </select>
        </label>
        <label>
          <span>{copy.trusted}</span>
          <textarea
            rows={4}
            value={settings.trustedActionOrigins.join('\n')}
            onChange={(e) => setSettings({
              ...settings,
              trustedActionOrigins: e.target.value.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
            })}
          />
        </label>
        <label>
          <span>{copy.blockedOrigins}</span>
          <textarea
            rows={3}
            value={settings.blockedOrigins.join('\n')}
            onChange={(e) => setSettings({
              ...settings,
              blockedOrigins: e.target.value.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
            })}
          />
          <small>{copy.blockedOriginsHint}</small>
        </label>
        <label>
          <span>{copy.status}</span>
          <select
            value={settings.statusMode}
            onChange={(e) => setSettings({ ...settings, statusMode: e.target.value as Settings['statusMode'] })}
          >
            <option value="panel">{copy.statusPanel}</option>
            <option value="floating">{copy.statusFloating}</option>
          </select>
          <small>{copy.statusHint}</small>
        </label>
        <label className="options__check">
          <input
            type="checkbox"
            checked={settings.allowCrossDomainNavigation}
            onChange={(e) => setSettings({ ...settings, allowCrossDomainNavigation: e.target.checked })}
          />
          <span>{copy.allowCross}</span>
          <small>{copy.allowCrossHint}</small>
        </label>
        <label className="options__check">
          <input
            type="checkbox"
            checked={settings.approvalNotifications}
            onChange={(e) => setSettings({ ...settings, approvalNotifications: e.target.checked })}
          />
          <span>{copy.notifications}</span>
        </label>
        <div className="options__actions">
          <button type="submit">{copy.save}</button>
          {saved && <span className="options__saved">{copy.saved}</span>}
        </div>
        <div className="options__export">
          <button
            type="button"
            onClick={() => { void sendUiRequest({ type: 'open-export-folder' }) }}
          >
            {copy.openExport}
          </button>
          <small>{copy.openExportHint}</small>
        </div>
      </form>
    </main>
  )
}


const root = document.getElementById('root')
if (root === null) throw new Error('options root missing')
createRoot(root).render(<OptionsApp />)
