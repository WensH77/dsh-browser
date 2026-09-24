/**
 * Extension assets: where the built Chrome extension lives, and the runtime
 * mirror of the directory Chrome actually loads.
 *
 * `scripts/install.sh` / `install.ps1` rsync `extensions/dsh-browser/dist` into
 * `~/.dsh/browser-extension` once, at install time, and Chrome keeps loading
 * that copy forever after — a rebuild never reaches it. That is half of the
 * "Connecting…" class of failure: the two halves run different builds. This
 * module lets the running plugin do the sync itself, so a rebuild plus one
 * `browser_setup` call is enough.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** A directory is only an extension when it carries a manifest. */
const MANIFEST_FILE = 'manifest.json'

/**
 * Install metadata written by `scripts/install.sh` / `install.ps1` into the
 * mirror. No source file can reproduce it — it records whether this checkout is
 * the `managed` or `checkout` install — so the mirror must never delete it.
 */
export const INSTALL_INFO_FILE = 'install-info.json'

/** Outcome of one mirror pass. */
export type SyncStatus = 'synced' | 'up-to-date' | 'unavailable' | 'failed'

/** What {@link syncBundledExtension} did, or why it could not. */
export interface SyncResult {
  status: SyncStatus
  /** The mirror directory Chrome loads. */
  target: string
  /** The directory the files came from; absent when nothing is bundled. */
  source?: string
  /** Files in the source manifest; 0 when nothing was mirrored. */
  files: number
  /**
   * Why the sync was unavailable or failed — or, on a successful sync, a note
   * that the source held entries this module refuses to mirror (symlinks,
   * FIFOs): those were skipped rather than copied.
   */
  reason?: string
}

/**
 * Absolute path of this package's root directory.
 *
 * Found by walking up to the nearest `package.json`, not by counting `..`:
 * this file runs from three depths — `src/` under vitest, `lib/types/` after
 * `tsc`, and `lib/index.js` after tsdown bundles the entry — and only the walk
 * is right at all three. Getting it wrong would silently disable the mirror,
 * because every candidate path would be resolved against the wrong root.
 *
 * @returns the package root.
 */
function packageRootDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  let dir = here
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return here
    dir = parent
  }
}

/**
 * Where a bundled extension may live, plus the marker that says this is the
 * repository's own checkout rather than an installed package.
 */
interface BundledCandidates {
  /** `<packageRoot>/extension` — the copy inside the published tarball. */
  packaged: string
  /** `<packageRoot>/../../../extensions/dsh-browser/dist` — a checkout's build. */
  development: string
  /** `<packageRoot>/../../../extensions/dsh-browser/package.json` — checkout marker. */
  checkoutMarker: string
}

/**
 * Resolve the three paths from a package root.
 *
 * @param packageRoot - the plugin package root.
 * @returns the packaged copy, the development dist, and the checkout marker.
 */
function bundledCandidates(packageRoot: string): BundledCandidates {
  // Three levels up from `packages/browser/bridge-browser` is the repo root.
  const repository = resolve(packageRoot, '..', '..', '..')
  const extensionPackage = join(repository, 'extensions', 'dsh-browser')
  return {
    packaged: join(packageRoot, 'extension'),
    development: join(extensionPackage, 'dist'),
    checkoutMarker: join(extensionPackage, 'package.json'),
  }
}

/** Whether a directory exists and carries an extension manifest. */
function isExtensionDir(dir: string): boolean {
  return existsSync(join(dir, MANIFEST_FILE))
}

/**
 * The extension build to mirror from, if any.
 *
 * Inside this repository's checkout the development `dist/` wins, because a
 * build writes it directly while `extension/` is only a packaging copy of it
 * and can be a whole build behind — letting the copy shadow the real output
 * would move the silent-staleness problem rather than remove it. The checkout
 * is identified by the extension package's own `package.json`; outside one
 * there is no trustworthy "just built" directory, so only the packaged copy
 * counts. Mtimes are deliberately not consulted: they differ between machines
 * and archives and would make the choice unreproducible.
 *
 * Nothing is created here: a missing directory means "no bundled extension",
 * not an error.
 *
 * @param packageRoot - the plugin package root; injectable for tests.
 * @returns the directory, or undefined when neither candidate is an extension.
 */
export function bundledExtensionDir(packageRoot: string = packageRootDir()): string | undefined {
  const candidates = bundledCandidates(packageRoot)
  if (existsSync(candidates.checkoutMarker) && isExtensionDir(candidates.development)) {
    return candidates.development
  }
  if (isExtensionDir(candidates.packaged)) return candidates.packaged
  return undefined
}

/**
 * The mirror directory the user points Chrome's "Load unpacked" at.
 *
 * @returns the absolute path, usually `~/.dsh/browser-extension`.
 */
export function installedExtensionDir(): string {
  return dshHomePath('browser-extension')
}

/** One directory tree's identity, as a hash plus the entries behind it. */
interface TreeManifest {
  /** sha256 over the sorted `kind path digest` lines. */
  hash: string
  /** Relative posix path (top-level `install-info.json` excluded) → content sha256. */
  files: Map<string, string>
  /** Relative posix paths of subdirectories. */
  dirs: Set<string>
  /**
   * Symlinks, FIFOs, sockets and devices — entries that are neither a regular
   * file nor a directory. They are deliberately left out of the hash (the
   * source side never contributes them to the mirror, so hashing them would
   * make a source-side symlink prevent convergence forever), and a mirror that
   * holds any of them is never reported up-to-date, because they have to be
   * removed before anything is written.
   */
  others: Set<string>
}

/**
 * Hash every file below one directory.
 *
 * Content, not timestamps: a rebuild that touches mtimes without changing bytes
 * must not rewrite the mirror, and a one-byte edit with a restored mtime must
 * still be seen.
 *
 * @param root - directory to walk.
 * @param skip - relative paths to leave out of the hash (they stay in the maps).
 * @returns the tree's manifest.
 */
async function readManifest(root: string, skip: (rel: string) => boolean): Promise<TreeManifest> {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const others = new Set<string>()
  await collect(root, '', files, dirs, others)
  const hash = createHash('sha256')
  const filePaths = [...files.keys()].filter((rel) => !skip(rel)).sort()
  for (const rel of filePaths) hash.update(`f ${rel} ${files.get(rel)}\n`)
  const dirPaths = [...dirs].filter((rel) => !skip(rel)).sort()
  for (const rel of dirPaths) hash.update(`d ${rel}\n`)
  return { hash: hash.digest('hex'), files, dirs, others }
}

/** Recursive half of {@link readManifest}. */
async function collect(
  dir: string,
  prefix: string,
  files: Map<string, string>,
  dirs: Set<string>,
  others: Set<string>,
): Promise<void> {
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`
    const full = join(dir, dirent.name)
    if (dirent.isDirectory()) {
      dirs.add(rel)
      await collect(full, rel, files, dirs, others)
    } else if (dirent.isFile()) {
      files.set(rel, createHash('sha256').update(await readFile(full)).digest('hex'))
    } else {
      // Symlinks, FIFOs, sockets, devices. Never followed and never read: a
      // symlink can point outside the tree, and reading a FIFO would block this
      // process until something opens the other end.
      others.add(rel)
    }
  }
}

/** Absolute path of a relative posix path inside a tree. */
function at(root: string, rel: string): string {
  return join(root, ...rel.split('/'))
}

/**
 * Delete what the source no longer has, then copy what changed.
 *
 * Deletions run first because they are driven by the mirror manifest read
 * before any write. A path that changed type is exactly the case where that
 * matters: when the source has a directory where the mirror had a file, the
 * mirror's file is "not in the source" and removing it first is what lets the
 * directory be created at all; the reverse (mirror directory, source file) is
 * removed by the directory pass. Running this afterwards — the original order —
 * made both directions fail forever: the writes hit EISDIR/ENOTDIR, and by the
 * time the deletion pass ran, its manifest no longer described the disk, so the
 * conflicting entry was either missed or hit as the wrong type again.
 *
 * The cost of that order: a pass that fails halfway has already deleted, so the
 * mirror can be left missing files the previous build had until the next
 * successful call, which converges it completely. That was accepted as the
 * better trade — the alternative is the permanent failure above — because the
 * only consequence in between is an extension that Chrome has not reloaded yet.
 *
 * @param source - directory to copy from.
 * @param target - mirror directory.
 * @param from - source manifest.
 * @param to - mirror manifest as read before any write.
 */
async function mirrorTrees(
  source: string,
  target: string,
  from: TreeManifest,
  to: TreeManifest,
): Promise<void> {
  await mkdir(target, { recursive: true })
  // Unconditional, not "only when the source lacks that name": writing through
  // a planted symlink is exactly what happens when the source *does* have that
  // name, and a FIFO blocks `copyFile` forever. `install-info.json` stays, as
  // always — it is the install script's metadata, not the mirror's content.
  for (const rel of [...to.others].sort()) {
    if (rel === INSTALL_INFO_FILE) continue
    await rm(at(target, rel), { force: true })
  }
  for (const rel of [...to.files.keys()].sort()) {
    if (rel === INSTALL_INFO_FILE || from.files.has(rel)) continue
    await rm(at(target, rel), { force: true })
  }
  // Longest paths first, so a subtree is gone before its parent is removed.
  for (const rel of [...to.dirs].sort((a, b) => b.length - a.length)) {
    if (from.dirs.has(rel)) continue
    await rm(at(target, rel), { recursive: true, force: true })
  }
  // Every directory the source has, including the empty ones: without this the
  // mirror would differ from the source forever and report `synced` on every
  // call without ever writing.
  for (const rel of from.dirs) await mkdir(at(target, rel), { recursive: true })
  for (const [rel, digest] of from.files) {
    // Identical bytes are left alone so an unchanged file keeps its mtime; only
    // the files that actually changed are rewritten.
    if (to.files.get(rel) === digest) continue
    const destination = at(target, rel)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(at(source, rel), destination)
  }
}

/** A one-line cause for logs and for the `browser_status` text. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Name the source entries this module cannot mirror.
 *
 * They are skipped rather than copied — a build directory that contains a
 * symlink is not something Chrome should be handed — and saying so is the
 * difference between "the mirror is complete" and "part of the build was
 * quietly dropped".
 *
 * @param from - source manifest.
 * @returns the note, or undefined when the source holds only files and dirs.
 */
function skippedNote(from: TreeManifest): string | undefined {
  if (from.others.size === 0) return undefined
  const names = [...from.others].sort()
  return `skipped ${names.length} non-regular entr${names.length === 1 ? 'y' : 'ies'} in the extension source: ${names.join(', ')}`
}

/** An empty tree, for a mirror that does not exist yet. */
function emptyManifest(): TreeManifest {
  return { hash: '', files: new Map(), dirs: new Set(), others: new Set() }
}

/** Attach a `reason` only when there is one, for exactOptionalPropertyTypes. */
function optionalReason(reason: string | undefined): { reason?: string } {
  return reason === undefined ? {} : { reason }
}

/**
 * Make the mirror Chrome loads match the bundled extension.
 *
 * Idempotent and safe to call on every startup: when the hashes already agree
 * nothing is written at all — not even a re-copy — so a running Chrome is never
 * handed a half-updated directory for no reason. It never throws and never
 * rejects; I/O problems come back as `failed` with the message, because a
 * bridge that refuses to load is worse than a mirror that is one build behind.
 *
 * The defaults are resolved inside the error boundary on purpose. Evaluating
 * them in the parameter list would happen before the function body, so a
 * throwing `dshHomePath()` would reject the returned promise — and the startup
 * call site is `void syncBundledExtension().then(...)`, which has no catch.
 *
 * @param target - mirror directory; defaults to {@link installedExtensionDir}.
 * @param source - extension directory; defaults to {@link bundledExtensionDir}.
 * @returns what happened, and how many files the source holds. `target` is the
 * empty string when the default mirror path itself could not be resolved.
 */
export async function syncBundledExtension(target?: string, source?: string): Promise<SyncResult> {
  try {
    const mirror = target ?? installedExtensionDir()
    const from = source ?? bundledExtensionDir()
    if (from === undefined || !isExtensionDir(from)) {
      const candidates = bundledCandidates(packageRootDir())
      const looked =
        from === undefined ? `neither ${candidates.development} nor ${candidates.packaged}` : from
      return {
        status: 'unavailable',
        target: mirror,
        files: 0,
        reason: `no bundled extension with a ${MANIFEST_FILE}: ${looked}`,
      }
    }
    const sourceManifest = await readManifest(from, () => false)
    const hasTarget = existsSync(mirror)
    const targetManifest = hasTarget
      ? await readManifest(mirror, (rel) => rel === INSTALL_INFO_FILE)
      : emptyManifest()
    // A mirror holding a symlink or FIFO is never up-to-date, even when every
    // regular file matches: those entries are invisible to the hash, so without
    // this check they would survive every call and the mirror would never
    // converge on the source. `install-info.json` is the one exception, and it
    // has to be spelled out here rather than left to `others.size === 0`: the
    // deletion pass protects that name, the hash excludes it, and the metadata
    // it holds is not the mirror's content — counting it as dirt would make the
    // early return below unreachable and report "refreshed just now" forever
    // while nothing was written.
    const clean = [...targetManifest.others].every((rel) => rel === INSTALL_INFO_FILE)
    if (hasTarget && clean && targetManifest.hash === sourceManifest.hash) {
      return {
        status: 'up-to-date',
        target: mirror,
        source: from,
        files: sourceManifest.files.size,
        ...optionalReason(skippedNote(sourceManifest)),
      }
    }
    await mirrorTrees(from, mirror, sourceManifest, targetManifest)
    return {
      status: 'synced',
      target: mirror,
      source: from,
      files: sourceManifest.files.size,
      ...optionalReason(skippedNote(sourceManifest)),
    }
  } catch (error: unknown) {
    return {
      status: 'failed',
      target: target ?? '',
      files: 0,
      ...(source !== undefined ? { source } : {}),
      reason: reasonOf(error),
    }
  }
}
