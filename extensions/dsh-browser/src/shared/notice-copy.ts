/**
 * One line of user-facing copy for a handshake notice. The two UI pages (side
 * panel and options) share it so a version mismatch reads the same wherever the
 * user happens to be looking, and both name the concrete next step.
 *
 * @module
 */

import type { UiLocale } from '../i18n.ts'
import type { BridgeNotice } from '../background/bridge.ts'

/**
 * Render a notice for the user.
 *
 * @param notice - the handshake problem reported by the bridge client.
 * @param locale - UI locale.
 * @returns a sentence naming the cause and the next action.
 */
export function noticeText(notice: BridgeNotice, locale: UiLocale): string {
  const detail = notice.detail === undefined || notice.detail === '' ? '' : `（${notice.detail}）`
  const enDetail = notice.detail === undefined || notice.detail === '' ? '' : ` (${notice.detail})`
  if (locale === 'zh') {
    switch (notice.kind) {
      case 'host-older':
        return `宿主比扩展旧${detail}：重启 dsh 后新工具与新描述才会生效。`
      case 'host-newer':
        return `宿主比扩展新${detail}：在 chrome://extensions 重载本扩展后，新工具与新描述才会生效。`
      case 'host-rejected':
        return `宿主拒绝了握手${detail}：按提示重启 dsh，然后重载本扩展。`
      case 'host-silent':
        return `宿主没有完成握手${detail}：如果 dsh 是旧构建，请重启 dsh；仍连不上就在 chrome://extensions 重载本扩展。`
    }
  }
  switch (notice.kind) {
    case 'host-older':
      return `The dsh plugin is older than this extension${enDetail}: restart dsh to load the new tools and descriptions.`
    case 'host-newer':
      return `The dsh plugin is newer than this extension${enDetail}: reload this extension from chrome://extensions to pick up the new tools and descriptions.`
    case 'host-rejected':
      return `The dsh plugin refused the handshake${enDetail}: restart dsh as it says, then reload this extension.`
    case 'host-silent':
      return `The dsh plugin never finished the handshake${enDetail}: restart dsh if it is an older build, and reload this extension from chrome://extensions if that does not help.`
  }
}
