/** Shared panel/background contract for browser action approval. */

import { isSessionScopableAction } from './session-allowance.ts'

export type ApprovalKind = 'read' | 'action'
export type ApprovalDecision = 'deny' | 'allow-once' | 'always-allow-reads' | 'trust-session' | 'trust-origin' | 'allow-in-session'
/**
 * Background authorization result; transport failures must not masquerade as a
 * user decision. `renew` is not a failure: the request expired while the panel
 * was closed, or the user chose a session-wide grant that first has to raise a
 * fresh prompt — the caller re-authorizes and only then runs the call.
 */
export type ApprovalAuthorization = 'approved' | 'denied' | 'unavailable' | 'timed-out' | 'cancelled' | 'renew'

/**
 * An authorization result that ends the call. `renew` is excluded: it means
 * the prompt has to be raised again, not that the user refused.
 */
export type ApprovalRefusal = Exclude<ApprovalAuthorization, 'approved' | 'renew'>

/**
 * What a consent gate reports: consent, refusal, or "ask me again".
 *
 * Gates that can retry also accept this in full; `authorizeUnboundNavigate`
 * narrows it to {@link ApprovalVerdict}, because it has no renewal path — it
 * approves a destination and opens exactly that destination, so everything it
 * can answer is final.
 */
export type ApprovalVerdict = ApprovalRefusal | 'approved'

/** A policy decision awaiting a user response. */
export interface ApprovalPrompt {
  kind: ApprovalKind
  action: string
  summary: string
  origins: string[]
  /** True only when one stable origin can safely be added to the action allowlist. */
  canTrust: boolean
}

/** Correlated request delivered to every open side-panel view. */
export interface ApprovalRequest extends ApprovalPrompt {
  id: string
  /** Agent session that requested the browser operation, when known. */
  sessionId?: string
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === 'deny'
    || value === 'allow-once'
    || value === 'always-allow-reads'
    || value === 'trust-session'
    || value === 'trust-origin'
    || value === 'allow-in-session'
}

/** What the background needs to know about a prompt to record a session grant. */
export interface SessionScope {
  kind: ApprovalKind
  action: string
  sessionId?: string
}

/**
 * Whether this decision hands the action to the session it belonged to.
 *
 * Both sides read this one predicate: the panel renders the button from the
 * request it received, and the background only records the grant for a request
 * that carries a session. A prompt with no session (an anonymous bridge call)
 * can never become a session-wide grant, so that button must not be offered.
 */
export function allowsSessionScope(
  decision: ApprovalDecision,
  scope: SessionScope,
): scope is SessionScope & { action: string; sessionId: string } {
  return decision === 'allow-in-session'
    && scope.kind === 'action'
    && isSessionScopableAction(scope.action)
    && scope.sessionId !== undefined
    && scope.sessionId.trim() !== ''
}
