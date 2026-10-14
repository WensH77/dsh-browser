// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { affinityFailureAnswer, offeringPageChoice } from '../src/background/affinity-copy.ts'

describe('affinityFailureAnswer', () => {
  it('names both ways out when nothing is bound', () => {
    const answer = affinityFailureAnswer('missing')

    expect(answer).toMatchObject({ ok: false, error: { code: 'no-active-tab' } })
    // The session must not be left with "no page" and no next move.
    expect(answer.error?.message).toContain('browser_navigate')
    expect(answer.error?.message).toContain('browser_bind_interactive')
    expect(answer.error?.message).toContain('asks the user')
    // A page choice fixes this one, so the host may make it inside the refused
    // call instead of settling the call with the failure.
    expect(answer.error?.needsPageChoice).toBe(true)
  })

  it('offers a rebind when no page is decided, without hijacking the active one', () => {
    const answer = affinityFailureAnswer('handoff')

    // A bound session never sees this: a focus change no longer pauses it.
    // Reaching here means the call had no decided page, so the two ways out are
    // an explicit pick and a fresh tab — never "the page you are looking at".
    expect(answer.error?.message).toContain('browser_bind_interactive')
    expect(answer.error?.message).toContain('browser_navigate')
    expect(answer.error?.message).not.toContain('opened the page for you')
    // Only a call that carries no session reaches this kind, and such a call
    // cannot bind anything: it stays the plain refusal.
    expect(answer.error?.needsPageChoice).toBeUndefined()
  })

  it('offers a fresh tab or a rebind when the controlled tab closed', () => {
    const answer = affinityFailureAnswer('lost')

    expect(answer).toMatchObject({ ok: false, error: { code: 'content-unavailable' } })
    expect(answer.error?.message).toContain('browser_navigate')
    expect(answer.error?.message).toContain('browser_bind_interactive')
    expect(answer.error?.needsPageChoice).toBe(true)
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
    // A page choice cannot fix this, so the host must not make one.
    expect(answer.error?.needsPageChoice).toBeUndefined()
  })

  it('names the page and every way out when only its own extension may touch it', () => {
    // Measured: a session auto-bound to another extension's page, where every
    // tool failed with "Cannot access a chrome-extension:// URL of different
    // extension". The answer has to say that the page is the problem.
    const answer = affinityFailureAnswer('unsupported', undefined, 'chrome-extension://abcdefghijklmnop/panel.html')

    expect(answer).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    expect(answer.error?.message).toContain('chrome-extension://abcdefghijklmnop/panel.html')
    expect(answer.error?.message).toContain('another extension')
    expect(answer.error?.message).toContain('Unbind')
    expect(answer.error?.message).toContain('browser_navigate')
    expect(answer.error?.message).toContain('browser_bind_interactive')
    // The bridge is fine; the page is not. Saying otherwise sends the session
    // off to reconnect a working connection.
    expect(answer.error?.message).toContain('Nothing else is wrong with the bridge')
    // `unsupported` covers two situations — a session with no page at all and a
    // bound session whose own tab went somewhere Chrome keeps to itself — and
    // only the caller knows which. Moving a bound session is the user's
    // decision, so the kind alone must not offer a bind.
    expect(answer.error?.needsPageChoice).toBeUndefined()
  })

  it('marks a page choice only for the refusals one resolves', () => {
    // The host acts on this mark by listing pages and binding one, so the
    // marking is a caller's decision: the kind alone never sets it for
    // `unsupported`, and a session that already owns a page is never marked.
    const refused = affinityFailureAnswer('unsupported', undefined, 'chrome://newtab/')
    const offered = offeringPageChoice(refused)
    expect(offered.error?.needsPageChoice).toBe(true)
    expect(offered.error?.message).toBe(refused.error?.message)
    // The answer it was given is untouched: the mark belongs to the refusal
    // going out, not to a shared object another caller also holds.
    expect(refused.error?.needsPageChoice).toBeUndefined()
    // A success has no error to mark, and marking must not invent one.
    expect(offeringPageChoice({ ok: true, result: { text: 'ok' } })).toEqual({ ok: true, result: { text: 'ok' } })
  })

  it('still names the page when the URL is unknown', () => {
    const answer = affinityFailureAnswer('unsupported')

    expect(answer.error?.message).toContain('The current page')
    expect(answer.error?.message).toContain('http(s) page')
  })
})
