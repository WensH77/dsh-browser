// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isExtensionPageSender } from '../src/shared/message-sender.ts'

const PREFIX = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'

describe('isExtensionPageSender', () => {
  it('admits this extension\'s own pages', () => {
    // The side panel, options page and action popup: extension origin, no tab.
    expect(isExtensionPageSender({ url: `${PREFIX}panel/index.html` }, PREFIX)).toBe(true)
    expect(isExtensionPageSender({ url: `${PREFIX}options/index.html` }, PREFIX)).toBe(true)
    // A synthetic or older caller that passes no sender at all.
    expect(isExtensionPageSender(undefined, PREFIX)).toBe(true)
  })

  it('admits an extension page that Chrome also tags with a tab', () => {
    // A side panel lives in a tab as far as Chrome's sender is concerned. Keying
    // on `tab` rejected the panel's own requests, and because the listener
    // returned without answering, the panel only saw "The message port closed
    // before a response was received".
    expect(isExtensionPageSender({ tab: { id: 7 }, url: `${PREFIX}panel/index.html` }, PREFIX)).toBe(true)
    expect(isExtensionPageSender({ tab: { id: 7 }, url: `${PREFIX}options/index.html` }, PREFIX)).toBe(true)
  })

  it('refuses a content script, whatever it claims', () => {
    // A content script always carries the tab it runs in, and its `url` is the
    // page's URL. Answering `approval.response` or `settings.set` from here
    // would let page-injected code hand away consent or the bridge token.
    expect(isExtensionPageSender({ tab: { id: 7 }, url: 'https://evil.example/' }, PREFIX)).toBe(false)
    expect(isExtensionPageSender({ tab: { id: 7 }, url: 'about:blank' }, PREFIX)).toBe(false)
    // No URL at all plus a tab: cannot be told apart from a content script.
    expect(isExtensionPageSender({ tab: { id: 7 } }, PREFIX)).toBe(false)
  })

  it('refuses a sender from another extension', () => {
    // Another installed extension shares the `chrome-extension:` scheme but not
    // the origin.
    expect(isExtensionPageSender({ url: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/panel/index.html' }, PREFIX))
      .toBe(false)
  })

  it('refuses a sender whose URL is a web page', () => {
    expect(isExtensionPageSender({ url: 'https://evil.example/' }, PREFIX)).toBe(false)
    expect(isExtensionPageSender({ url: 'about:blank' }, PREFIX)).toBe(false)
  })
})
