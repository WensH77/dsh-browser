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

/** Why the session has no usable controlled tab. */
export type AffinityFailureKind = 'handoff' | 'lost' | 'missing'

/**
 * Build the failure answer for one affinity problem.
 *
 * @param kind - handoff (user switched tabs), lost (tab closed), missing (never bound).
 * @returns the tool answer to settle the call with.
 */
export function affinityFailureAnswer(kind: AffinityFailureKind): ToolAnswer {
  if (kind === 'handoff') {
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: 'The user switched tabs, so browser operations are paused. Switch back to the controlled page and retry — '
          + 'or call browser_bind_interactive to let the user pick which open page this session should follow.',
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
