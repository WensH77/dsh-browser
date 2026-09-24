// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { unboundNavigateDestination } from '../src/background/navigate-consent.ts'

const neverDsh = (): boolean => false

describe('unboundNavigateDestination', () => {
  it('resolves an http(s) destination for an unbound session', () => {
    const destination = unboundNavigateDestination(
      { name: 'browser_navigate', sessionId: 'session-1', args: { url: 'https://www.google.com/search?q=x' } },
      neverDsh,
    )

    expect(destination?.href).toBe('https://www.google.com/search?q=x')
  })

  it('treats a session bound to the dsh page itself as unbound', () => {
    const destination = unboundNavigateDestination(
      { name: 'browser_navigate', sessionId: 'session-1', args: { url: 'https://example.com/' }, boundUrl: 'http://127.0.0.1:3080/' },
      (url) => url.startsWith('http://127.0.0.1:3080'),
    )

    expect(destination?.href).toBe('https://example.com/')
  })

  it('leaves an already-bound real page to the normal dispatch path', () => {
    expect(unboundNavigateDestination(
      { name: 'browser_navigate', sessionId: 'session-1', args: { url: 'https://example.com/next' }, boundUrl: 'https://example.com/current' },
      neverDsh,
    )).toBeUndefined()
  })

  it('ignores other tools, session-less calls, and non-http destinations', () => {
    expect(unboundNavigateDestination({ name: 'browser_click', sessionId: 'session-1', args: { index: 1 } }, neverDsh)).toBeUndefined()
    expect(unboundNavigateDestination({ name: 'browser_navigate', args: { url: 'https://example.com/' } }, neverDsh)).toBeUndefined()
    expect(unboundNavigateDestination({ name: 'browser_navigate', sessionId: '  ', args: { url: 'https://example.com/' } }, neverDsh)).toBeUndefined()
    expect(unboundNavigateDestination({ name: 'browser_navigate', sessionId: 'session-1', args: {} }, neverDsh)).toBeUndefined()
    expect(unboundNavigateDestination({ name: 'browser_navigate', sessionId: 'session-1', args: { url: 'not a url' } }, neverDsh)).toBeUndefined()
    for (const url of ['file:///etc/hosts', 'javascript:alert(1)', 'chrome://extensions', 'data:text/html,x']) {
      expect(unboundNavigateDestination({ name: 'browser_navigate', sessionId: 'session-1', args: { url } }, neverDsh)).toBeUndefined()
    }
  })
})
