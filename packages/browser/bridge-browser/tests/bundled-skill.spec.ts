/**
 * The plugin's own half of the skill distribution: `apply()` registers the
 * bundled bridge guide with whichever skills registry is mounted, so a session
 * in a composition that never ran `scripts/install-skills.mjs` still has the
 * tool-selection recipe the system prompt points at.
 *
 * These cases use the real `@deepseek-ai/dsh-skill` registry rather than a stub,
 * because the properties worth pinning are the registry's: that the skill is
 * addressable by the name the prompt names, that its summary carries the
 * description the catalog advertises, and that two same-name registrations do
 * not become two entries.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import * as BridgeBrowser from '../src/index.ts'

const PACKAGE_ROOT = resolve(import.meta.dirname, '..')
const GUIDE_NAME = 'dsh-browser-bridge-guide'
const BUNDLED_GUIDE = join(PACKAGE_ROOT, 'assets', GUIDE_NAME, 'SKILL.md')
/** The repository copy the build mirrors into `assets/`; the only source of the text. */
const REPO_GUIDE = resolve(PACKAGE_ROOT, '..', '..', '..', '.dsh', 'skills', GUIDE_NAME, 'SKILL.md')

// The package copy is a build output (`scripts/copy-skills.mjs`, part of `build`),
// so a checkout that edited `.dsh/skills` without rebuilding would leave it stale
// and fail here for the wrong reason. Refresh it before the cases are collected.
// `skipIf` reads the directory at collection time too, so this cannot move into a
// hook: a missing `assets/` would skip the very cases that would report it.
{
  const result = spawnSync(process.execPath, [join(PACKAGE_ROOT, 'scripts', 'copy-skills.mjs')], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`copy-skills failed: ${result.stderr || result.stdout}`)
}

let tempRoot = join(tmpdir(), 'dsh-bridge-skill-never-used')
const tempRoots: string[] = []
/** Restored after every case: `apply` writes its token into `DSH_HOME`. */
const previousDshHome = process.env.DSH_HOME

afterEach(async () => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A private DSH home plus the services `apply()` requires, on a root context. */
async function bootPlugin(): Promise<{ ctx: Context; registry: SkillRegistry }> {
  tempRoot = join(tmpdir(), `dsh-bridge-skill-${String(process.pid)}-${String(tempRoots.length)}`)
  mkdirSync(tempRoot, { recursive: true })
  tempRoots.push(tempRoot)
  process.env.DSH_HOME = tempRoot

  const ctx = new Context()
  // Constructing the service provides it on `ctx` itself (Service → provide).
  const registry = new SkillRegistry(ctx)
  ctx.provide('webServer', {
    port: 0,
    register: () => () => {},
    registerUpgrade: () => () => {},
  })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('userQuestions', { ask: async () => ({ answers: [] }) })
  await ctx.plugin(BridgeBrowser, {})
  // `apply` is async; its final effect registration settles on the next tick.
  await new Promise((resolvePromise) => { setImmediate(resolvePromise) })
  return { ctx, registry }
}

describe('the bundled guide skill', () => {
  it.skipIf(!readdirSync(PACKAGE_ROOT).includes('assets'))('is registered by name with its catalog description', async () => {
    const { ctx, registry } = await bootPlugin()

    const summaries = await registry.list({ cwd: PACKAGE_ROOT })
    const guide = summaries.find((summary) => summary.name === GUIDE_NAME)

    expect(guide).toBeDefined()
    expect(guide?.provider).toBe('dsh-browser-bridge')
    expect(guide?.source).toBe('bundled')
    // The description is the whole trigger surface: only this reaches the
    // catalog, so it has to be the repository file's own description verbatim.
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(readFileSync(REPO_GUIDE, 'utf8'))?.[1] ?? ''
    const description = /^description:[ \t]*(.+?)[ \t]*$/mu.exec(frontmatter)?.[1] ?? ''
    expect(guide?.description).toBe(description)
    expect(guide?.invocation).toEqual({ modelInvocable: true, userInvocable: true })

    await ctx.fiber.dispose()
  })

  it.skipIf(!readdirSync(PACKAGE_ROOT).includes('assets'))('loads a body that is the repository file without its frontmatter', async () => {
    const { ctx, registry } = await bootPlugin()

    const loaded = await registry.get(GUIDE_NAME, { cwd: PACKAGE_ROOT })

    expect(loaded?.content.startsWith('# dsh-browser 桥接的工具选择与故障排查')).toBe(true)
    expect(loaded?.content).not.toContain('name: dsh-browser-bridge-guide')
    // The build copies the file rather than keeping a second source, so the two
    // must stay byte-identical apart from the frontmatter split.
    expect(readFileSync(BUNDLED_GUIDE, 'utf8')).toBe(readFileSync(REPO_GUIDE, 'utf8'))

    await ctx.fiber.dispose()
  })

  it.skipIf(!readdirSync(PACKAGE_ROOT).includes('assets'))('keeps one catalog entry when the filesystem ships the same name', async () => {
    const { ctx, registry } = await bootPlugin()

    // The installer links the same skill into `<dshHome>/skills`, which a
    // filesystem provider reports at a lower rank. Same name, same layer: the
    // registry deduplicates instead of advertising the guide twice.
    registry.registerProvider(() => ({
      name: 'test:filesystem',
      list: () => Promise.resolve([{
        name: GUIDE_NAME,
        description: 'the installed copy',
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'test:filesystem',
        source: 'user-dsh',
        rank: 400,
        locator: 'installed',
      }]),
      get: async () => undefined,
    }))

    const summaries = (await registry.list({ cwd: PACKAGE_ROOT })).filter((summary) => summary.name === GUIDE_NAME)

    expect(summaries).toHaveLength(1)
    // Lower rank wins a duplicate name, so the user-root copy at 400 outranks
    // the packaged one at 600. That is the intended outcome, not a tie: a user
    // who edits or replaces the installed skill keeps their version, and the
    // installed copy is a link to the very same repository file the package
    // carries, so the two can never disagree about the text.
    expect(summaries[0]?.provider).toBe('test:filesystem')

    await ctx.fiber.dispose()
  })

  it.skipIf(!readdirSync(PACKAGE_ROOT).includes('assets'))('reports a missing asset instead of failing the plugin', async () => {
    const assets = join(PACKAGE_ROOT, 'assets')
    const moved = join(PACKAGE_ROOT, 'assets-moved-for-test')
    renameSync(assets, moved)
    try {
      const { ctx, registry } = await bootPlugin()

      // The bridge still boots and the guide is simply absent: losing advice
      // must never cost the bridge.
      expect((await registry.list({ cwd: PACKAGE_ROOT })).some((summary) => summary.name === GUIDE_NAME)).toBe(false)

      await ctx.fiber.dispose()
    } finally {
      renameSync(moved, assets)
    }
  })

  it('boots with no skills service at all', async () => {
    tempRoot = join(tmpdir(), `dsh-bridge-skill-noservice-${String(process.pid)}`)
    mkdirSync(tempRoot, { recursive: true })
    tempRoots.push(tempRoot)
    process.env.DSH_HOME = tempRoot

    const ctx = new Context()
    ctx.provide('webServer', { port: 0, register: () => () => {}, registerUpgrade: () => () => {} })
    ctx.provide('tools', { register: () => () => {} })
    ctx.provide('userQuestions', { ask: async () => ({ answers: [] }) })

    // No `skills` service mounted. A plugin that threw here would lose the whole
    // bridge over one optional informational feature.
    await expect(ctx.plugin(BridgeBrowser, {})).resolves.toBeDefined()
    expect(ctx.get('skills')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
