/**
 * What the model is told when the controlled tab is not usable.
 *
 * These messages are the only steering a stuck session gets, so each one names
 * the exact next tool call — "no bindable page" without an action is how a
 * session ends up flailing or asking the user a question it could answer.
 *
 * @module
 */

import type { ToolAnswer } from './tools.ts'

/**
 * Why the session has no usable controlled tab.
 *
 * `handoff` is only reachable for a call that carries no session binding: a
 * session that owns a tab keeps operating it while the user looks elsewhere,
 * so this is no longer the "user switched tabs" answer it once was.
 *
 * `taken` is the one answer the session cannot fix by itself: the browser is
 * bound to a *different* session, and only the user can hand it over.
 *
 * `unsupported` is a page Chrome does not let any other extension touch —
 * another extension's page (`chrome-extension://…`), a `chrome://` page, a
 * `file://` URL. Both content scripts and `chrome.debugger` are refused there,
 * so every tool would fail; saying which page it is beats letting the session
 * collect attach errors.
 */
export type AffinityFailureKind = 'handoff' | 'lost' | 'missing' | 'taken' | 'unsupported'

/** The other session holding the controlled tab, as the panel shows it. */
export interface BindingHolder {
  /** Agent session that owns the binding. */
  sessionId: string
  /** Page that session is operating, when known. */
  url?: string
}

/**
 * Build the failure answer for one affinity problem.
 *
 * @param kind - handoff (no session binding and no decided target), lost (tab
 * closed), missing (never bound), taken (bound to another session),
 * unsupported (the page cannot be operated by any other extension).
 * @param holder - the session holding the binding; required for `taken`.
 * @param pageUrl - the page `unsupported` is about, so the answer can name it.
 * @returns the tool answer to settle the call with.
 */
export function affinityFailureAnswer(kind: AffinityFailureKind, holder?: BindingHolder, pageUrl?: string): ToolAnswer {
  if (kind === 'unsupported') {
    const page = pageUrl === undefined || pageUrl === '' ? 'The current page' : pageUrl
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: `${page} cannot be operated. Chrome lets only its own extension touch a page like this `
          + '(another extension\'s page, a browser-internal page, or a local file): content scripts are refused and '
          + 'chrome.debugger refuses to attach, so screenshots, console, network and evaluation would all fail on it. '
          + 'Nothing else is wrong with the bridge. Ask the user to switch to an ordinary http(s) page and press Unbind '
          + 'in the dsh browser panel if it stays bound, or call browser_navigate with the target URL to open a normal '
          + 'tab, or browser_bind_interactive to pick one of the ordinary pages already open.',
      },
    }
  }
  if (kind === 'taken') {
    const who = holder === undefined
      ? 'another session'
      : `session ${holder.sessionId}${holder.url === undefined ? '' : ` on ${holder.url}`}`
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: `The controlled tab is already bound to ${who}: one session owns the browser at a time, so this call did not bind anything. `
          + 'Do not retry it as-is. If the user wants this session to take over, ask them to press Unbind in the dsh browser panel '
          + '(or to keep working in the session that already holds it), then retry.',
      },
    }
  }
  if (kind === 'handoff') {
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: 'No page is decided for this call yet, so browser operations are paused. '
          + 'Call browser_bind_interactive to let the user pick which open page this session should follow, '
          + 'or browser_navigate to open the target URL in a new tab.',
      },
    }
  }
  if (kind === 'lost') {
    return {
      ok: false,
      error: {
        code: 'content-unavailable',
        message: 'The controlled tab was closed. Call browser_navigate to open a page in a new tab, '
          + 'or browser_bind_interactive to let the user pick one of the pages still open.',
      },
    }
  }
  return {
    ok: false,
    error: {
      code: 'no-active-tab',
      message: 'No page is bound to this session yet, and the tab the user is looking at is the dsh UI itself, which is never handed to a session. '
        + 'Either call browser_navigate with the target URL (it opens a new tab and binds this session to it), '
        + 'or call browser_bind_interactive, which lists the open pages and asks the user which one to use.',
    },
  }
}
