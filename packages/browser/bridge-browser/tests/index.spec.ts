import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { apply, assertPositiveInteger, Config, resolveConfig } from '../src/index.ts'
import { BRIDGE_BINDINGS_PATH } from '../src/protocol.ts'

/**
 * Minimal context stub: apply only needs the services at registration time.
 *
 * @param reject - optional trust fence for the connection service; when given,
 *   the bindings route must go through it instead of the loopback fallback.
 */
function stubContext(reject?: (headers: Record<string, unknown>) => 401 | 403 | undefined): {
  ctx: Context
  registered: string[]
  routes: WebRoute[]
} {
  const registered: string[] = []
  const routes: WebRoute[] = []
  const gateway = {
    wireStream: {
      open: async (): Promise<AsyncIterable<unknown>> => ({ async *[Symbol.asyncIterator]() {} }),
      failure: (error: unknown) => ({ code: 'internal', message: String(error), details: {} }),
    },
    invoke: async () => undefined,
  }
  const connection = {
    createSharedFetchHandler: () => ({ fetch: async () => new Response('not found', { status: 404 }) }),
    ...(reject === undefined ? {} : {
      requestRejection: (request: { headers: Record<string, unknown> }) => reject(request.headers),
    }),
  }
  const ctx = {
    webServer: {
      port: 0,
      registerUpgrade: () => () => {},
      register: (route: WebRoute) => {
        routes.push(route)
        return () => {}
      },
    },
    tools: {
      register: (definition: { name: string }) => {
        registered.push(definition.name)
        return () => {}
      },
    },
    agents: { get: () => undefined },
    get: (key: string) => key === 'typertGateway' ? gateway : key === 'connection' ? connection : undefined,
    on: () => () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn: () => unknown, label?: string) => {
      void label
      return fn() as () => void
    },
  } as unknown as Context
  return { ctx, registered, routes }
}

const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('assertPositiveInteger', () => {
  it('accepts positive integers and rejects everything else', () => {
    expect(() => assertPositiveInteger('x', 1)).not.toThrow()
    expect(() => assertPositiveInteger('x', 0)).toThrow(/must be a positive integer/)
    expect(() => assertPositiveInteger('x', -1)).toThrow(/must be a positive integer/)
    expect(() => assertPositiveInteger('x', 1.5)).toThrow(/must be a positive integer/)
  })
})

/** Valid budgets (the Loader applies schema defaults; hand-built tests pass them explicitly). */
const VALID = { toolTimeoutMs: 90_000, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }

describe('config', () => {
  it('resolves defaults for every tunable', () => {
    expect(resolveConfig({})).toEqual(VALID)
    expect(new Config().toolTimeoutMs).toBe(90_000)
    expect(new Config().snapshotMaxChars).toBe(32_000)
    expect(new Config().maxInteractiveItems).toBe(60)
  })

  it('preserves explicit values', () => {
    const explicit = {
      token: 'fixed',
      toolTimeoutMs: 1,
      snapshotMaxChars: 500,
      maxInteractiveItems: 3,
    }
    expect(resolveConfig(explicit)).toEqual(explicit)
  })
})

describe('apply', () => {
  // `apply` mirrors the extension into the dsh home at startup; point that home
  // at a temp directory so a test run never rewrites the user's real mirror.
  let home: string | undefined
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-bridge-home-'))
    dirs.push(home)
    vi.stubEnv('DSH_HOME', home)
  })

  it('registers the bridge with a fixed token (no generation)', async () => {
    const { ctx, registered } = stubContext()
    await apply(ctx, { token: 'fixed-token', ...VALID })
    // The two host tools must be on the table from startup, whatever the
    // connection state: a tool the model can only reach after a hello cannot
    // explain why the hello never arrived.
    expect(registered).toContain('browser_status')
    expect(registered).toContain('browser_setup')
  })

  it('registers the bindings route the dsh Web GUI polls', async () => {
    const { ctx, routes } = stubContext()
    await apply(ctx, { token: 'fixed-token', ...VALID })

    const route = routes.find((candidate) => candidate.path === BRIDGE_BINDINGS_PATH)
    expect(route).toBeDefined()
    // Exact, not a prefix: the GUI polls this one path, and a prefix route
    // would answer for children this plugin never meant to serve.
    expect(route!.kind).toBe('exact')
  })

  it('answers the bindings route GET-only, with an empty table before any hello', async () => {
    const { ctx, routes } = stubContext()
    await apply(ctx, { token: 'fixed-token', ...VALID })
    const route = routes.find((candidate) => candidate.path === BRIDGE_BINDINGS_PATH)!

    const refused = callRoute(route, 'POST')
    expect(refused.status).toBe(405)
    expect(refused.headers['allow']).toBe('GET')
    expect(refused.json).toEqual({ ok: false, code: 'method-not-allowed', message: 'GET only' })

    // No extension: the response still names every field, so the GUI can tell
    // "not connected" apart from a failed request.
    const idle = callRoute(route, 'GET')
    expect(idle.status).toBe(200)
    expect(idle.json).toEqual({
      ok: true,
      connected: false,
      supported: false,
      revision: null,
      bindings: [],
    })
    expect(idle.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(idle.headers['cache-control']).toBe('no-store')
  })

  it('refuses a bindings request that did not come from loopback', async () => {
    const { ctx, routes } = stubContext()
    await apply(ctx, { token: 'fixed-token', ...VALID })
    const route = routes.find((candidate) => candidate.path === BRIDGE_BINDINGS_PATH)!

    const remote = callRoute(route, 'GET', { remoteAddress: '10.0.0.5' })
    expect(remote.status).toBe(403)
    expect(remote.json).toEqual({ ok: false, code: 'forbidden', message: 'loopback only' })

    // A loopback peer with a foreign Host is the DNS-rebinding shape: the
    // socket reaches this server, but the page believes it is another origin.
    const rebound = callRoute(route, 'GET', { host: 'evil.example' })
    expect(rebound.status).toBe(403)
  })

  it('goes through the connection trust fence when the service offers one', async () => {
    const seen: Record<string, unknown>[] = []
    const { ctx, routes } = stubContext((headers) => {
      seen.push(headers)
      return 'sec-fetch-site' in headers ? 403 : undefined
    })
    await apply(ctx, { token: 'fixed-token', ...VALID })
    const route = routes.find((candidate) => candidate.path === BRIDGE_BINDINGS_PATH)!

    // The fence, not the loopback fallback, decides: a loopback request with a
    // cookie-less cross-site marker is refused even though the socket is local.
    const refused = callRoute(route, 'GET', { headers: { host: 'localhost', 'sec-fetch-site': 'cross-site' } })
    expect(refused.status).toBe(403)
    expect(refused.json).toEqual({ ok: false, code: 'forbidden', message: 'request refused by the host trust fence' })
    expect(seen).toHaveLength(1)

    const allowed = callRoute(route, 'GET', { headers: { host: 'localhost', cookie: 'dsh_token=x' } })
    expect(allowed.status).toBe(200)
    expect(seen).toHaveLength(2)
  })

  it('generates and persists a token when none is configured', async () => {
    const ownHome = await mkdtemp(join(tmpdir(), 'dsh-bridge-home-'))
    dirs.push(ownHome)
    vi.stubEnv('DSH_HOME', ownHome)
    const { ctx } = stubContext()
    await apply(ctx, VALID)
  })

  it('rejects invalid budgets loudly', async () => {
    await expect(apply(stubContext().ctx, { ...VALID, toolTimeoutMs: 0 })).rejects.toThrow(/toolTimeoutMs/)
    await expect(apply(stubContext().ctx, { ...VALID, snapshotMaxChars: -1 })).rejects.toThrow(/snapshotMaxChars/)
    await expect(apply(stubContext().ctx, { ...VALID, snapshotMaxChars: 499 })).rejects.toThrow(/at least 500/)
  })
})

interface RouteAnswer {
  status: number
  headers: Record<string, string>
  json: unknown
}

/**
 * Invoke one registered web route with the request its no-connection fallback
 * expects: a loopback peer and a loopback `Host`.
 *
 * The stub context's `connection` service has no trust fence, so the bindings
 * route takes that fallback path here — the same one a composition without the
 * connection service runs in.
 */
function callRoute(
  route: WebRoute,
  method: string,
  options: { remoteAddress?: string; host?: string; headers?: Record<string, string> } = {},
): RouteAnswer {
  let status = 0
  let headers: Record<string, string> = {}
  let body = ''
  const res = {
    writeHead: (nextStatus: number, nextHeaders: Record<string, string>) => {
      status = nextStatus
      headers = nextHeaders
      return res
    },
    end: (chunk?: string) => { body = chunk ?? '' },
  }
  const req = {
    method,
    headers: options.headers ?? { host: options.host ?? 'localhost' },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  }
  void route.handler(req as never, res as never)
  return { status, headers, json: JSON.parse(body) as unknown }
}
