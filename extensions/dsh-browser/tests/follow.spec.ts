import { describe, expect, it } from 'vitest'
import {
  FollowCandidates,
  announceFollow,
  askableFollowOrigin,
  followableOrigin,
  followedNotice,
  takeFollowNotice,
} from '../src/background/follow.ts'

const ORIGIN = 'https://app.example.com'
const PAGE = `${ORIGIN}/records/new?recordId=1234`

const decide = (patch: Partial<Parameters<typeof followableOrigin>[0]> = {}) => followableOrigin({
  url: PAGE,
  tabId: 7,
  boundTabIds: new Set<number>(),
  followOrigins: [ORIGIN],
  blockedOrigins: [],
  isDshPage: () => false,
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
