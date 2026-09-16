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

  it('offers to rebind after the user switched tabs, without hijacking the new one', () => {
    const answer = affinityFailureAnswer('handoff')

    expect(answer.error?.message).toContain('switched tabs')
    expect(answer.error?.message).toContain('browser_bind_interactive')
    expect(answer.error?.message).not.toContain('opened the page for you')
  })

  it('offers a fresh tab or a rebind when the controlled tab closed', () => {
    const answer = affinityFailureAnswer('lost')

    expect(answer).toMatchObject({ ok: false, error: { code: 'content-unavailable' } })
    expect(answer.error?.message).toContain('browser_navigate')
    expect(answer.error?.message).toContain('browser_bind_interactive')
  })
})
