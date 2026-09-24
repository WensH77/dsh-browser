/**
 * Which buttons one approval card offers.
 *
 * Kept out of the React component so the rule can be tested directly: the
 * panel and the background must agree on what a visible button means, and a
 * button the background would refuse is worse than no button at all.
 *
 * "Allow in this session" is the counterpart of an absent "Trust this site":
 * it appears exactly on the action cards that trust cannot cover — JavaScript
 * execution, header rewriting, dialog answers, response mocking, and actions
 * whose origin cannot be pinned to one site. It needs a session to name, so an
 * anonymous bridge call never shows it.
 */

import { allowsSessionScope, type ApprovalDecision, type ApprovalRequest } from '../security/approval.ts'

export interface ApprovalButton {
  id: ApprovalDecision
  label: string
}

/** The card labels; the panel passes the ones for the active UI locale. */
export interface ApprovalCopy {
  allowOnce: string
  deny: string
  alwaysAllowReads: string
  trustOrigin: string
  allowInSession: string
}

export function decisionButtons(request: ApprovalRequest, copy: ApprovalCopy): ApprovalButton[] {
  const buttons: ApprovalButton[] = [
    { id: 'allow-once', label: copy.allowOnce },
    { id: 'deny', label: copy.deny },
  ]
  if (request.kind === 'read') {
    buttons.splice(1, 0, { id: 'always-allow-reads', label: copy.alwaysAllowReads })
    return buttons
  }
  // Trust and a session grant are the two scopes an action can have: a site
  // that persists, or this session only. The card offers whichever exists,
  // and never both: where trust is offered, the origin is the better answer.
  if (request.canTrust && request.origins.length === 1) {
    buttons.push({ id: 'trust-origin', label: copy.trustOrigin })
  } else if (allowsSessionScope('allow-in-session', request)) {
    buttons.push({ id: 'allow-in-session', label: copy.allowInSession })
  }
  return buttons
}
