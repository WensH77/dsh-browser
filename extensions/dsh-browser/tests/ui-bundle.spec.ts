// @vitest-environment node
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const extensionRoot = new URL('..', import.meta.url)

async function readText(relativePath: string): Promise<string> {
  return await readFile(new URL(relativePath, extensionRoot), 'utf8')
}

describe('UI bundle contract', () => {
  // The panel and the options page are two HTML files and one build. When they
  // were two builds, each emitted its own copy of React: about 142 KB — half the
  // extension — for two pages whose own code is a few kilobytes each. This test
  // exists so that splitting them again is a deliberate act, not a refactor
  // someone makes without noticing.
  it('builds both React pages from one config with two HTML inputs', async () => {
    const config = await readText('vite.ui.config.ts')

    expect(config).toContain("panel: resolve(import.meta.dirname, 'panel/index.html')")
    expect(config).toContain("options: resolve(import.meta.dirname, 'options/index.html')")
    // Shared dependencies must land in one place both pages load.
    expect(config).toContain("chunkFileNames: 'assets/[name]-[hash].js'")
  })

  it('runs that one config instead of per-page builds', async () => {
    const build = await readText('scripts/build.mjs')

    expect(build).toContain("'vite.ui.config.ts'")
    expect(build).not.toContain('vite.panel.config.ts')
    expect(build).not.toContain('vite.options.config.ts')
  })

  it('still leaves one file per page entry, so the manifest paths hold', async () => {
    const config = await readText('vite.ui.config.ts')

    // `[name]` is the entry key (panel/options): each page keeps a file in its
    // own directory, which is what the manifest points at.
    expect(config).toContain("entryFileNames: '[name]/assets/[name].js'")
  })

  it('references only files that exist when a build is present', async () => {
    const dist = fileURLToPath(new URL('dist', extensionRoot))
    if (!existsSync(dist)) return // tests run without a build; `pnpm build` covers it

    for (const page of ['panel', 'options']) {
      const html = await readFile(`${dist}/${page}/index.html`, 'utf8')
      const referenced = [...html.matchAll(/(?:src|href)="\/([^"]+)"/g)].map((match) => match[1]!)
      expect(referenced.length, `${page}/index.html has references`).toBeGreaterThan(0)
      for (const file of referenced) {
        expect(existsSync(`${dist}/${file}`), `${page}/index.html -> ${file}`).toBe(true)
      }
    }

    // One shared chunk carries the framework for both pages.
    const shared = (await readdir(`${dist}/assets`)).filter((name) => name.endsWith('.js'))
    expect(shared.length, 'exactly one shared JS chunk').toBe(1)
  })
})
