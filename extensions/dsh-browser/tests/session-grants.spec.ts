// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  applySessionGrantsPush,
  grantsLine,
  revocationLine,
  type SessionGrantCopy,
  type SessionGrantsView,
} from '../src/panel/session-grants.ts'
import type { SessionGrantRevocation } from '../src/security/session-allowance.ts'
import type { SessionGrantsPush } from '../src/shared/messages.ts'

const ZH: SessionGrantCopy = {
  sessionGrants: '本会话已授予：',
  sessionGrantsNone: '无',
  grantSeparator: '、',
  revokedRebind: '受控标签页已更换',
  revokedClosed: '受控标签页已关闭',
  revokedReplaced: '受控标签页被替换',
  revokedUnbound: '本会话已解除关联',
  revokedCountBefore: '（',
  revokedCountAfter: ' 项授权）',
}

const EN: SessionGrantCopy = {
  sessionGrants: 'Session grants: ',
  sessionGrantsNone: 'none',
  grantSeparator: ', ',
  revokedRebind: 'The controlled tab changed',
  revokedClosed: 'The controlled tab closed',
  revokedReplaced: 'The controlled tab was replaced',
  revokedUnbound: 'The session was unbound',
  revokedCountBefore: ' (',
  revokedCountAfter: ' grant(s))',
}

const grant = (key: string, grantedAt = 1): { action: string; key: string; grantedAt: number } =>
  ({ action: key.split('#')[0]!, key, grantedAt })

const empty: SessionGrantsView = { grants: [], grantRevocation: null }

describe('panel session-grant lines', () => {
  it('lists the grant keys, in the session\'s own punctuation', () => {
    // Keys rather than tool names: `browser_network#mock` and `browser_eval` are
    // separate powers, and the separator differs per locale.
    const view: SessionGrantsView = { grants: [grant('browser_network#mock'), grant('browser_eval')], grantRevocation: null }

    expect(grantsLine(view, ZH)).toBe('本会话已授予：browser_network#mock、browser_eval')
    expect(grantsLine(view, EN)).toBe('Session grants: browser_network#mock, browser_eval')
  })

  it('says so when the session holds nothing', () => {
    expect(grantsLine(empty, ZH)).toBe('本会话已授予：无')
    expect(grantsLine(empty, EN)).toBe('Session grants: none')
  })

  it('names what went away and how much, for every reason', () => {
    const line = (revocation: SessionGrantRevocation): string => revocationLine(revocation, EN)

    expect(line({ reason: 'rebind', count: 2 })).toBe('The controlled tab changed (2 grant(s))')
    expect(line({ reason: 'closed', count: 1 })).toBe('The controlled tab closed (1 grant(s))')
    expect(line({ reason: 'replaced', count: 1 })).toBe('The controlled tab was replaced (1 grant(s))')
    expect(line({ reason: 'unbound', count: 3 })).toBe('The session was unbound (3 grant(s))')
    expect(revocationLine({ reason: 'rebind', count: 2 }, ZH)).toBe('受控标签页已更换（2 项授权）')
  })
})

describe('applySessionGrantsPush', () => {
  const push = (overrides: Partial<SessionGrantsPush>): SessionGrantsPush => ({
    type: 'push.session-grants',
    sessionId: 'session-a',
    grants: [],
    ...overrides,
  })

  it('applies a frame for the session on screen', () => {
    const next = applySessionGrantsPush(push({ grants: [grant('browser_eval')] }), 'session-a', empty)

    expect(next.grants.map((g) => g.key)).toEqual(['browser_eval'])
    expect(next.grantRevocation).toBeNull()
  })

  it('ignores a frame for another session', () => {
    // Grants are per session, so applying a stranger's list would replace what
    // the user is looking at with a session they are not operating.
    const current: SessionGrantsView = { grants: [grant('browser_eval')], grantRevocation: null }

    expect(applySessionGrantsPush(push({ sessionId: 'session-b', grants: [grant('browser_headers')] }), 'session-a', current))
      .toBe(current)
    expect(applySessionGrantsPush(push({ grants: [] }), undefined, current)).toBe(current)
  })

  it('carries the revocation that emptied the list', () => {
    const next = applySessionGrantsPush(
      push({ grants: [], revocation: { reason: 'rebind', count: 2 } }),
      'session-a',
      { grants: [grant('browser_eval'), grant('browser_headers')], grantRevocation: null },
    )

    expect(next.grants).toEqual([])
    expect(next.grantRevocation).toEqual({ reason: 'rebind', count: 2 })
  })

  it('drops the old explanation when a new grant arrives', () => {
    // The panel would otherwise show a live grant with a reason saying it was
    // dropped, which contradicts itself.
    const next = applySessionGrantsPush(
      push({ grants: [grant('browser_eval')] }),
      'session-a',
      { grants: [], grantRevocation: { reason: 'rebind', count: 1 } },
    )

    expect(next.grantRevocation).toBeNull()
  })
})
