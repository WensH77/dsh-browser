/**
 * Copy the repository's shipped skill bundles into this plugin package.
 *
 * The plugin registers the bridge guide itself as a bundled skill, so the
 * SKILL.md has to travel inside the package: `package.json` lists `assets` in
 * `files`, and the runtime reads it through `packagedAssetRoot()` in
 * `src/index.ts`. Two distribution paths then ship the same file — the
 * repository installer links `.dsh/skills/<name>` into the user skill root, and
 * this copy is the package's own fallback — so this step copies rather than
 * hand-maintains a second source: `.dsh/skills/<name>/SKILL.md` is the only
 * place the text lives.
 *
 * The copy is a mirror, not an overlay: a skill removed from `.dsh/skills` must
 * disappear from the package too, or a retired guide keeps being registered.
 *
 * A missing source directory is fatal, unlike the extension copy: the extension
 * has a legitimate "never built here" state, while a checkout that cannot see
 * its own committed skills directory has a broken repository.
 */

import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const source = resolve(packageRoot, '..', '..', '..', '.dsh', 'skills')
const target = join(packageRoot, 'assets')
const pluginName = 'bridge-browser'

async function main() {
  if (!existsSync(source)) {
    throw new Error(`[copy-skills] no skills source at ${source}`)
  }
  // Replace rather than merge, for the same reason the extension copy does:
  // `cp` has no delete mode and a leftover directory would be registered.
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  let copied = 0
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillFile = join(source, entry.name, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    await cp(join(source, entry.name), join(target, entry.name), { recursive: true })
    copied += 1
  }
  if (copied === 0) throw new Error(`[copy-skills] no skill bundles under ${source}`)
  // The plugin registers one guide by a hard-coded name; a rename in the
  // repository would leave it reading a directory that is no longer there, and
  // that failure would only show up at runtime.
  const guide = join(target, 'dsh-browser-bridge-guide', 'SKILL.md')
  if (!existsSync(guide)) {
    throw new Error(`[copy-skills] ${source} has no dsh-browser-bridge-guide/SKILL.md, which ${pluginName} registers`)
  }
  console.log(`[copy-skills] ${copied} skill bundle(s) → ${target}`)
}

await main()
