/**
 * Who may drive the background worker.
 *
 * The worker listens on one `chrome.runtime.onMessage` channel that carries two
 * very different conversations: the extension's own pages (side panel, options,
 * action popup) ask for state, change settings, and answer approvals — while
 * content scripts only ever *receive* (`chrome.tabs.sendMessage`) and announce
 * themselves. Those requests are not equally trusted: `settings.set` accepts a
 * patch that includes `bridgeUrl` and `token`, and `approval.response` decides a
 * prompt the user was asked to answer in person. Answering either of them from
 * page-injected code would hand away the bridge or the consent gate itself.
 *
 * The channel is not open to web pages today (no `externally_connectable`, and
 * no content script relays page messages), so this is a boundary rather than a
 * fix for a live exploit. It is asserted explicitly because the surface is a
 * list of privileged switches, and because the one relaying bug that would open
 * it is a change someone might make without realizing what rides on the channel.
 *
 * @module
 */

/** The part of a message sender this check reads. */
export interface MessageSenderLike {
  /** Set for content scripts and extension pages rendered inside a tab. */
  tab?: { id?: number }
  /** Sender document URL; page URL for a content script. */
  url?: string
}

/**
 * Whether a message may drive privileged background handlers.
 *
 * The identity is the sender's URL: an extension page carries this extension's
 * origin, a content script carries the page's. That is a property of where the
 * code runs, and it is the one thing here we can rely on.
 *
 * `sender.tab` is deliberately NOT treated as "is a content script". Chrome
 * fills it for documents that live in a tab, and that includes some extension
 * pages — a side panel among them. Keying on it rejected the side panel's own
 * requests, and because the listener returned without answering, the UI saw only
 * "The message port closed before a response was received".
 *
 * @param sender - the sender Chrome passes to `chrome.runtime.onMessage`.
 * @param extensionUrlPrefix - this extension's origin, e.g. `chrome-extension://<id>/`.
 * @returns true when the message may be acted on.
 */
export function isExtensionPageSender(
  sender: MessageSenderLike | undefined,
  extensionUrlPrefix: string,
): boolean {
  if (sender === undefined) return true
  if (typeof sender.url === 'string') return sender.url.startsWith(extensionUrlPrefix)
  // No URL to judge by: admit only what cannot be a content script. An ambiguous
  // sender is refused rather than acted on — these handlers rewrite settings and
  // answer approvals.
  return sender.tab === undefined
}
