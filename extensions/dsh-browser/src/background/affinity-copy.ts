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
 */
export type AffinityFailureKind = 'handoff' | 'lost' | 'missing'

/**
 * Build the failure answer for one affinity problem.
 *
 * @param kind - handoff (no session binding and no decided target), lost (tab
 * closed), missing (never bound).
 * @returns the tool answer to settle the call with.
 */
export function affinityFailureAnswer(kind: AffinityFailureKind): ToolAnswer {
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
