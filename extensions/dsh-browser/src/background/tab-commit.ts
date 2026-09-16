/**
 * Wait for a freshly created tab to commit its first document.
 *
 * `chrome.tabs.create({ url })` resolves as soon as the tab exists; at that
 * instant `tab.url` is still empty (the destination is only a pending URL) and
 * no content script can run there. Binding that snapshot made the very next
 * tool call — typically the `browser_wait` the model was just told to make —
 * fail with a bogus "this page does not support browser operations".
 *
 * @module
 */

/** How long a new tab may take to commit its first document. */
export const TAB_COMMIT_TIMEOUT_MS = 10_000

/** Poll cadence while waiting for the commit. */
const TAB_COMMIT_POLL_MS = 120

/** Whether a committed tab is a page the content script can run in. */
function hasCommittedDocument(tab: chrome.tabs.Tab): boolean {
  return typeof tab.url === 'string' && /^https?:\/\//i.test(tab.url)
}

/**
 * Wait until a tab reports an http(s) URL, then return that observation.
 *
 * A tab that is closed, or one that never commits within the budget, resolves
 * `undefined` so the caller can fall back to the create-time snapshot instead
 * of failing the navigation outright.
 *
 * @param tabId - the tab to watch.
 * @param timeoutMs - budget; defaults to {@link TAB_COMMIT_TIMEOUT_MS}.
 * @param pollMs - poll cadence; defaults to 120ms.
 * @returns the committed tab, or undefined.
 */
export async function waitForTabCommit(
  tabId: number,
  timeoutMs: number = TAB_COMMIT_TIMEOUT_MS,
  pollMs: number = TAB_COMMIT_POLL_MS,
): Promise<chrome.tabs.Tab | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let tab: chrome.tabs.Tab | undefined
    try {
      tab = await chrome.tabs.get(tabId)
    } catch {
      // The tab was closed before it committed.
      return undefined
    }
    if (hasCommittedDocument(tab)) return tab
    if (Date.now() >= deadline) return undefined
    await new Promise<void>((resolve) => { setTimeout(resolve, pollMs) })
  }
}
