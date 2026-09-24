// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { SessionAllowance, isSessionScopableAction, scopeKeyForCall } from '../src/security/session-allowance.ts'
import { allowsSessionScope, isApprovalDecision } from '../src/security/approval.ts'

describe('SessionAllowance', () => {
  it('keeps a grant inside the session that gave it', () => {
    const allowances = new SessionAllowance()
    allowances.remember('session-a', 'browser_dialog', 'browser_dialog')

    expect(allowances.allows('session-a', 'browser_dialog')).toBe(true)
    expect(allowances.allows('session-b', 'browser_dialog')).toBe(false)
    expect(allowances.allows(undefined, 'browser_dialog')).toBe(false)
  })

  it('grants one action at a time', () => {
    const allowances = new SessionAllowance()
    allowances.remember('session-a', 'browser_headers', 'browser_headers')

    expect(allowances.allows('session-a', 'browser_headers')).toBe(true)
    expect(allowances.allows('session-a', 'browser_dialog')).toBe(false)
  })

  it('separates response mocking from reading the same tool', () => {
    const allowances = new SessionAllowance()
    const mock = scopeKeyForCall('browser_network', { mock: { pattern: '*/api/*' } })
    expect(mock).toBe('browser_network#mock')

    allowances.remember('session-a', mock, 'browser_network')
    expect(allowances.allows('session-a', scopeKeyForCall('browser_network', { mock: { pattern: '*/api/*' } }))).toBe(true)
    // Listing requests is a read; the mock grant must not cover it.
    expect(allowances.allows('session-a', scopeKeyForCall('browser_network', {}))).toBe(false)
    // Withdrawing an override is the same rewrite power, so it shares the key.
    expect(scopeKeyForCall('browser_network', { mockClear: true })).toBe('browser_network#mock')
  })

  it('forgets a session when its binding goes away', () => {
    const allowances = new SessionAllowance()
    allowances.remember('session-a', 'browser_eval', 'browser_eval')
    allowances.remember('session-b', 'browser_eval', 'browser_eval')

    expect(allowances.clear('session-a')).toBe(true)
    expect(allowances.allows('session-a', 'browser_eval')).toBe(false)
    expect(allowances.allows('session-b', 'browser_eval')).toBe(true)
    expect(allowances.clear('session-a')).toBe(false)
  })

  it('reports what a session holds, newest first', () => {
    const allowances = new SessionAllowance()
    allowances.remember('session-a', 'browser_headers', 'browser_headers', 1)
    allowances.remember('session-a', 'browser_dialog', 'browser_dialog', 2)

    expect(allowances.grantsFor('session-a').map((grant) => grant.action)).toEqual(['browser_dialog', 'browser_headers'])
    expect(allowances.grantsFor('session-b')).toEqual([])
  })

  it('reports the grant key, which is what a later call is checked against', () => {
    // The panel lists keys: `browser_network#mock` and `browser_network` are two
    // powers under one tool name, and a list of bare names cannot show which one
    // the user still holds.
    const allowances = new SessionAllowance()
    allowances.remember('session-a', 'browser_network#mock', 'browser_network', 7)

    expect(allowances.grantsFor('session-a')).toEqual([
      { action: 'browser_network', key: 'browser_network#mock', grantedAt: 7 },
    ])
  })

  it('records why a session lost its grants', () => {
    const allowances = new SessionAllowance()
    allowances.remember('session-a', 'browser_eval', 'browser_eval')
    allowances.remember('session-a', 'browser_network#mock', 'browser_network')

    expect(allowances.revoke('session-a', 'rebind')).toEqual({ reason: 'rebind', count: 2 })
    expect(allowances.allows('session-a', 'browser_eval')).toBe(false)
    expect(allowances.revocationFor('session-a')).toEqual({ reason: 'rebind', count: 2 })
  })

  it('records nothing when a binding change drops nothing', () => {
    // An explanation with no loss would be noise: the panel would announce a
    // revocation the user never saw a grant for.
    const allowances = new SessionAllowance()

    expect(allowances.revoke('session-a', 'closed')).toBeUndefined()
    expect(allowances.revocationFor('session-a')).toBeUndefined()
    expect(allowances.revocationFor(undefined)).toBeUndefined()
  })

  it('keeps the revocation of one session out of another', () => {
    const allowances = new SessionAllowance()
    allowances.remember('session-a', 'browser_eval', 'browser_eval')
    allowances.remember('session-b', 'browser_eval', 'browser_eval')

    allowances.revoke('session-a', 'unbound')

    expect(allowances.revocationFor('session-a')?.reason).toBe('unbound')
    expect(allowances.revocationFor('session-b')).toBeUndefined()
    expect(allowances.allows('session-b', 'browser_eval')).toBe(true)
  })

  it('drops the explanation once the session is granted something again', () => {
    // The new grant answers "why was I asked again"; a stale reason beside a
    // live grant would contradict the list right above it.
    const allowances = new SessionAllowance()
    allowances.remember('session-a', 'browser_eval', 'browser_eval')
    allowances.revoke('session-a', 'rebind')

    allowances.remember('session-a', 'browser_eval', 'browser_eval', 9)

    expect(allowances.revocationFor('session-a')).toBeUndefined()
    expect(allowances.grantsFor('session-a')).toHaveLength(1)
  })

  it('drops revocations with the grants when a session is cleared outright', () => {
    const allowances = new SessionAllowance()
    allowances.remember('session-a', 'browser_eval', 'browser_eval')
    allowances.revoke('session-a', 'closed')

    expect(allowances.clear('session-a')).toBe(false)
    expect(allowances.revocationFor('session-a')).toBeUndefined()

    allowances.remember('session-a', 'browser_eval', 'browser_eval')
    allowances.revoke('session-a', 'closed')
    allowances.remember('session-b', 'browser_eval', 'browser_eval')
    allowances.clearAll()

    expect(allowances.revocationFor('session-a')).toBeUndefined()
    expect(allowances.allows('session-b', 'browser_eval')).toBe(false)
  })
})

describe('allowsSessionScope', () => {
  it('is the shared predicate for offering and honoring a session grant', () => {
    const scope = { kind: 'action' as const, action: 'browser_dialog', sessionId: 'session-a' }

    expect(allowsSessionScope('allow-in-session', scope)).toBe(true)
    expect(allowsSessionScope('allow-once', scope)).toBe(false)
    // No session to hand the action to: the button must never be offered, and
    // a forged decision must never be honored.
    expect(allowsSessionScope('allow-in-session', { ...scope, sessionId: undefined })).toBe(false)
    expect(allowsSessionScope('allow-in-session', { ...scope, sessionId: '  ' })).toBe(false)
    // Reads have their own persistent counterpart ("always allow reads").
    expect(allowsSessionScope('allow-in-session', { kind: 'read', action: 'browser_network', sessionId: 'session-a' })).toBe(false)
    // A navigation's risk is its destination, which a session grant would erase.
    expect(allowsSessionScope('allow-in-session', { kind: 'action', action: 'browser_navigate', sessionId: 'session-a' })).toBe(false)
  })

  it('accepts the decision over the extension message channel', () => {
    expect(isApprovalDecision('allow-in-session')).toBe(true)
    expect(isApprovalDecision('allow-everything')).toBe(false)
  })

  it('lists the actions that may hold a session grant', () => {
    for (const action of ['browser_network', 'browser_headers', 'browser_dialog', 'browser_eval', 'browser_back', 'browser_forward']) {
      expect(isSessionScopableAction(action), action).toBe(true)
    }
    for (const action of ['browser_navigate', 'browser_click', 'browser_console', 'browser_snapshot', 'gdrive.fetch']) {
      expect(isSessionScopableAction(action), action).toBe(false)
    }
  })
})
