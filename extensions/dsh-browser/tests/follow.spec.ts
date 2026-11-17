import { describe, expect, it } from 'vitest'
import {
  FollowCandidates,
  FollowReturn,
  announceFollow,
  announceFollowBack,
  askableCrossPrefixOrigin,
  askableFollowOrigin,
  followableOrigin,
  followedBackNotice,
  followedNotice,
  hostPrefix,
  sameHostPrefix,
  takeFollowNotice,
} from '../src/background/follow.ts'

const ORIGIN = 'https://app.example.com'
const PAGE = `${ORIGIN}/records/new?recordId=1234`

const HELD = 'https://app.example.net/directory/1'

const decide = (patch: Partial<Parameters<typeof followableOrigin>[0]> = {}) => followableOrigin({
  url: PAGE,
  tabId: 7,
  boundTabIds: new Set<number>(),
  followOrigins: [ORIGIN],
  blockedOrigins: [],
  isDshPage: () => false,
  currentUrl: HELD,
  ...patch,
})

describe('followableOrigin', () => {
  it('follows a new page whose origin is on the list', () => {
    expect(decide()).toBe(ORIGIN)
  })

  it('accepts a wildcard entry and a different path on the same host', () => {
    expect(decide({ followOrigins: ['https://*.example.com'] })).toBe(ORIGIN)
  })

  it('does not follow a page that no entry covers, or another scheme/port', () => {
    expect(decide({ followOrigins: [] })).toBeUndefined()
    expect(decide({ followOrigins: ['http://app.example.com'] })).toBeUndefined()
    expect(decide({ followOrigins: ['https://app.example.com:8443'] })).toBeUndefined()
    expect(decide({ followOrigins: ['https://example.com'] })).toBeUndefined()
  })

  it('never follows a page another session already holds', () => {
    expect(decide({ boundTabIds: new Set([7]) })).toBeUndefined()
  })

  it('lets a blocked origin win over the follow list', () => {
    expect(decide({ blockedOrigins: [ORIGIN] })).toBeUndefined()
    expect(decide({ blockedOrigins: ['https://*.example.com'] })).toBeUndefined()
  })

  it('never follows the dsh UI, a non-http page, or a URL that is not there yet', () => {
    expect(decide({ isDshPage: () => true })).toBeUndefined()
    expect(decide({ url: 'chrome://extensions' })).toBeUndefined()
    expect(decide({ url: 'file:///tmp/page.html' })).toBeUndefined()
    expect(decide({ url: 'about:blank' })).toBeUndefined()
    expect(decide({ url: '' })).toBeUndefined()
    expect(decide({ url: undefined })).toBeUndefined()
  })
})

const ask = (patch: Partial<Parameters<typeof askableFollowOrigin>[0]> = {}) => askableFollowOrigin({
  url: PAGE,
  tabId: 7,
  tabWindowId: 2,
  boundWindowId: 1,
  boundTabIds: new Set<number>(),
  followOrigins: [],
  blockedOrigins: [],
  isDshPage: () => false,
  ...patch,
})

describe('askableFollowOrigin', () => {
  it('asks about a page that opened in another window while the session is bound', () => {
    expect(ask()).toBe(ORIGIN)
  })

  it('stays silent for an ordinary new tab in the same window', () => {
    expect(ask({ tabWindowId: 1 })).toBeUndefined()
  })

  it('does not ask about an origin that is already on the follow list', () => {
    expect(ask({ followOrigins: [ORIGIN] })).toBeUndefined()
  })

  it('keeps the same refusals as following', () => {
    expect(ask({ boundTabIds: new Set([7]) })).toBeUndefined()
    expect(ask({ blockedOrigins: [ORIGIN] })).toBeUndefined()
    expect(ask({ isDshPage: () => true })).toBeUndefined()
    expect(ask({ url: 'chrome://extensions' })).toBeUndefined()
    expect(ask({ url: undefined })).toBeUndefined()
  })
})

describe('FollowCandidates', () => {
  it('remembers who held the browser, and forgets a tab or a session on request', () => {
    const candidates = new FollowCandidates()
    candidates.note(1, 'session-a')
    candidates.note(2, 'session-a')
    candidates.note(3, 'session-b')

    expect(candidates.sessionFor(1)).toBe('session-a')
    candidates.forget(1)
    expect(candidates.sessionFor(1)).toBeUndefined()

    candidates.forgetSession('session-a')
    expect(candidates.sessionFor(2)).toBeUndefined()
    expect(candidates.sessionFor(3)).toBe('session-b')
  })

  it('remembers which tabs were already asked about, once', () => {
    const candidates = new FollowCandidates()
    candidates.note(1, 'session-a')
    candidates.markAsked(1)

    expect(candidates.hasAsked(1)).toBe(true)
    expect(candidates.hasAsked(2)).toBe(false)

    candidates.forget(1)
    expect(candidates.hasAsked(1)).toBe(false)
  })
})

describe('follow notice', () => {
  it('names the tab and the page, and says the previous page is gone', () => {
    const notice = followedNotice({ tabId: 42, url: PAGE, title: 'Add specialist' })

    expect(notice).toContain('tab 42')
    expect(notice).toContain(PAGE)
    expect(notice).toContain('no longer under this session')
  })

  it('is handed to exactly one answer per session', () => {
    announceFollow('session-a', { tabId: 42, url: PAGE, title: '' })

    expect(takeFollowNotice('session-a')).toContain('tab 42')
    expect(takeFollowNotice('session-a')).toBeUndefined()
    expect(takeFollowNotice('session-b')).toBeUndefined()
    expect(takeFollowNotice(undefined)).toBeUndefined()
    expect(takeFollowNotice('')).toBeUndefined()
  })
})

describe('host prefixes', () => {
  it('reads the environment label from the host', () => {
    expect(hostPrefix('https://ts1.intranet.test6.pro/Experts_display.php')).toBe('ts1')
    expect(hostPrefix('https://d15a.intranet.test15.tbeng.pro/x')).toBe('d15a')
    expect(hostPrefix('https://www.example.com')).toBe('www')
    expect(hostPrefix('http://127.0.0.1:3080/')).toBeUndefined()
    expect(hostPrefix('')).toBeUndefined()
    expect(hostPrefix(undefined)).toBeUndefined()
  })

  it('compares only defined labels', () => {
    expect(sameHostPrefix('https://ts1.intranet.test6.pro/x', 'https://ts1.intranet.test6.pro/y')).toBe(true)
    expect(sameHostPrefix('https://ts1.intranet.test6.pro/x', 'https://d15a.intranet.test15.tbeng.pro/y')).toBe(false)
    expect(sameHostPrefix('http://127.0.0.1:3080/', 'http://127.0.0.1:3080/')).toBe(false)
  })

  it('does not follow another environment even when a wildcard entry covers it', () => {
    const origin = 'https://ts1.intranet.test6.pro'
    expect(decide({
      url: `${origin}/Experts_display.php`,
      followOrigins: ['https://*.test6.pro'],
      currentUrl: 'https://d15a.intranet.test15.tbeng.pro/Experts_display.php',
    })).toBeUndefined()
  })

  it('follows another environment once the session holds its origin as a grant', () => {
    const origin = 'https://ts1.intranet.test6.pro'
    expect(decide({
      url: `${origin}/Experts_display.php`,
      followOrigins: ['https://*.test6.pro'],
      currentUrl: 'https://d15a.intranet.test15.tbeng.pro/Experts_display.php',
      sessionOrigins: new Set([origin]),
    })).toBe(origin)
  })

  it('does not follow when the held page has no environment label to compare', () => {
    expect(decide({ currentUrl: 'http://127.0.0.1:3080/' })).toBeUndefined()
  })
})

const askCross = (patch: Partial<Parameters<typeof askableCrossPrefixOrigin>[0]> = {}) => askableCrossPrefixOrigin({
  url: 'https://www.linkedin.com/sales/people/1',
  tabId: 7,
  tabWindowId: 2,
  boundWindowId: 1,
  boundTabIds: new Set<number>(),
  blockedOrigins: [],
  isDshPage: () => false,
  currentUrl: 'https://d15a.intranet.test15.tbeng.pro/Experts_display.php',
  ...patch,
})

describe('askableCrossPrefixOrigin', () => {
  it('asks about a different environment in another window, listed or not', () => {
    expect(askCross()).toBe('https://www.linkedin.com')
  })

  it('stays silent for the same environment', () => {
    expect(askCross({ url: 'https://d15a.intranet.test15.tbeng.pro/x' })).toBeUndefined()
  })

  it('stays silent for an ordinary new tab in the same window', () => {
    expect(askCross({ tabWindowId: 1 })).toBeUndefined()
  })

  it('never asks about a page another session holds, or an unbindable one', () => {
    expect(askCross({ boundTabIds: new Set([7]) })).toBeUndefined()
    expect(askCross({ url: 'chrome://extensions' })).toBeUndefined()
    expect(askCross({ url: 'https://www.linkedin.com/x', blockedOrigins: ['https://*.linkedin.com'] })).toBeUndefined()
  })
})

const ORIGINAL = { tabId: 42, windowId: 1, title: 'Profile', url: 'https://www.example.net/directory/1' }
const FOLLOWED = { tabId: 55, windowId: 2, title: 'Capture', url: 'https://app.example.com/records/new' }

describe('FollowReturn', () => {
  it('gives back the page a session followed from, once', () => {
    const returns = new FollowReturn()
    returns.remember('s1', ORIGINAL, FOLLOWED.tabId)
    expect(returns.take('s1', FOLLOWED.tabId)).toEqual(ORIGINAL)
    // One return per hand-over: a later close is not another implicit move.
    expect(returns.take('s1', FOLLOWED.tabId)).toBeUndefined()
  })

  it('does not answer for a tab this session did not follow to, or another session', () => {
    const returns = new FollowReturn()
    returns.remember('s1', ORIGINAL, FOLLOWED.tabId)
    expect(returns.take('s1', 99)).toBeUndefined()
    expect(returns.take('s2', FOLLOWED.tabId)).toBeUndefined()
    expect(returns.take('s1', FOLLOWED.tabId)).toEqual(ORIGINAL)
  })

  it('forgets hand-overs when either page is removed or the session rebinds', () => {
    const returns = new FollowReturn()
    returns.remember('s1', ORIGINAL, FOLLOWED.tabId)
    returns.forgetTab(ORIGINAL.tabId)
    expect(returns.take('s1', FOLLOWED.tabId)).toBeUndefined()

    returns.remember('s1', ORIGINAL, FOLLOWED.tabId)
    returns.forgetTab(FOLLOWED.tabId)
    expect(returns.take('s1', FOLLOWED.tabId)).toBeUndefined()

    returns.remember('s1', ORIGINAL, FOLLOWED.tabId)
    returns.forget('s1')
    expect(returns.take('s1', FOLLOWED.tabId)).toBeUndefined()
  })

  it('replaces the remembered page on a second move and names both in the notices', () => {
    const returns = new FollowReturn()
    returns.remember('s1', ORIGINAL, FOLLOWED.tabId)
    const third = { tabId: 66, windowId: 2, title: 'Capture 2', url: 'https://app.example.com/records/2' }
    returns.remember('s1', FOLLOWED, third.tabId)
    expect(returns.take('s1', FOLLOWED.tabId)).toBeUndefined()
    expect(returns.take('s1', third.tabId)).toEqual(FOLLOWED)

    expect(followedBackNotice(ORIGINAL)).toContain('back on tab 42')
    expect(followedBackNotice(ORIGINAL)).toContain(ORIGINAL.url)
  })

  it('delivers the return line through the same one-shot queue', () => {
    announceFollowBack('s9', ORIGINAL)
    expect(takeFollowNotice('s9')).toContain('back on tab 42')
    expect(takeFollowNotice('s9')).toBeUndefined()
  })
})
