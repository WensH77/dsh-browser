/**
 * Pages this session follows on its own.
 *
 * The user names origins they trust as a workflow hand-off: a capture tool
 * opens its form on one of them, and the session that was driving the page it
 * came from moves there instead of asking the user to bind again. Everything
 * else about binding is unchanged — the tab has to be *newly* opened after the
 * session already held the browser, bindable, not blocked, and not under some
 * session already; and the move is announced in the next tool answer, so the
 * model cannot mistake the new page for the one it was reading.
 *
 * Nothing here touches Chrome: the decision is a pure function so the rules can
 * be tested without a browser runtime.
 *
 * @module
 */

import { originMatchesTrusted } from '../security/trusted-origins.ts'
import type { AffinityTab } from './tab-affinity.ts'

/** The page a session moved to on its own. */
export interface FollowedPage {
  tabId: number
  url: string
  title: string
}

/**
 * Why a new page may or may not pull the session, before the follow list is
 * consulted: it has to be a real http(s) page, not the dsh UI, not a tab a
 * session already holds, and not on the blocked list.
 *
 * @returns the page's origin when the page is followable at all.
 */
function eligibleOrigin(input: {
  url: string | undefined
  tabId: number
  boundTabIds: ReadonlySet<number>
  blockedOrigins: readonly string[]
  isDshPage: (url: string) => boolean
}): string | undefined {
  const url = input.url
  if (url === undefined || url === '') return undefined
  if (!/^https?:/i.test(url)) return undefined
  if (input.isDshPage(url)) return undefined
  if (input.boundTabIds.has(input.tabId)) return undefined
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    return undefined
  }
  if (originMatchesTrusted(origin, input.blockedOrigins)) return undefined
  return origin
}

/**
 * The origin a newly opened tab is allowed to pull the session onto.
 *
 * Blocked origins win over follow origins: a page the user refused to operate
 * is never a follow target, even when both lists name it.
 *
 * @param input - the candidate tab, the pages already held, and both lists.
 * @returns the origin to follow, or undefined when this tab must not pull the
 *   session.
 */
export function followableOrigin(input: {
  url: string | undefined
  tabId: number
  /** Tabs some session already holds; following one of those would be a takeover. */
  boundTabIds: ReadonlySet<number>
  followOrigins: readonly string[]
  blockedOrigins: readonly string[]
  /** The dsh UI itself is never handed to a session. */
  isDshPage: (url: string) => boolean
}): string | undefined {
  const origin = eligibleOrigin(input)
  if (origin === undefined) return undefined
  return originMatchesTrusted(origin, input.followOrigins) ? origin : undefined
}

/**
 * The origin a new page should ask about, or undefined when no question is due.
 *
 * Asking is only for the shape the user has in mind: a page opened in a
 * **different window** while the session holds another tab — the capture tool's
 * hand-off. An ordinary new tab in the same window stays silent; only the
 * explicit follow list changes what a session operates without a question.
 *
 * @param input - the candidate tab and the tab the session holds.
 * @returns the origin to offer, or undefined when the page is not askable.
 */
export function askableFollowOrigin(input: {
  url: string | undefined
  tabId: number
  tabWindowId: number
  boundWindowId: number
  boundTabIds: ReadonlySet<number>
  followOrigins: readonly string[]
  blockedOrigins: readonly string[]
  isDshPage: (url: string) => boolean
}): string | undefined {
  const origin = eligibleOrigin(input)
  if (origin === undefined) return undefined
  if (input.tabWindowId === input.boundWindowId) return undefined
  return originMatchesTrusted(origin, input.followOrigins) ? undefined : origin
}

/**
 * What the model is told when the session moved without it asking.
 *
 * Named after the fact, not before: the move already happened, and the model's
 * next call runs on this page, so a text-only answer would otherwise read as a
 * page the model never left.
 *
 * @param page - the tab the session now holds.
 * @returns one model-facing line.
 */
export function followedNotice(page: FollowedPage): string {
  return `This session was moved to tab ${page.tabId} — ${page.url} — because that page opened on a follow origin. `
    + 'The previous page is no longer under this session\'s control: re-read this page before acting on it.'
}

/**
 * Notices waiting for the next tool answer, keyed by session.
 *
 * The move happens in a Chrome event, between calls; the model learns about it
 * at its next answer. One notice per session: a second move before the next
 * answer replaces the first, because the first page is already gone.
 */
const pendingBySession = new Map<string, string>()

/** Queue the one line the next answer from this session must lead with. */
export function announceFollow(sessionId: string, page: FollowedPage): void {
  pendingBySession.set(sessionId, followedNotice(page))
}

/** Take the queued line, if any; a notice is reported once. */
export function takeFollowNotice(sessionId: string | undefined): string | undefined {
  if (sessionId === undefined || sessionId === '') return undefined
  const notice = pendingBySession.get(sessionId)
  if (notice === undefined) return undefined
  pendingBySession.delete(sessionId)
  return notice
}

/**
 * Tabs opened while a session held the browser.
 *
 * A tab that already existed when the session bound is never followed: the
 * session was pointed at a page on purpose, and a whitelist entry cannot turn
 * some other open page into a takeover target. Only a tab created after the
 * binding — the copy the capture tool opens — is a candidate.
 */
export class FollowCandidates {
  private readonly byTab = new Map<number, string>()
  /** Tabs this session already asked about; one card per page. */
  private readonly asked = new Set<number>()

  /** Remember who was holding the browser when this tab appeared. */
  note(tabId: number, sessionId: string): void {
    this.byTab.set(tabId, sessionId)
  }

  /** The session this tab may pull, when it is still a candidate. */
  sessionFor(tabId: number): string | undefined {
    return this.byTab.get(tabId)
  }

  /** Remember that the user was already offered this tab, once. */
  markAsked(tabId: number): void {
    this.asked.add(tabId)
  }

  /** Whether this tab's card was already shown. */
  hasAsked(tabId: number): boolean {
    return this.asked.has(tabId)
  }

  /** Stop tracking one tab (closed, bound, or followed). */
  forget(tabId: number): void {
    this.byTab.delete(tabId)
    this.asked.delete(tabId)
  }

  /** Stop tracking one session's candidates (it released the browser). */
  forgetSession(sessionId: string): void {
    for (const [tabId, sid] of this.byTab) {
      if (sid === sessionId) this.byTab.delete(tabId)
    }
  }
}

/**
 * The page a session followed from, so a helper tab that closes itself gives
 * the session back.
 *
 * The follow list moves a session onto a page a workflow opens — in practice a
 * capture popup that scrapes for a few seconds and then closes itself. The move
 * is a rebinding, so the page the session came from stops being controlled; if
 * the popup then closes, that page is the one the user is still looking at, and
 * reporting "the controlled tab was closed" describes the popup, not their work.
 * Remembering the page that was handed over is what lets the close handler put
 * the session back instead of failing closed.
 *
 * Only the most recent hand-over is kept: a second follow replaces the first,
 * because the page before that one is two moves back and no longer what the
 * session was working on. Records are in memory only — a worker restart in the
 * seconds between following and the popup closing simply falls back to the
 * old behaviour.
 */
export class FollowReturn {
  private readonly records = new Map<string, { from: AffinityTab; followedTabId: number }>()

  /**
   * Remember the page a session is leaving for `followedTabId`.
   *
   * @param sessionId - the session being moved.
   * @param from - the page it held before the move.
   * @param followedTabId - the page it is moving to.
   */
  remember(sessionId: string, from: AffinityTab, followedTabId: number): void {
    if (sessionId.trim() === '' || from.tabId === followedTabId) return
    this.records.set(sessionId, { from: { ...from }, followedTabId })
  }

  /**
   * The page to go back to, when the closed tab is the one this session followed to.
   *
   * Taking the record is a one-shot: the return is a rebinding of its own, and a
   * later close must not be answered with another implicit move.
   *
   * @param sessionId - the session whose tab closed.
   * @param closedTabId - the tab Chrome removed.
   * @returns the page it followed from, or undefined when this close is not a follow's end.
   */
  take(sessionId: string, closedTabId: number): AffinityTab | undefined {
    const record = this.records.get(sessionId)
    if (record === undefined || record.followedTabId !== closedTabId) return undefined
    this.records.delete(sessionId)
    return { ...record.from }
  }

  /** Drop one session's record, for a binding that was chosen rather than followed. */
  forget(sessionId: string): void {
    this.records.delete(sessionId)
  }

  /**
   * Drop every record that named a tab which no longer exists.
   *
   * The remembered page can be closed while the session is on the followed one;
   * returning to it would bind a tab Chrome already removed.
   *
   * @param tabId - the tab Chrome removed.
   */
  forgetTab(tabId: number): void {
    for (const [sessionId, record] of this.records) {
      if (record.from.tabId === tabId || record.followedTabId === tabId) this.records.delete(sessionId)
    }
  }
}

/**
 * What the model is told when a followed page closed and the session went back.
 *
 * The model's next call already runs on the page it was on before the move, so
 * an answer without this line would read as if nothing had happened — and the
 * page may well have changed while the session was away.
 *
 * @param page - the page the session is back on.
 * @returns one model-facing line.
 */
export function followedBackNotice(page: FollowedPage): string {
  return `This session is back on tab ${page.tabId} — ${page.url} — because the page it had followed closed. `
    + 'Re-read this page before acting on it: it may have changed while the session was following the other one.'
}

/** Queue the one line the next answer from this session must lead with. */
export function announceFollowBack(sessionId: string, page: FollowedPage): void {
  pendingBySession.set(sessionId, followedBackNotice(page))
}
