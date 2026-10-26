/**
 * Remember why a tab's last top-frame navigation failed.
 *
 * Chrome replaces a failed page with its own error document but leaves
 * `tab.url` at the address that was requested. Every protocol check therefore
 * sees an ordinary https page, the content script cannot be injected into it,
 * and the only honest description of that state — "this page did not load:
 * `net::ERR_EMPTY_RESPONSE`" — is available solely from `webNavigation`.
 *
 * Kept in memory on purpose: it describes the document in front of the user
 * right now, and nothing downstream may persist it. `getFrame` covers the case
 * this map cannot — a page that failed before the worker started — at the price
 * of one IPC round trip and no error name.
 *
 * @module
 */

/** One failed top-frame load. */
export interface NavigationFailure {
  /** Chrome's own error string, e.g. `net::ERR_EMPTY_RESPONSE`. */
  error: string
  /** The address that failed to load. */
  url: string
}

const failures = new Map<number, NavigationFailure>()

/** Record a top-frame navigation failure. Sub-frame failures are not the page. */
export function recordNavigationFailure(tabId: number, frameId: number, url: string, error: string): void {
  if (frameId !== 0) return
  failures.set(tabId, { error, url })
}

/** A document committed in that tab, or the tab went away: the failure is stale. */
export function clearNavigationFailure(tabId: number): void {
  failures.delete(tabId)
}

/**
 * The recorded failure for this tab, without asking Chrome.
 *
 * Used where an answer is built synchronously (the tab list, a bind) and a
 * missing record must not turn into a second IPC round trip.
 */
export function recordedNavigationFailure(tabId: number): NavigationFailure | undefined {
  return failures.get(tabId)
}

/**
 * Why the tab's current document did not load, if it did not.
 *
 * The recorded error name is preferred. When nothing was recorded — a page that
 * failed before this worker started, or before the extension was installed —
 * Chrome is asked directly; it can say "this frame failed" but not which error.
 */
export async function pageLoadFailure(
  tabId: number,
  tabUrl: string | undefined,
): Promise<NavigationFailure | undefined> {
  const recorded = failures.get(tabId)
  if (recorded !== undefined) return recorded
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 })
    if (frame?.errorOccurred !== true) return undefined
    return { error: 'the page did not load', url: frame.url ?? tabUrl ?? '' }
  } catch {
    // No frame tree to read (a tab mid-navigation, or a Chrome build without
    // webNavigation): the caller keeps its generic "protected page" answer.
    return undefined
  }
}
