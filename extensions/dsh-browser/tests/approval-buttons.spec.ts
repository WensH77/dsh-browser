// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { decisionButtons } from '../src/panel/approval-buttons.ts'
import type { ApprovalRequest } from '../src/security/approval.ts'

const COPY = {
  allowOnce: 'Allow once',
  deny: 'Deny',
  alwaysAllowReads: 'Always allow reads',
  trustOrigin: 'Trust this site',
  allowInSession: 'Allow in this session',
}

function request(overrides: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 'req',
    kind: 'action',
    action: 'browser_click',
    summary: 'Click element [3]',
    origins: ['https://app.example'],
    canTrust: true,
    ...overrides,
  }
}

function ids(overrides: Partial<ApprovalRequest>): string[] {
  return decisionButtons(request(overrides), COPY).map((button) => button.id)
}

describe('panel approval buttons', () => {
  it('offers trust on an action that is scoped to one origin', () => {
    expect(ids({ action: 'browser_click' })).toEqual(['allow-once', 'deny', 'trust-origin'])
  })

  it('offers the session grant exactly where trust is unavailable', () => {
    // JavaScript execution, header rewriting, dialog answers and response
    // mocking: no persistent origin grant exists, so the session is the scope.
    for (const action of ['browser_network', 'browser_headers', 'browser_dialog', 'browser_eval']) {
      expect(ids({
        action,
        canTrust: false,
        sessionId: 'session-a',
      }), action).toEqual(['allow-once', 'deny', 'allow-in-session'])
    }
  })

  it('keeps navigation on its own per-destination prompt', () => {
    // A cross-origin navigate names two origins, so trust cannot cover it —
    // but neither may a session grant: one approved destination must not
    // become permission to navigate anywhere for the rest of the session.
    expect(ids({ action: 'browser_navigate', origins: ['https://a.example', 'https://b.example'], sessionId: 'session-a' }))
      .toEqual(['allow-once', 'deny'])
    // A destination with no usable origin is likewise only askable once.
    expect(ids({ action: 'browser_navigate', origins: [], canTrust: false, sessionId: 'session-a' }))
      .toEqual(['allow-once', 'deny'])
  })

  it('offers the session grant for history moves, whose destination is unknown', () => {
    expect(ids({ action: 'browser_back', origins: [], canTrust: false, sessionId: 'session-a' }))
      .toEqual(['allow-once', 'deny', 'allow-in-session'])
  })

  it('never offers a session grant without a session to hand it to', () => {
    expect(ids({ action: 'browser_headers', canTrust: false })).toEqual(['allow-once', 'deny'])
    expect(ids({ action: 'browser_headers', canTrust: false, sessionId: '   ' })).toEqual(['allow-once', 'deny'])
  })

  it('keeps reads on their own persistent button', () => {
    expect(ids({ kind: 'read', action: 'browser_network', canTrust: false, sessionId: 'session-a' }))
      .toEqual(['allow-once', 'always-allow-reads', 'deny'])
  })
})
