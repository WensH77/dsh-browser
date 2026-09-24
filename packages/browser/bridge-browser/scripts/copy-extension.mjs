/**
 * Copy the built Chrome extension into this plugin package.
 *
 * The plugin is distributed as one package, so the extension assets have to
 * travel inside it: `package.json` lists `extension` in `files`, and the
 * runtime then finds them through `bundledExtensionDir()` in
 * `src/extension-assets.ts`. The copy is a mirror, not an overlay — a file
 * deleted from the extension build must disappear from the package too, or a
 * stale script keeps running in Chrome and the two halves drift apart again.
 *
 * A missing `extensions/dsh-browser/dist` is reported loudly but is not fatal:
 * the root build and both installers build the extension before this package, so
 * a missing dist means the extension was never built here — a failing build
 * would be a worse outcome than a warning that names the fix.
 */

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const source = resolve(packageRoot, '..', '..', '..', 'extensions', 'dsh-browser', 'dist')
const target = join(packageRoot, 'extension')

/** Files below a directory, relative and posix-separated. */
async function listFiles(root, prefix = '') {
  const found = []
  for (const dirent of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`
    if (dirent.isDirectory()) found.push(...(await listFiles(root, rel)))
    else found.push(rel)
  }
  return found
}

async function main() {
  try {
    await stat(join(source, 'manifest.json'))
  } catch {
    console.warn(
      `[copy-extension] no extension build at ${source} — skipping.\n` +
        `[copy-extension] run: pnpm --filter dsh-browser-extension run build`,
    )
    return
  }
  // Replace rather than merge: `cp` has no delete mode, and leftovers from an
  // older build are exactly the stale-file problem this step exists to avoid.
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await cp(source, target, { recursive: true })
  const files = await listFiles(target)
  console.log(`[copy-extension] ${files.length} file(s) → ${target}`)
}

await main()
