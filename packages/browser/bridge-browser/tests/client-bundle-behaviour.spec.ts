// @vitest-environment jsdom
/**
 * Behaviour tests for the hand-written web client bundle.
 *
 * `src/client/client.js` is not compiled by `tsc`/`tsdown`; the browser's
 * module loader is the only consumer. `client-bundle.spec.ts` guards the
 * strings that must stay in sync between the host and the bundle. This file
 * runs the bundle instead: it installs a minimal `window.__ModuleLoader__`,
 * evaluates the file, and drives `apply()` against a real (jsdom) DOM with
 * fake timers and a stubbed `fetch`.
 *
 * In Vitest's jsdom environment the global object is the window
 * (`populateGlobal` sets `window = globalThis`), so the bundle's bare
 * `fetch`/`setTimeout`/`MutationObserver` resolve to the stubs installed here.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src/client/client.js'), 'utf8')

const ATTR = 'data-dsh-browser-bound'
const STYLE_SELECTOR = 'style[data-plugin-css="dsh-bridge-browser/session-badge.css"]'
const ROUTE = '/bridge-browser/bindings'

interface Bundle {
  apply(ctx: unknown): () => void
}

interface FetchInit {
  signal?: AbortSignal
}

interface LoaderWindow {
  __ModuleLoader__?: {
    load(entry: { id?: string; factory: (require: (id: string) => never) => Bundle }): void
  }
  eval(code: string): void
}

let teardown: (() => void) | undefined
let hiddenDescriptor: PropertyDescriptor | undefined
let loaderWindow: LoaderWindow

/** Execute the bundle and return its exported module. */
function loadBundle(): Bundle {
  let loaded: Bundle | undefined
  loaderWindow.__ModuleLoader__ = {
    load: ({ factory }) => {
      // The bundle is self-contained: a require call would be a bug.
      loaded = factory((id) => {
        throw new Error(`the client bundle must not require(${JSON.stringify(id)})`)
      })
    },
  }
  loaderWindow.eval(source)
  if (loaded === undefined) throw new Error('the bundle did not call __ModuleLoader__.load')
  return loaded
}

/** Install a fetch stub and return the mock for call assertions. */
function stubFetch(handler: (init: FetchInit) => Promise<unknown>) {
  const mock = vi.fn(async (_input: unknown, init?: FetchInit) => handler(init ?? {}))
  vi.stubGlobal('fetch', mock)
  return mock
}

/** A Response-shaped object; the bundle only reads `ok`, `status` and `json()`. */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }
}

/** Drain pending promises (fetch, JSON parse, MutationObserver microtasks). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  for (let round = 0; round < 4; round += 1) await Promise.resolve()
}

function addRow(sessionId: string): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('data-row-key', `session:${sessionId}`)
  document.body.appendChild(row)
  return row
}

function hideDocument(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  loaderWindow = globalThis as unknown as LoaderWindow
  hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden')
  document.body.innerHTML = ''
  for (const style of document.querySelectorAll(STYLE_SELECTOR)) style.remove()
})

afterEach(() => {
  teardown?.()
  teardown = undefined
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  for (const style of document.querySelectorAll(STYLE_SELECTOR)) style.remove()
  if (hiddenDescriptor === undefined) Reflect.deleteProperty(document, 'hidden')
  else Object.defineProperty(document, 'hidden', hiddenDescriptor)
  delete loaderWindow.__ModuleLoader__
})

describe('client bundle behaviour', () => {
  it('tags the bound session row and injects the stylesheet only once', async () => {
    const boundRow = addRow('s-1')
    const otherRow = addRow('s-2')
    const fetchMock = stubFetch(async () =>
      jsonResponse({
        ok: true,
        connected: true,
        supported: true,
        revision: 12,
        bindings: [{ sessionId: 's-1', tabId: 42 }],
      }),
    )

    const bundle = loadBundle()
    // A second evaluation (HMR, remount) must reuse the injected <style>.
    loadBundle()
    teardown = bundle.apply({})
    await settle()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(ROUTE, {
      cache: 'no-store',
      signal: expect.anything(),
    })
    expect(boundRow.hasAttribute(ATTR)).toBe(true)
    expect(otherRow.hasAttribute(ATTR)).toBe(false)
    expect(document.querySelectorAll(STYLE_SELECTOR)).toHaveLength(1)
  })

  it('re-tags a row after the attribute is removed and after React replaces the row', async () => {
    stubFetch(async () => jsonResponse({ bindings: [{ sessionId: 's-1' }] }))
    const row = addRow('s-1')
    teardown = loadBundle().apply({})
    await settle()
    expect(row.hasAttribute(ATTR)).toBe(true)

    // A re-render that drops the prop and also mutates the list (childList is
    // what the observer watches; the attribute filter is only `data-row-key`).
    row.removeAttribute(ATTR)
    document.body.appendChild(document.createElement('span'))
    await settle()
    await vi.advanceTimersByTimeAsync(250)
    expect(row.hasAttribute(ATTR)).toBe(true)

    // A remount that replaces the element with a fresh one.
    row.remove()
    const replacement = addRow('s-1')
    await settle()
    await vi.advanceTimersByTimeAsync(250)
    expect(replacement.hasAttribute(ATTR)).toBe(true)
  })

  it('clears the marker when the next poll reports no bindings', async () => {
    let bindings: unknown[] = [{ sessionId: 's-1' }]
    const fetchMock = stubFetch(async () => jsonResponse({ bindings }))
    const row = addRow('s-1')
    teardown = loadBundle().apply({})
    await settle()
    expect(row.hasAttribute(ATTR)).toBe(true)

    bindings = []
    await vi.advanceTimersByTimeAsync(5000)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(row.hasAttribute(ATTR)).toBe(false)
  })

  it('clears markers on a non-2xx response and backs off past the poll interval', async () => {
    let calls = 0
    const fetchMock = stubFetch(async () => {
      calls += 1
      if (calls === 1) return jsonResponse({ bindings: [{ sessionId: 's-1' }] })
      return jsonResponse({ error: 'unauthorized' }, { ok: false, status: 401 })
    })
    const row = addRow('s-1')
    teardown = loadBundle().apply({})
    await settle()
    expect(row.hasAttribute(ATTR)).toBe(true)

    // Second poll at +5s fails: the stale marker must go.
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(row.hasAttribute(ATTR)).toBe(false)

    // The next attempt is scheduled at +10s (5s x2), not another 5s.
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('teardown clears markers, disconnects the observer, aborts in-flight work and stops polling', async () => {
    let calls = 0
    let pendingSignal: AbortSignal | undefined
    const neverSettles = new Promise<unknown>(() => {})
    const fetchMock = stubFetch(async (init) => {
      calls += 1
      if (calls === 1) return jsonResponse({ bindings: [{ sessionId: 's-1' }] })
      pendingSignal = init.signal
      return neverSettles
    })
    const row = addRow('s-1')
    const bundle = loadBundle()
    teardown = bundle.apply({})
    await settle()
    expect(row.hasAttribute(ATTR)).toBe(true)

    // Poll #2 hangs: advance synchronously so the test does not await it.
    vi.advanceTimersByTime(5000)
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(pendingSignal).toBeDefined()

    const remove = teardown
    teardown = undefined
    remove()

    expect(pendingSignal?.aborted).toBe(true)
    expect(row.hasAttribute(ATTR)).toBe(false)

    // No timer survives: neither the poll nor the request timeout.
    vi.advanceTimersByTime(60000)
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // The observer is disconnected: a new matching row is not tagged.
    const lateRow = addRow('s-1')
    await settle()
    vi.advanceTimersByTime(1000)
    await Promise.resolve()
    expect(lateRow.hasAttribute(ATTR)).toBe(false)

    // The visibility listener is removed: waking the tab must not fetch.
    hideDocument(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not request while the document starts hidden and resumes on visibilitychange', async () => {
    hideDocument(true)
    const fetchMock = stubFetch(async () => jsonResponse({ bindings: [{ sessionId: 's-1' }] }))
    const row = addRow('s-1')
    teardown = loadBundle().apply({})
    await settle()

    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetchMock).not.toHaveBeenCalled()

    hideDocument(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row.hasAttribute(ATTR)).toBe(true)
  })

  it('stops the scheduled poll while hidden and fetches immediately when visible again', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ bindings: [{ sessionId: 's-1' }] }))
    teardown = loadBundle().apply({})
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    hideDocument(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    hideDocument(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()

    // Resumed without waiting for the 5s interval.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a numeric sessionId', { bindings: [{ sessionId: 123 }] }],
    ['a non-array bindings field', { bindings: 'not-an-array' }],
    ['a null body', null],
    ['an array body', []],
    ['an object without bindings', { ok: true }],
  ])('ignores a malformed payload: %s', async (_label, payload) => {
    const row = addRow('s-1')
    stubFetch(async () => jsonResponse(payload))
    const bundle = loadBundle()

    expect(() => {
      teardown = bundle.apply({})
    }).not.toThrow()
    await settle()

    expect(row.hasAttribute(ATTR)).toBe(false)
    expect(document.querySelectorAll(`[${ATTR}]`)).toHaveLength(0)
  })
})
