// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { affinityFailureAnswer } from '../src/background/affinity-copy.ts'

describe('affinityFailureAnswer', () => {
  it('names both ways out when nothing is bound', () => {
    const answer = affinityFailureAnswer('missing')

    expect(answer).toMatchObject({ ok: false, error: { code: 'no-active-tab' } })
    // The session must not be left with "no page" and no next move.
    expect(answer.error?.message).toContain('browser_navigate')
    expect(answer.error?.message).toContain('browser_bind_interactive')
    expect(answer.error?.message).toContain('asks the user')
  })

  it('offers a rebind when no page is decided, without hijacking the active one', () => {
    const answer = affinityFailureAnswer('handoff')

    // A bound session never sees this: a focus change no longer pauses it.
    // Reaching here means the call had no decided page, so the two ways out are
    // an explicit pick and a fresh tab — never "the page you are looking at".
    expect(answer.error?.message).toContain('browser_bind_interactive')
    expect(answer.error?.message).toContain('browser_navigate')
    expect(answer.error?.message).not.toContain('opened the page for you')
  })

  it('offers a fresh tab or a rebind when the controlled tab closed', () => {
    const answer = affinityFailureAnswer('lost')

    expect(answer).toMatchObject({ ok: false, error: { code: 'content-unavailable' } })
    expect(answer.error?.message).toContain('browser_navigate')
    expect(answer.error?.message).toContain('browser_bind_interactive')
  })

  it('names the session that holds the browser instead of offering a bind', () => {
    const answer = affinityFailureAnswer('taken', { sessionId: 'session-2f31', url: 'https://app.example/orders' })

    expect(answer).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    expect(answer.error?.message).toContain('session-2f31')
    expect(answer.error?.message).toContain('https://app.example/orders')
    // The session cannot free the browser itself, so the only next move is the
    // user's: a bind retry would just fail again.
    expect(answer.error?.message).toContain('Unbind')
    expect(answer.error?.message).toContain('Do not retry')
    expect(answer.error?.message).not.toContain('browser_bind_interactive')
  })
})
