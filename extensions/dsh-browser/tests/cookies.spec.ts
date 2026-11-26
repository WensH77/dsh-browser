// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cookiesAnswer } from '../src/background/cookies.ts'
import { resetDebuggerSessionsForTest } from '../src/background/debugger-session.ts'
import { dispatchToolCall, type ToolAnswer } from '../src/background/tools.ts'

const PAGE_URL = 'https://app.example/page'

interface SentCommand {
  method: string
  params?: unknown
}

interface Mock {
  attach: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  sendCommand: ReturnType<typeof vi.fn>
  getTargets: ReturnType<typeof vi.fn>
  sent: SentCommand[]
}

/**
 * Stand in for `chrome.debugger`.
 *
 * `getCookies` answers with the cookies a test hands it; every other method
 * answers empty, except the ones named in `failures`, which throw.
 */
function mockDebugger(overrides: {
  attachError?: Error
  cookies?: Array<Record<string, unknown>>
  failures?: Record<string, Error>
  targets?: unknown[]
} = {}): Mock {
  const sent: SentCommand[] = []
  const attach = vi.fn(async () => {
    if (overrides.attachError !== undefined) throw overrides.attachError
  })
  const detach = vi.fn(async () => undefined)
  const sendCommand = vi.fn(async (_target: unknown, method: string, params?: unknown) => {
    sent.push({ method, params })
    const failure = overrides.failures?.[method]
    if (failure !== undefined) throw failure
    if (method === 'Network.getCookies') return { cookies: overrides.cookies ?? [] }
    return {}
  })
  const getTargets = vi.fn(async () => overrides.targets ?? [])
  vi.stubGlobal('chrome', { debugger: { attach, detach, sendCommand, getTargets } })
  return { attach, detach, sendCommand, getTargets, sent }
}

function textOf(answer: ToolAnswer): string {
  expect(answer.ok).toBe(true)
  return (answer.result as { text: string }).text
}

afterEach(() => {
  resetDebuggerSessionsForTest()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('browser_cookies get', () => {
  it('lists every cookie with its flags, HttpOnly included, and releases the session', async () => {
    const mock = mockDebugger({
      cookies: [
        {
          name: 'sid',
          value: 'abc',
          domain: '.example.com',
          path: '/',
          expires: 1_730_000_000,
          size: 36,
          httpOnly: true,
          secure: true,
          session: false,
          sameSite: 'Lax',
          priority: 'Medium',
        },
        {
          name: 'theme',
          value: 'dark',
          domain: '.example.com',
          path: '/',
          expires: -1,
          size: 15,
          httpOnly: false,
          secure: false,
          session: true,
          sameSite: 'Lax',
          priority: 'Medium',
        },
      ],
    })

    const text = textOf(await cookiesAnswer(7, { action: 'get' }, PAGE_URL))

    expect(text).toContain(`Cookies for ${PAGE_URL} (2):`)
    expect(text).toContain('  sid=abc; domain=.example.com; path=/; httpOnly; secure; sameSite=Lax; expires=1730000000')
    // A session cookie says so; CDP's own `expires: -1` never reaches the model.
    expect(text).toContain('  theme=dark; domain=.example.com; path=/; sameSite=Lax; expires=session')
    expect(mock.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Network.getCookies', { urls: [PAGE_URL] })
    expect(mock.detach).toHaveBeenCalledWith({ tabId: 7 })
  })

  it('filters by name and reads the url the call names instead of the page', async () => {
    const mock = mockDebugger({
      cookies: [
        { name: 'sid', value: 'abc', domain: '.example.com', path: '/', httpOnly: true },
        { name: 'theme', value: 'dark', domain: '.example.com', path: '/' },
      ],
    })

    const text = textOf(await cookiesAnswer(7, { action: 'get', url: 'https://other.example/x', name: 'theme' }, PAGE_URL))

    expect(text).toContain('Cookies for https://other.example/x (1):')
    expect(text).toContain('theme=dark')
    expect(text).not.toContain('sid=')
    expect(mock.sent[0]?.params).toEqual({ urls: ['https://other.example/x'] })
  })

  it('says none for an empty jar and still releases the session', async () => {
    const mock = mockDebugger({ cookies: [] })

    const text = textOf(await cookiesAnswer(7, { action: 'get' }, PAGE_URL))

    expect(text).toBe(`Cookies for ${PAGE_URL} (0): none.`)
    expect(mock.detach).toHaveBeenCalledWith({ tabId: 7 })
  })

  it('asks for a url when the tab has no committed one', async () => {
    const mock = mockDebugger()

    const answer = await cookiesAnswer(7, { action: 'get' }, '')

    expect(answer).toMatchObject({ ok: false, error: { code: 'bad-args' } })
    expect((answer.error as { message: string }).message).toContain('"url"')
    expect(mock.attach).not.toHaveBeenCalled()
  })
})

describe('browser_cookies set', () => {
  it('writes one cookie through the url form and passes HttpOnly and the flags through', async () => {
    const mock = mockDebugger()

    const text = textOf(await cookiesAnswer(3, {
      action: 'set',
      name: 'sid',
      value: 'new-session',
      url: 'https://app.example/auth',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    }, ''))

    expect(text).toBe('Set cookie "sid" for https://app.example/auth.')
    expect(mock.sent).toHaveLength(1)
    expect(mock.sent[0]).toEqual({
      method: 'Network.setCookies',
      params: {
        cookies: [{
          name: 'sid',
          value: 'new-session',
          url: 'https://app.example/auth',
          httpOnly: true,
          secure: true,
          sameSite: 'None',
        }],
      },
    })
    expect(mock.detach).toHaveBeenCalledWith({ tabId: 3 })
  })

  it('writes one cookie located by domain, defaulting the path to / and keeping expires', async () => {
    const mock = mockDebugger()

    textOf(await cookiesAnswer(3, {
      action: 'set',
      name: 'flag',
      value: '1',
      domain: '.example.com',
      expires: 1_730_000_000,
    }, ''))

    expect(mock.sent[0]?.params).toEqual({
      cookies: [{ name: 'flag', value: '1', domain: '.example.com', path: '/', expires: 1_730_000_000 }],
    })
  })

  it('keeps an empty value, which is a valid cookie', async () => {
    const mock = mockDebugger()

    textOf(await cookiesAnswer(3, { action: 'set', name: 'cleared', value: '', url: PAGE_URL }, ''))

    expect(mock.sent[0]?.params).toEqual({ cookies: [{ name: 'cleared', value: '', url: PAGE_URL }] })
  })
})

describe('browser_cookies delete', () => {
  it('deletes by url', async () => {
    const mock = mockDebugger()

    const text = textOf(await cookiesAnswer(3, { action: 'delete', name: 'sid', url: 'https://app.example/' }, ''))

    expect(text).toBe('Deleted cookie "sid" from https://app.example/.')
    expect(mock.sent).toEqual([{ method: 'Network.deleteCookies', params: { name: 'sid', url: 'https://app.example/' } }])
    expect(mock.detach).toHaveBeenCalledWith({ tabId: 3 })
  })

  it('deletes by domain and path', async () => {
    const mock = mockDebugger()

    const text = textOf(await cookiesAnswer(3, { action: 'delete', name: 'sid', domain: '.example.com', path: '/app' }, ''))

    expect(text).toBe('Deleted cookie "sid" from .example.com.')
    expect(mock.sent[0]?.params).toEqual({ name: 'sid', domain: '.example.com', path: '/app' })
  })

  it('leaves the path out when none was named, so any path matches', async () => {
    const mock = mockDebugger()

    textOf(await cookiesAnswer(3, { action: 'delete', name: 'sid', domain: '.example.com' }, ''))

    expect(mock.sent[0]?.params).toEqual({ name: 'sid', domain: '.example.com' })
  })
})

describe('browser_cookies privacy boundary', () => {
  it('refuses a cookie read when page content sharing is off, before touching CDP', async () => {
    const mock = mockDebugger()

    const answer = await dispatchToolCall(
      { id: 'call-1', name: 'browser_cookies', args: { action: 'get', url: PAGE_URL } },
      'off',
    )

    expect(answer).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    expect(answer.error?.message).toContain('Page content sharing is disabled')
    expect(mock.attach).not.toHaveBeenCalled()
  })
})

describe('browser_cookies refusals', () => {
  it('refuses a malformed call before attaching a session', async () => {
    const mock = mockDebugger()

    const malformed: Array<Record<string, unknown>> = [
      {},
      { action: 'list' },
      { action: 'set', name: 'sid', url: PAGE_URL },
      { action: 'set', value: 'v', url: PAGE_URL },
      { action: 'set', name: 'sid', value: 'v' },
      { action: 'set', name: 'sid', value: 'v', url: PAGE_URL, sameSite: 'Lax2' },
      { action: 'set', name: 'sid', value: 'v', url: PAGE_URL, expires: 'tomorrow' },
      { action: 'delete', name: 'sid' },
      { action: 'delete', url: PAGE_URL },
    ]
    for (const args of malformed) {
      const answer = await cookiesAnswer(3, args, PAGE_URL)
      expect(answer.ok).toBe(false)
      expect(answer.error?.code).toBe('bad-args')
    }

    expect(mock.attach).not.toHaveBeenCalled()
    expect(mock.sendCommand).not.toHaveBeenCalled()
  })

  it('reports a command refusal with Chrome\'s own message and releases the session', async () => {
    const mock = mockDebugger({ failures: { 'Network.setCookies': new Error('Invalid cookie fields') } })

    const answer = await cookiesAnswer(5, { action: 'set', name: 'sid', value: 'v', url: PAGE_URL }, '')

    expect(answer).toMatchObject({
      ok: false,
      error: { code: 'action-failed', message: 'The debugging call failed: Invalid cookie fields' },
    })
    expect(mock.detach).toHaveBeenCalledWith({ tabId: 5 })
  })

  it('reports an attach refusal with the session module\'s own message', async () => {
    const mock = mockDebugger({ attachError: new Error('Cannot attach to this target.'), targets: [] })

    const answer = await cookiesAnswer(9, { action: 'get' }, PAGE_URL)

    expect(answer.ok).toBe(false)
    expect(answer.error?.code).toBe('unsupported')
    expect(answer.error?.message).toContain('cannot be debugged')
    // No lease was handed out, so there is nothing to release.
    expect(mock.detach).not.toHaveBeenCalled()
  })
})
