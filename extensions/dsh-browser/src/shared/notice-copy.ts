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
      case 'extension-stale':
        return `宿主没能确认本扩展的身份${detail}：这是扩展侧版本过旧（宿主已按固定 ID 校验，而旧构建不会上报自己的 ID）——在 chrome://extensions 重载本扩展即可，不需要重启 dsh。`
      case 'bridge-replaced':
        return `另一个连接占用了唯一的桥槽位，本扩展已主动停连${detail}：在侧栏点「重连」即可抢回；心跳按设计不会自动争抢。`
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
    case 'extension-stale':
      return `The dsh plugin could not confirm this extension's identity${enDetail}: this extension build is too old — the host verifies a pinned ID and a build from before that field never reports its own — so reload this extension from chrome://extensions. Restarting dsh does not fix this one.`
    case 'bridge-replaced':
      return `Another connection took the single bridge slot, so this extension stopped${enDetail}: click Reconnect in the side panel to take it back. The keepalive will not reclaim it on purpose.`
    case 'host-rejected':
      return `The dsh plugin refused the handshake${enDetail}: restart dsh as it says, then reload this extension.`
    case 'host-silent':
      return `The dsh plugin never finished the handshake${enDetail}: restart dsh if it is an older build, and reload this extension from chrome://extensions if that does not help.`
  }
}
