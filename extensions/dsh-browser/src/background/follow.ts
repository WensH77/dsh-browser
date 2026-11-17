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
 * The environment label a URL belongs to: the first DNS label of its host.
 *
 * `ts1.intranet.test6.pro` → `ts1`, `d15a.intranet.test15.tbeng.pro` → `d15a`.
 * The environments this bridge is used against are siblings that share a
 * domain wildcard, so a wildcard follow entry alone cannot tell `ts1` from
 * `d15a` — the label is what names the environment the user is working in.
 *
 * @param address - a URL or an origin.
 * @returns the label, or undefined for an address that has none (IP literals, garbage).
 */
export function hostPrefix(address: string | undefined): string | undefined {
  if (address === undefined || address === '') return undefined
  try {
    const host = new URL(address).hostname.toLowerCase()
    if (host === '') return undefined
    // An IP literal names a machine, not an environment.
    if (/^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) return undefined
    return host.split('.')[0]
  } catch {
    return undefined
  }
}

/**
 * Whether two addresses name the same environment label.
 *
 * @param address - one URL or origin.
 * @param other - the other URL or origin.
 * @returns true only when both have a label and the labels are equal.
 */
export function sameHostPrefix(address: string | undefined, other: string | undefined): boolean {
  const prefix = hostPrefix(address)
  return prefix !== undefined && prefix === hostPrefix(other)
}

/**
 * The origin a newly opened tab is allowed to pull the session onto.
 *
 * Blocked origins win over follow origins: a page the user refused to operate
 * is never a follow target, even when both lists name it.
 *
 * The environment prefix is part of the match: the follow list is written in
 * origins, and a wildcard entry covers every environment under it, so a page on
 * `ts1` would otherwise pull a session working on `d15a` — two systems the user
 * keeps apart. Only a page whose first host label equals the held page's may
 * follow on its own; a cross-environment page is offered as a session grant
 * instead (see {@link askableCrossPrefixOrigin}), which is the one consent that
 * needs no widening of the list.
 *
 * @param input - the candidate tab, the page the session holds, the pages
 *   already held, and both lists.
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
  /** The page the session holds; the candidate must share its host prefix. */
  currentUrl: string | undefined
  /**
   * Origins this session may follow across environments, from an explicit
   * "Allow in this session" on a cross-prefix page. The grant is the consent,
   * so it needs no follow-list entry.
   */
  sessionOrigins?: ReadonlySet<string>
}): string | undefined {
  const origin = eligibleOrigin(input)
  if (origin === undefined) return undefined
  if (input.sessionOrigins?.has(origin) === true) return origin
  if (!originMatchesTrusted(origin, input.followOrigins)) return undefined
  return sameHostPrefix(origin, input.currentUrl) ? origin : undefined
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
 * The origin to ask about when a new window opens in another environment.
 *
 * A page on the follow list still cannot follow on its own when its environment
 * label differs from the held page's — the list is written in origins, and
 * "always follow this site" cannot say "but only from d15a". The card is where
 * the user says yes for this session, so the page is offered even though the
 * list already names it.
 *
 * Asking stays limited to the shape that is a hand-off: a page in a *different
 * window*. An ordinary new tab in the same window never asks.
 *
 * @param input - the candidate tab, the page the session holds, and the blocked list.
 * @returns the origin to ask about, or undefined when no card is due.
 */
export function askableCrossPrefixOrigin(input: {
  url: string | undefined
  tabId: number
  tabWindowId: number
  boundWindowId: number
  boundTabIds: ReadonlySet<number>
  blockedOrigins: readonly string[]
  isDshPage: (url: string) => boolean
  /** The page the session holds; the ask is about a different prefix. */
  currentUrl: string | undefined
}): string | undefined {
  const origin = eligibleOrigin(input)
  if (origin === undefined) return undefined
  if (input.tabWindowId === input.boundWindowId) return undefined
  return sameHostPrefix(origin, input.currentUrl) ? undefined : origin
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

/**
 * What the model is told when a lost binding was silently reconnected.
 *
 * The call did not fail: it ran on the page the session had, found again after
 * the binding was pruned. Saying so is the difference between "your page is
 * still there, read it again" and the model believing it is still on whatever
 * the old answer described.
 *
 * @param page - the page the session is back on.
 * @returns one model-facing line.
 */
export function reconnectedNotice(page: FollowedPage): string {
  return `This session is on tab ${page.tabId} — ${page.url} — again: the page it had was still open (possibly reopened in another tab), so it was rebound instead of reported closed. `
    + 'Re-read this page before acting on it: it may have changed, and its host may differ from the one in the old answers.'
}

/** Queue the reconnect line for the next answer from this session. */
export function announceReconnect(sessionId: string, page: FollowedPage): void {
  pendingBySession.set(sessionId, reconnectedNotice(page))
}

/**
 * What the model is told when the session was rebound on the page the workflow
 * returned to, rather than on the page that closed.
 *
 * The capture flow opens LinkedIn, then closes it and comes back to the intranet
 * page it started from. Re-executing the call on that page is what the user is
 * looking at; opening another tab for the same record would duplicate it.
 *
 * @param page - the page the session is back on.
 * @returns one model-facing line.
 */
export function returnedNotice(page: FollowedPage): string {
  return `This session is on tab ${page.tabId} — ${page.url} — the page the workflow returned to, so it was rebound there instead of in a new tab. `
    + 'Re-read this page before acting on it: it may have changed while the other page was open.'
}

/** Queue the return-to-page line for the next answer from this session. */
export function announceReturned(sessionId: string, page: FollowedPage): void {
  pendingBySession.set(sessionId, returnedNotice(page))
}
