import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bundledExtensionDir,
  installedExtensionDir,
  syncBundledExtension,
} from '../src/extension-assets.ts'

/** `mkfifo` is not on every machine (never on Windows), so that one test skips. */
const mkfifoAvailable = spawnSync('mkfifo', [], { stdio: 'ignore' }).error === undefined
const fifoIt = mkfifoAvailable ? it : it.skip

/** Every temporary root this file made, removed once the file is done. */
const roots: string[] = []
/** Per-test harness home, so no test can reach the real `~/.dsh`. */
let dshHome = ''

const originalDshHome = process.env.DSH_HOME

async function tempRoot(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-ext-${label}-`))
  roots.push(dir)
  return dir
}

beforeEach(async () => {
  dshHome = await tempRoot('home')
  process.env.DSH_HOME = dshHome
})

afterAll(async () => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

/** Write a set of relative paths into a root, creating parents. */
async function writeTree(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, ...rel.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}

const MANIFEST = '{"manifest_version":3,"version":"0.1.2"}\n'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A built extension with a nested asset directory. */
async function makeSource(): Promise<string> {
  const source = await tempRoot('source')
  await writeTree(source, {
    'manifest.json': MANIFEST,
    'background.js': 'console.log("bg")\n',
    'assets/icon.png': PNG,
    'assets/nested/deep.js': 'deep\n',
  })
  return source
}

/** Relative posix path → mtime in ms, for "did anything get written" checks. */
async function mtimes(root: string, prefix = ''): Promise<Map<string, number>> {
  const found = new Map<string, number>()
  const dir = prefix === '' ? root : join(root, ...prefix.split('/'))
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`
    const full = join(dir, dirent.name)
    if (dirent.isDirectory()) for (const [k, v] of await mtimes(root, rel)) found.set(k, v)
    else found.set(rel, (await stat(full)).mtimeMs)
  }
  return found
}

describe('bundledExtensionDir', () => {
  /**
   * A layout shaped like this repository's own checkout: the extension package
   * (the marker), its build output, and the plugin package.
   */
  async function fakeCheckout(
    options: { dist?: boolean; packaged?: boolean } = {},
  ): Promise<string> {
    const repo = await tempRoot('checkout')
    const packageRoot = join(repo, 'packages', 'browser', 'bridge-browser')
    await mkdir(packageRoot, { recursive: true })
    await writeTree(join(repo, 'extensions', 'dsh-browser'), {
      'package.json': '{"name":"dsh-browser-extension"}\n',
    })
    if (options.dist !== false) {
      await writeTree(join(repo, 'extensions', 'dsh-browser', 'dist'), { 'manifest.json': MANIFEST })
    }
    if (options.packaged === true) {
      await writeTree(join(packageRoot, 'extension'), { 'manifest.json': MANIFEST })
    }
    return packageRoot
  }

  /** The development build path a checkout's package root implies. */
  function developmentDist(packageRoot: string): string {
    return resolve(packageRoot, '..', '..', '..', 'extensions', 'dsh-browser', 'dist')
  }

  it('uses the development dist for a link-installed checkout', async () => {
    const packageRoot = await fakeCheckout()
    expect(bundledExtensionDir(packageRoot)).toBe(developmentDist(packageRoot))
  })

  it('prefers the development dist over the packaged copy inside a checkout', async () => {
    // The packaged copy is a snapshot of a build; the dist is what a build just
    // wrote. Letting the snapshot win would sync stale files into Chrome.
    const packageRoot = await fakeCheckout({ packaged: true })
    expect(bundledExtensionDir(packageRoot)).toBe(developmentDist(packageRoot))
  })

  it('falls back to the packaged copy when a checkout has no built dist', async () => {
    const packageRoot = await fakeCheckout({ dist: false, packaged: true })
    expect(bundledExtensionDir(packageRoot)).toBe(join(packageRoot, 'extension'))
  })

  it('uses only the packaged copy outside a checkout', async () => {
    // An installed package has no development tree to trust, even if some
    // unrelated `extensions/dsh-browser/dist` happens to sit three levels up.
    const repo = await tempRoot('installed')
    const packageRoot = join(repo, 'node_modules', 'dsh-bridge-browser')
    await mkdir(packageRoot, { recursive: true })
    await writeTree(join(packageRoot, 'extension'), { 'manifest.json': MANIFEST })
    await writeTree(join(repo, 'extensions', 'dsh-browser', 'dist'), { 'manifest.json': MANIFEST })
    expect(bundledExtensionDir(packageRoot)).toBe(join(packageRoot, 'extension'))
  })

  it('ignores a directory that has no manifest.json', async () => {
    const packageRoot = await fakeCheckout()
    await writeTree(join(packageRoot, 'extension'), { 'background.js': 'x\n' })
    expect(bundledExtensionDir(packageRoot)).toBe(developmentDist(packageRoot))
  })

  it('ignores a development dist without a manifest.json', async () => {
    const packageRoot = await fakeCheckout({ dist: false, packaged: true })
    await writeTree(developmentDist(packageRoot), { 'background.js': 'x\n' })
    expect(bundledExtensionDir(packageRoot)).toBe(join(packageRoot, 'extension'))
  })

  it('returns undefined when neither candidate is an extension', async () => {
    const packageRoot = join(await tempRoot('empty'), 'packages', 'browser', 'bridge-browser')
    await mkdir(packageRoot, { recursive: true })
    expect(bundledExtensionDir(packageRoot)).toBeUndefined()
  })
})

describe('installedExtensionDir', () => {
  it('resolves under the harness home, not the real ~/.dsh', () => {
    expect(installedExtensionDir()).toBe(join(dshHome, 'browser-extension'))
  })
})

describe('syncBundledExtension', () => {
  it('mirrors the source byte for byte the first time', async () => {
    const source = await makeSource()
    const target = join(await tempRoot('target'), 'browser-extension')

    const result = await syncBundledExtension(target, source)

    expect(result).toMatchObject({ status: 'synced', target, source, files: 4 })
    expect(await readFile(join(target, 'manifest.json'), 'utf8')).toBe(MANIFEST)
    expect(await readFile(join(target, 'background.js'), 'utf8')).toBe('console.log("bg")\n')
    expect(await readFile(join(target, 'assets', 'nested', 'deep.js'), 'utf8')).toBe('deep\n')
    expect(new Uint8Array(await readFile(join(target, 'assets', 'icon.png')))).toEqual(PNG)
  })

  it('reports up-to-date and writes nothing when the trees already agree', async () => {
    const source = await makeSource()
    const target = join(await tempRoot('target'), 'browser-extension')
    await syncBundledExtension(target, source)
    // Backdate every file: if the second pass rewrote anything, the mtime moves.
    const past = new Date('2020-01-02T03:04:05Z')
    for (const rel of ['manifest.json', 'background.js', 'assets/icon.png', 'assets/nested/deep.js']) {
      await utimes(join(target, ...rel.split('/')), past, past)
    }
    const before = await mtimes(target)

    const result = await syncBundledExtension(target, source)

    expect(result).toMatchObject({ status: 'up-to-date', target, source, files: 4 })
    expect(await mtimes(target)).toEqual(before)
  })

  it('stays up-to-date when the mirror only carries install-info.json on top', async () => {
    const source = await makeSource()
    const target = join(await tempRoot('target'), 'browser-extension')
    await syncBundledExtension(target, source)
    const info = '{\n  "schemaVersion": 1,\n  "mode": "checkout"\n}\n'
    await writeFile(join(target, 'install-info.json'), info)
    const before = await mtimes(target)

    const result = await syncBundledExtension(target, source)

    expect(result.status).toBe('up-to-date')
    expect(await mtimes(target)).toEqual(before)
  })

  it('deletes a file the source no longer has', async () => {
    const source = await makeSource()
    const target = join(await tempRoot('target'), 'browser-extension')
    await syncBundledExtension(target, source)
    await rm(join(source, 'assets', 'nested', 'deep.js'))

    const result = await syncBundledExtension(target, source)

    expect(result).toMatchObject({ status: 'synced', files: 3 })
    expect(existsSync(join(target, 'assets', 'nested', 'deep.js'))).toBe(false)
    expect(await readFile(join(target, 'assets', 'icon.png'))).toEqual(await readFile(join(source, 'assets', 'icon.png')))
  })

  it('deletes a whole directory the source dropped', async () => {
    const source = await makeSource()
    const target = join(await tempRoot('target'), 'browser-extension')
    await syncBundledExtension(target, source)
    await rm(join(source, 'assets', 'nested'), { recursive: true })

    const result = await syncBundledExtension(target, source)

    expect(result.status).toBe('synced')
    expect(existsSync(join(target, 'assets', 'nested'))).toBe(false)
    expect(existsSync(join(target, 'assets', 'icon.png'))).toBe(true)
  })

  it('deletes a stale file the source never had', async () => {
    const source = await makeSource()
    const target = join(await tempRoot('target'), 'browser-extension')
    await syncBundledExtension(target, source)
    await writeFile(join(target, 'leftover.js'), 'stale\n')

    const result = await syncBundledExtension(target, source)

    expect(result.status).toBe('synced')
    expect(existsSync(join(target, 'leftover.js'))).toBe(false)
  })

  it('keeps install-info.json through a real change', async () => {
    const source = await makeSource()
    const target = join(await tempRoot('target'), 'browser-extension')
    await syncBundledExtension(target, source)
    const info = '{\n  "schemaVersion": 1,\n  "mode": "managed"\n}\n'
    await writeFile(join(target, 'install-info.json'), info)
    await rm(join(source, 'background.js'))

    const result = await syncBundledExtension(target, source)

    expect(result).toMatchObject({ status: 'synced', files: 3 })
    expect(await readFile(join(target, 'install-info.json'), 'utf8')).toBe(info)
    expect(existsSync(join(target, 'background.js'))).toBe(false)
  })

  it('sees a one-byte content change even with the mtime restored', async () => {
    const source = await makeSource()
    const target = join(await tempRoot('target'), 'browser-extension')
    await syncBundledExtension(target, source)
    const file = join(source, 'background.js')
    const stamp = (await stat(file)).mtime
    await writeFile(file, 'console.log("bg")\n'.replace('bg', 'b2'))
    await utimes(file, stamp, stamp)

    const result = await syncBundledExtension(target, source)

    expect(result.status).toBe('synced')
    expect(await readFile(join(target, 'background.js'), 'utf8')).toBe('console.log("b2")\n')
  })

  it('reports unavailable for a source that does not exist, without throwing', async () => {
    const target = join(await tempRoot('target'), 'browser-extension')
    const missing = join(await tempRoot('missing'), 'dist')

    const result = await syncBundledExtension(target, missing)

    expect(result.status).toBe('unavailable')
    expect(result.reason).toBeTruthy()
    expect(result.files).toBe(0)
    expect(existsSync(target)).toBe(false)
  })

  it('reports unavailable for a directory without a manifest.json', async () => {
    const source = await tempRoot('source')
    await writeTree(source, { 'background.js': 'x\n' })
    const target = join(await tempRoot('target'), 'browser-extension')

    const result = await syncBundledExtension(target, source)

    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('manifest.json')
  })

  it('defaults the mirror to the harness home', async () => {
    const missing = join(await tempRoot('missing'), 'dist')

    const result = await syncBundledExtension(undefined, missing)

    expect(result.target).toBe(join(dshHome, 'browser-extension'))
    expect(result.status).toBe('unavailable')
  })

  it('reports failed instead of throwing when the mirror path is not a directory', async () => {
    const source = await makeSource()
    const target = join(await tempRoot('target'), 'browser-extension')
    await writeFile(target, 'this is a file, not a directory\n')

    const result = await syncBundledExtension(target, source)

    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/not a directory|ENOTDIR/i)
    expect(await readFile(target, 'utf8')).toBe('this is a file, not a directory\n')
  })

  it('replaces a mirror file that the new build has as a directory', async () => {
    // A path that changed type cannot be written over: the old entry has to go
    // first, or every retry fails the same way and the mirror never converges.
    const source = await tempRoot('source')
    await writeTree(source, { 'manifest.json': MANIFEST, 'assets/icons/i.png': 'png\n' })
    const target = join(await tempRoot('target'), 'browser-extension')
    await writeTree(target, { 'manifest.json': MANIFEST, 'assets': 'stale file where a directory goes\n' })

    const first = await syncBundledExtension(target, source)
    const second = await syncBundledExtension(target, source)

    expect(first.status).toBe('synced')
    expect(second.status).toBe('up-to-date')
    expect((await stat(join(target, 'assets'))).isDirectory()).toBe(true)
    expect(await readFile(join(target, 'assets', 'icons', 'i.png'), 'utf8')).toBe('png\n')
  })

  it('replaces a mirror directory that the new build has as a file', async () => {
    const source = await tempRoot('source')
    await writeTree(source, { 'manifest.json': MANIFEST, 'assets': 'now a file\n' })
    const target = join(await tempRoot('target'), 'browser-extension')
    await writeTree(target, { 'manifest.json': MANIFEST, 'assets/icons/i.png': 'png\n' })

    const first = await syncBundledExtension(target, source)
    const second = await syncBundledExtension(target, source)

    expect(first.status).toBe('synced')
    expect(second.status).toBe('up-to-date')
    expect((await stat(join(target, 'assets'))).isFile()).toBe(true)
    expect(await readFile(join(target, 'assets'), 'utf8')).toBe('now a file\n')
    expect(existsSync(join(target, 'assets', 'icons'))).toBe(false)
  })

  it('mirrors an empty source directory and then converges', async () => {
    const source = await tempRoot('source')
    await writeTree(source, { 'manifest.json': MANIFEST, '_locales/en/messages.json': '{}\n' })
    await rm(join(source, '_locales', 'en', 'messages.json'))
    const target = join(await tempRoot('target'), 'browser-extension')

    const first = await syncBundledExtension(target, source)
    const second = await syncBundledExtension(target, source)

    expect(first.status).toBe('synced')
    expect((await stat(join(target, '_locales', 'en'))).isDirectory()).toBe(true)
    expect(second.status).toBe('up-to-date')
  })

  it('returns failed instead of rejecting when the default mirror path throws', async () => {
    // The startup call site is `void syncBundledExtension().then(...)`: a
    // rejection here would have no handler at all.
    vi.doMock('@deepseek-ai/dsh-home-paths', () => ({
      dshHomePath: () => {
        throw new Error('dsh home resolver exploded')
      },
    }))
    vi.resetModules()
    try {
      const fresh = await import('../src/extension-assets.ts')
      const result = await fresh.syncBundledExtension()
      expect(result.status).toBe('failed')
      expect(result.target).toBe('')
      expect(result.reason).toContain('dsh home resolver exploded')
    } finally {
      vi.doUnmock('@deepseek-ai/dsh-home-paths')
      vi.resetModules()
    }
  })

  it('replaces a symlinked mirror directory instead of writing through it', async () => {
    // The dangerous shape: a planted link where the new build wants a
    // directory. The write must land inside the mirror, never at the link's
    // target, and the mirror must end up with a real directory.
    const source = await tempRoot('source')
    await writeTree(source, { 'manifest.json': MANIFEST, 'assets/i.png': 'EXTENSION\n' })
    const outside = await tempRoot('outside')
    const target = join(await tempRoot('target'), 'browser-extension')
    await writeTree(target, { 'manifest.json': MANIFEST })
    await symlink(outside, join(target, 'assets'))

    const first = await syncBundledExtension(target, source)
    const second = await syncBundledExtension(target, source)

    expect(first.status).toBe('synced')
    expect(second.status).toBe('up-to-date')
    expect(await readdir(outside)).toEqual([])
    expect((await lstat(join(target, 'assets'))).isSymbolicLink()).toBe(false)
    expect((await lstat(join(target, 'assets'))).isDirectory()).toBe(true)
    expect(await readFile(join(target, 'assets', 'i.png'), 'utf8')).toBe('EXTENSION\n')
  })

  it('replaces a symlinked mirror file instead of overwriting what it points at', async () => {
    const outside = await tempRoot('outside')
    const victim = join(outside, 'victim.txt')
    await writeFile(victim, 'USER DATA THAT MUST NOT BE TOUCHED\n')
    const source = await tempRoot('source')
    await writeTree(source, { 'manifest.json': MANIFEST, 'bg.js': 'EXTENSION\n' })
    const target = join(await tempRoot('target'), 'browser-extension')
    await writeTree(target, { 'manifest.json': MANIFEST })
    await symlink(victim, join(target, 'bg.js'))

    const first = await syncBundledExtension(target, source)
    const second = await syncBundledExtension(target, source)

    expect(first.status).toBe('synced')
    expect(second.status).toBe('up-to-date')
    expect(await readFile(victim, 'utf8')).toBe('USER DATA THAT MUST NOT BE TOUCHED\n')
    expect((await lstat(join(target, 'bg.js'))).isSymbolicLink()).toBe(false)
    expect(await readFile(join(target, 'bg.js'), 'utf8')).toBe('EXTENSION\n')
  })

  it('removes a mirror symlink even when the source never mentions that name', async () => {
    // The link is not in the mirror's hash, so without treating it as a reason
    // to sync, it would survive every call and the mirror would never converge.
    const source = await tempRoot('source')
    await writeTree(source, { 'manifest.json': MANIFEST })
    const outside = await tempRoot('outside')
    const target = join(await tempRoot('target'), 'browser-extension')
    await writeTree(target, { 'manifest.json': MANIFEST })
    await symlink(outside, join(target, 'stray'))

    const first = await syncBundledExtension(target, source)
    const second = await syncBundledExtension(target, source)

    expect(first.status).toBe('synced')
    expect(second.status).toBe('up-to-date')
    expect(existsSync(join(target, 'stray'))).toBe(false)
  })

  it('skips a non-regular source entry and names it in the result', async () => {
    const outside = await tempRoot('outside')
    const secret = join(outside, 'secret.txt')
    await writeFile(secret, 'not part of the extension\n')
    const source = await tempRoot('source')
    await writeTree(source, { 'manifest.json': MANIFEST })
    await symlink(secret, join(source, 'sneaky.js'))
    const target = join(await tempRoot('target'), 'browser-extension')

    const result = await syncBundledExtension(target, source)

    expect(result.status).toBe('synced')
    expect(result.reason).toContain('sneaky.js')
    expect(existsSync(join(target, 'sneaky.js'))).toBe(false)
    expect(await readFile(secret, 'utf8')).toBe('not part of the extension\n')
  })

  fifoIt(
    'removes a FIFO in the mirror instead of blocking on it',
    async () => {
      const source = await tempRoot('source')
      await writeTree(source, { 'manifest.json': MANIFEST, 'bg.js': 'EXTENSION\n' })
      const target = join(await tempRoot('target'), 'browser-extension')
      await writeTree(target, { 'manifest.json': MANIFEST })
      const fifo = join(target, 'bg.js')
      spawnSync('mkfifo', [fifo])
      expect((await lstat(fifo)).isFIFO()).toBe(true)

      // A regression here does not fail, it hangs: bound the wait so the suite
      // reports it instead of stalling.
      let timer: ReturnType<typeof setTimeout> | undefined
      const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('copyFile blocked on the FIFO')), 4000)
      })
      const first = await Promise.race([syncBundledExtension(target, source), guard])
      clearTimeout(timer)

      expect(first.status).toBe('synced')
      expect((await lstat(fifo)).isFIFO()).toBe(false)
      expect(await readFile(fifo, 'utf8')).toBe('EXTENSION\n')
      expect((await syncBundledExtension(target, source)).status).toBe('up-to-date')
    },
    15000,
  )

  it('reports up-to-date when the only special mirror entry is install-info.json', async () => {
    // The protected metadata is not mirror content: skipping it in the deletion
    // pass and excluding it from the hash must also mean it is not "dirt", or
    // the early return is unreachable and every call claims a fresh refresh.
    const outside = await tempRoot('outside')
    const info = join(outside, 'info.json')
    await writeFile(info, '{"schemaVersion":1,"mode":"checkout"}\n')
    const source = await tempRoot('source')
    await writeTree(source, { 'manifest.json': MANIFEST })
    const target = join(await tempRoot('target'), 'browser-extension')
    await writeTree(target, { 'manifest.json': MANIFEST })
    await symlink(info, join(target, 'install-info.json'))

    const result = await syncBundledExtension(target, source)

    expect(result.status).toBe('up-to-date')
    expect((await lstat(join(target, 'install-info.json'))).isSymbolicLink()).toBe(true)
    expect(await readFile(info, 'utf8')).toBe('{"schemaVersion":1,"mode":"checkout"}\n')
  })

  it('does not keep reporting synced when install-info.json is a symlink', async () => {
    const outside = await tempRoot('outside')
    const info = join(outside, 'info.json')
    await writeFile(info, '{"schemaVersion":1,"mode":"checkout"}\n')
    const source = await tempRoot('source')
    await writeTree(source, { 'manifest.json': MANIFEST, 'bg.js': 'REAL\n' })
    const target = join(await tempRoot('target'), 'browser-extension')
    await writeTree(target, { 'manifest.json': MANIFEST, 'bg.js': 'REAL\n' })
    await symlink(info, join(target, 'install-info.json'))
    // Give the first pass real work, so "synced" is honest for that one call.
    await writeTree(source, { 'extra.js': 'new\n' })

    const first = await syncBundledExtension(target, source)
    const second = await syncBundledExtension(target, source)
    const third = await syncBundledExtension(target, source)

    expect([first.status, second.status, third.status]).toEqual(['synced', 'up-to-date', 'up-to-date'])
    expect((await lstat(join(target, 'install-info.json'))).isSymbolicLink()).toBe(true)
    expect(existsSync(join(target, 'extra.js'))).toBe(true)
  })

  it('still reports synced for a special mirror entry that is not install-info.json', async () => {
    // Control for the exception above: only that one name is exempt.
    const outside = await tempRoot('outside')
    const info = join(outside, 'info.json')
    await writeFile(info, '{"schemaVersion":1,"mode":"checkout"}\n')
    const source = await tempRoot('source')
    await writeTree(source, { 'manifest.json': MANIFEST })
    const target = join(await tempRoot('target'), 'browser-extension')
    await writeTree(target, { 'manifest.json': MANIFEST })
    await symlink(info, join(target, 'install-info.json'))
    await symlink(outside, join(target, 'stray'))

    const first = await syncBundledExtension(target, source)
    const second = await syncBundledExtension(target, source)

    expect(first.status).toBe('synced')
    expect(second.status).toBe('up-to-date')
    expect(existsSync(join(target, 'stray'))).toBe(false)
    expect((await lstat(join(target, 'install-info.json'))).isSymbolicLink()).toBe(true)
  })
})
