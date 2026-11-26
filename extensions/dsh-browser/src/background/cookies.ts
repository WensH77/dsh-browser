/**
 * Cookie access for the controlled tab, over the CDP `Network` domain.
 *
 * Cookies are the part of a site's session the page itself cannot always see:
 * `document.cookie` never reports an HttpOnly cookie, so `browser_eval` cannot
 * answer "am I still signed in" for a site that flags its session cookie. CDP
 * reads the browser's own cookie jar instead, which is also why every action
 * here is approved like `browser_eval` rather than trust-skipped — a write can
 * plant a value that later navigations in the tab send to the site.
 *
 * The `Network` domain does not have to be enabled: `getCookies`, `setCookies`
 * and `deleteCookies` are answered without it. The session is attached per call
 * and released in a `finally`, so the browser's debugging banner is transient.
 *
 * @module
 */

import { CaptureError, acquireDebuggerSession, cdpFailure, type DebuggerLease } from './debugger-session.ts'
import type { ToolAnswer } from './tools.ts'

/** Longest cookie list rendered in one answer; a site can hold more than is worth printing. */
const MAX_RENDERED_COOKIES = 100

/** One cookie as `Network.getCookies` reports it, narrowed to the fields this tool renders. */
interface CdpCookie {
  name?: unknown
  value?: unknown
  domain?: unknown
  path?: unknown
  expires?: unknown
  httpOnly?: unknown
  secure?: unknown
  session?: unknown
  sameSite?: unknown
}

/** Where one cookie lives: a URL, or a domain plus the path inside it. */
interface CookieTarget {
  url?: string
  domain?: string
  path?: string
  /** How the answer names the target. */
  label: string
}

const USAGE = 'browser_cookies requires "action": "get" reads the cookies of a url (default: the controlled page, optionally filtered by "name"); '
  + '"set" writes one cookie as { name, value, url | domain, path?, httpOnly?, secure?, sameSite?, expires? }; '
  + '"delete" removes one as { name, url | domain, path? }.'

const TARGET_REQUIRED = 'browser_cookies needs "url" (the page the cookie belongs to) or "domain" (the site it belongs to) to locate the cookie.'

function badArgs(message: string): ToolAnswer {
  return { ok: false, error: { code: 'bad-args', message } }
}

/** A trimmed, non-empty argument (names, urls, domains, enum values). */
function inlineArg(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

function answerError(error: unknown): ToolAnswer {
  const failure = error instanceof CaptureError ? error : cdpFailure(error)
  return { ok: false, error: { code: failure.code, message: failure.message } }
}

/**
 * Resolve where a `set`/`delete` call points.
 *
 * `url` locates a cookie by the page it belongs to; a bare `domain` locates it
 * by name in that domain's jar, which is the only way to reach a cookie for a
 * site the controlled tab is not on. `defaultPath` is filled in only for a
 * domain-located `set`: Chrome then has nothing to derive the path from, and
 * `/` is where a cookie without an explicit path is stored. A `delete` keeps
 * the path absent when the caller did not name one, because CDP treats a
 * missing path as "any path" while a path of `/` would silently spare a cookie
 * scoped to a deeper one.
 */
function cookieTarget(args: Record<string, unknown>, defaultPath?: string): CookieTarget | undefined {
  const url = inlineArg(args.url)
  const domain = inlineArg(args.domain)
  const path = inlineArg(args.path) ?? (url === undefined ? defaultPath : undefined)
  if (url !== undefined) return { url, ...path === undefined ? {} : { path }, label: url }
  if (domain === undefined) return undefined
  return { domain, ...path === undefined ? {} : { path }, label: domain }
}

/** Render one cookie as a single `name=value; field; field` line. */
function cookieLine(cookie: CdpCookie): string {
  const name = typeof cookie.name === 'string' ? cookie.name : ''
  const value = typeof cookie.value === 'string' ? cookie.value : ''
  const fields = [`${name}=${value}`]
  if (typeof cookie.domain === 'string' && cookie.domain !== '') fields.push(`domain=${cookie.domain}`)
  if (typeof cookie.path === 'string' && cookie.path !== '') fields.push(`path=${cookie.path}`)
  if (cookie.httpOnly === true) fields.push('httpOnly')
  if (cookie.secure === true) fields.push('secure')
  if (typeof cookie.sameSite === 'string' && cookie.sameSite !== '') fields.push(`sameSite=${cookie.sameSite}`)
  // CDP reports a session cookie with `expires: -1`; only the flag says so plainly.
  if (cookie.session === true) fields.push('expires=session')
  else if (typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) && cookie.expires > 0) fields.push(`expires=${cookie.expires}`)
  return `  ${fields.join('; ')}`
}

/** The `get` answer: one line per cookie, the count in the header, and no line for an empty jar. */
function cookiesText(url: string, cookies: readonly CdpCookie[]): string {
  if (cookies.length === 0) return `Cookies for ${url} (0): none.`
  const shown = cookies.slice(0, MAX_RENDERED_COOKIES)
  const lines = shown.map(cookieLine)
  if (cookies.length > shown.length) lines.push(`  (${cookies.length - shown.length} more cookie(s) omitted)`)
  return [`Cookies for ${url} (${cookies.length}):`, ...lines].join('\n')
}

/**
 * Run one CDP cookie call on a session held for this call alone, and release it
 * whatever happens.
 *
 * The attach sits outside the callback so the caller validates first — a
 * malformed call must not put the debugging banner on a tab it never needed.
 * An attach refusal is projected by the same rule as a command failure, so
 * Chrome's own words (protected page, foreign debugger) reach the model.
 */
async function withCookieSession(tabId: number, run: (lease: DebuggerLease) => Promise<string>): Promise<ToolAnswer> {
  let lease: DebuggerLease
  try {
    lease = await acquireDebuggerSession(tabId)
  } catch (error: unknown) {
    return answerError(error)
  }
  try {
    return { ok: true, result: { text: await run(lease) } }
  } catch (error: unknown) {
    return answerError(error)
  } finally {
    await lease.release()
  }
}

/**
 * Read, write, or delete one site's cookies.
 *
 * @param tabId - the controlled tab whose cookie jar is read or written.
 * @param args - `{ action, url?, name?, value?, domain?, path?, httpOnly?, secure?, sameSite?, expires? }`.
 * @param pageUrl - the controlled tab's URL, used by `get` when the call names none.
 * @returns the tool answer, with `bad-args` for a malformed call and
 *   `action-failed`/`unsupported` for a refusal from Chrome.
 */
export async function cookiesAnswer(tabId: number, args: Record<string, unknown>, pageUrl: string): Promise<ToolAnswer> {
  const action = args.action
  if (action !== 'get' && action !== 'set' && action !== 'delete') return badArgs(USAGE)

  if (action === 'get') {
    const url = inlineArg(args.url) ?? (pageUrl.trim() === '' ? undefined : pageUrl)
    if (url === undefined) {
      return badArgs('browser_cookies get needs "url": the controlled tab has no committed URL yet, so there is no page whose cookies could be read.')
    }
    const name = inlineArg(args.name)
    return await withCookieSession(tabId, async (lease) => {
      const raw = await lease.sendCommand('Network.getCookies', { urls: [url] }) as { cookies?: unknown }
      const cookies = Array.isArray(raw.cookies) ? raw.cookies as CdpCookie[] : []
      return cookiesText(url, name === undefined ? cookies : cookies.filter((cookie) => cookie.name === name))
    })
  }

  const name = inlineArg(args.name)
  if (name === undefined) {
    return badArgs(`browser_cookies ${action} requires "name" as a non-empty string.`)
  }

  if (action === 'set') {
    if (typeof args.value !== 'string') return badArgs('browser_cookies set requires "value" as a string (an empty string is allowed).')
    const target = cookieTarget(args, '/')
    if (target === undefined) return badArgs(TARGET_REQUIRED)
    const sameSite = args.sameSite
    if (sameSite !== undefined && sameSite !== 'Strict' && sameSite !== 'Lax' && sameSite !== 'None') {
      return badArgs('browser_cookies set "sameSite" must be "Strict", "Lax", or "None".')
    }
    const expires = args.expires
    if (expires !== undefined && (typeof expires !== 'number' || !Number.isFinite(expires))) {
      return badArgs('browser_cookies set "expires" must be a number of seconds since the Unix epoch; omit it for a session cookie.')
    }
    const cookie = {
      name,
      value: args.value,
      ...target.url === undefined ? {} : { url: target.url },
      ...target.domain === undefined ? {} : { domain: target.domain },
      ...target.path === undefined ? {} : { path: target.path },
      // HttpOnly is the whole reason this tool exists; pass the flag through as given.
      ...args.httpOnly === true ? { httpOnly: true } : {},
      ...args.secure === true ? { secure: true } : {},
      ...sameSite === undefined ? {} : { sameSite },
      ...expires === undefined ? {} : { expires },
    }
    return await withCookieSession(tabId, async (lease) => {
      await lease.sendCommand('Network.setCookies', { cookies: [cookie] })
      return `Set cookie "${name}" for ${target.label}.`
    })
  }

  const target = cookieTarget(args)
  if (target === undefined) return badArgs(TARGET_REQUIRED)
  return await withCookieSession(tabId, async (lease) => {
    await lease.sendCommand('Network.deleteCookies', {
      name,
      ...target.url === undefined ? {} : { url: target.url },
      ...target.domain === undefined ? {} : { domain: target.domain },
      ...target.path === undefined ? {} : { path: target.path },
    })
    return `Deleted cookie "${name}" from ${target.label}.`
  })
}
