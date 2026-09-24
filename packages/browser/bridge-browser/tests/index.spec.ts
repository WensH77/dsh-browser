import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, assertPositiveInteger, Config, resolveConfig } from '../src/index.ts'

/** Minimal context stub: apply only needs the services at registration time. */
function stubContext(): { ctx: Context; registered: string[] } {
  const registered: string[] = []
  const gateway = {
    wireStream: {
      open: async (): Promise<AsyncIterable<unknown>> => ({ async *[Symbol.asyncIterator]() {} }),
      failure: (error: unknown) => ({ code: 'internal', message: String(error), details: {} }),
    },
    invoke: async () => undefined,
  }
  const connection = {
    createSharedFetchHandler: () => ({ fetch: async () => new Response('not found', { status: 404 }) }),
  }
  const ctx = {
    webServer: { port: 0, registerUpgrade: () => () => {}, register: () => () => {} },
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
  return { ctx, registered }
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
