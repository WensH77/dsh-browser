// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { noticeText } from '../src/shared/notice-copy.ts'
import type { BridgeNotice } from '../src/background/bridge.ts'

const kinds: BridgeNotice['kind'][] = ['host-older', 'host-newer', 'host-rejected', 'host-silent', 'extension-stale', 'bridge-replaced']

describe('noticeText', () => {
  it('names the mismatch and the next action in both locales', () => {
    for (const kind of kinds) {
      const notice: BridgeNotice = { kind, detail: 'plugin protocol 1' }
      const zh = noticeText(notice, 'zh')
      const en = noticeText(notice, 'en')
      expect(zh).toContain('plugin protocol 1')
      expect(en).toContain('plugin protocol 1')
      // Every notice names a concrete action. Three fixes exist in total:
      // restart the plugin, reload the extension, or take the bridge slot back.
      expect(zh, kind).toMatch(/重启 dsh|重载本扩展|重连/)
      expect(en, kind).toMatch(/restart dsh|reload this extension|Reconnect/)
    }
  })

  it('keeps each locale in its own language', () => {
    const han = /\p{Script=Han}/u
    for (const kind of kinds) {
      expect(noticeText({ kind }, 'zh')).toMatch(han)
      expect(noticeText({ kind }, 'en')).not.toMatch(han)
    }
  })

  it('omits the detail parenthesis when the host gave none', () => {
    expect(noticeText({ kind: 'host-silent' }, 'en')).not.toContain('()')
    expect(noticeText({ kind: 'host-silent', detail: '' }, 'zh')).not.toContain('（）')
  })

  it('tells the user how to reclaim a slot another connection took', () => {
    // The bridge has one slot and the keepalive deliberately will not fight for
    // it, so a bare "disconnected" leaves the user with no way back.
    const notice: BridgeNotice = { kind: 'bridge-replaced', detail: 'replaced' }

    expect(noticeText(notice, 'en')).toMatch(/Reconnect/)
    expect(noticeText(notice, 'en')).toContain('will not reclaim it')
    expect(noticeText(notice, 'zh')).toContain('重连')
    expect(noticeText(notice, 'zh')).toContain('不会自动争抢')
  })

  it('sends an unverified-identity refusal to the reload, not to a dsh restart', () => {
    // This exact confusion cost a live debugging session: an extension build
    // from before `caps.extensionId` cannot pass the host's identity check, and
    // the old copy told the user to restart dsh, which changes nothing.
    const notice: BridgeNotice = { kind: 'extension-stale', detail: 'extension did not identify itself' }

    expect(noticeText(notice, 'en')).toContain('reload this extension')
    expect(noticeText(notice, 'en')).toContain('does not fix this one')
    expect(noticeText(notice, 'zh')).toContain('重载本扩展')
    expect(noticeText(notice, 'zh')).toContain('不需要重启 dsh')
  })
})
