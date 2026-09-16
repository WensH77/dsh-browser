// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { noticeText } from '../src/shared/notice-copy.ts'
import type { BridgeNotice } from '../src/background/bridge.ts'

const kinds: BridgeNotice['kind'][] = ['host-older', 'host-newer', 'host-rejected', 'host-silent']

describe('noticeText', () => {
  it('names the mismatch and the next action in both locales', () => {
    for (const kind of kinds) {
      const notice: BridgeNotice = { kind, detail: 'plugin protocol 1' }
      const zh = noticeText(notice, 'zh')
      const en = noticeText(notice, 'en')
      expect(zh).toContain('plugin protocol 1')
      expect(en).toContain('plugin protocol 1')
      // One of the two fixes always applies: restart the plugin or reload the extension.
      expect(zh).toMatch(/重启 dsh|重载本扩展/)
      expect(en).toMatch(/restart dsh|reload this extension/)
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
})
