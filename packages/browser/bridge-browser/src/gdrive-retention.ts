/**
 * Retention for exported Google files under `~/.dsh/gdrive`.
 *
 * Every `google_drive_export` writes its output into
 * `~/.dsh/gdrive/<sessionId>/` and nothing ever removed it, so the directory
 * only grew. Keeping the files is the point — the model hands the user a path
 * to read later — but a session that has been archived has been put away, and
 * its exports are then only worth the space for a while.
 *
 * The rule, and only this rule: an export directory older than
 * {@link RETENTION_DAYS} is removed **if and only if** its session is archived.
 * A session that is not archived keeps its files no matter how old they are, so
 * an active investigation can never lose the workbook it is reading.
 *
 * @module
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Days an archived session's exports are kept before this removes them. */
export const RETENTION_DAYS = 7

/** Prefix a session id carries; `sanitizePathSegment` leaves it in place. */
const SESSION_PREFIX = 'session-'

const DAY_MS = 24 * 60 * 60 * 1000

/** One directory inside the export root. */
export interface ExportEntry {
  name: string
  path: string
  /** Last modification time in epoch milliseconds. */
  mtimeMs: number
}

/** What one cleanup pass did, for logging and for tests. */
export interface RetentionOutcome {
  /** Names of the directories removed. */
  removed: string[]
  /** Names kept because their session is known and not archived. */
  keptUnarchived: string[]
  /** Names kept because they are not a session's export directory at all. */
  keptNotSession: string[]
  /** Total bytes freed by the directories that were removed. */
  freedBytes: number
  /** Reads or removals that failed; the pass continues past them. */
  errors: Array<{ name: string; message: string }>
}

/** Filesystem half of one pass, so the decision logic stays testable. */
export interface RetentionIo {
  /** The export root's directories; a missing root lists nothing. */
  listDirectories(): Promise<ExportEntry[]>
  /** Total size in bytes of one directory tree. */
  measure(path: string): Promise<number>
  remove(path: string): Promise<void>
}

/**
 * The session id a directory name stands for, if it is a session export at all.
 *
 * Only the canonical `session-<id>` spelling counts. A bare id — the shape of
 * the older `ee9479b4-…` directory — is left alone however well it matches,
 * because it is not the spelling this plugin writes and the rule here is to
 * reclaim only what it can positively identify as a session's own exports.
 *
 * @param name - the directory name.
 * @returns the session id, or undefined when the name is not an export dir.
 */
function sessionIdOf(name: string): string | undefined {
  return name.startsWith(SESSION_PREFIX) && name.length > SESSION_PREFIX.length ? name : undefined
}

/**
 * The decision, separated from the filesystem.
 *
 * @param entry - one directory in the export root.
 * @param archivedSessionIds - the registry's archive set.
 * @param nowMs - current time in epoch milliseconds.
 * @returns whether this directory may be removed.
 */
export function shouldRemoveExport(
  entry: ExportEntry,
  archivedSessionIds: Iterable<string>,
  nowMs: number,
): boolean {
  if (nowMs - entry.mtimeMs <= RETENTION_DAYS * DAY_MS) return false
  const id = sessionIdOf(entry.name)
  if (id === undefined) return false
  for (const archived of archivedSessionIds) if (archived === id) return true
  return false
}

/**
 * Remove archived sessions' exports older than the retention window.
 *
 * Never throws: a startup path that cannot read its export root must not stop
 * the bridge from loading. Failures are reported in the outcome.
 *
 * @param io - filesystem access.
 * @param archivedSessionIds - the registry's archive set.
 * @param nowMs - current time; injectable so tests can age a fixture.
 * @returns what the pass did.
 */
export async function pruneExports(
  io: RetentionIo,
  archivedSessionIds: readonly string[],
  nowMs: number = Date.now(),
): Promise<RetentionOutcome> {
  const outcome: RetentionOutcome = { removed: [], keptUnarchived: [], keptNotSession: [], freedBytes: 0, errors: [] }
  let entries: ExportEntry[]
  try {
    entries = await io.listDirectories()
  } catch (error: unknown) {
    outcome.errors.push({ name: '', message: error instanceof Error ? error.message : String(error) })
    return outcome
  }
  for (const entry of entries) {
    const isSession = sessionIdOf(entry.name) !== undefined
    // Age alone never removes anything: a session directory that is not in the
    // archive list is kept, and so is a directory that is not a session's at all
    // — this module only reclaims what it can identify as put-away work.
    if (!shouldRemoveExport(entry, archivedSessionIds, nowMs)) {
      if (isSession) outcome.keptUnarchived.push(entry.name)
      else outcome.keptNotSession.push(entry.name)
      continue
    }
    try {
      outcome.freedBytes += await io.measure(entry.path)
      await io.remove(entry.path)
      outcome.removed.push(entry.name)
    } catch (error: unknown) {
      outcome.errors.push({ name: entry.name, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return outcome
}

/**
 * One line naming what a pass did, for the plugin log.
 *
 * @param outcome - the pass's result.
 * @returns a summary; empty removals still report what was kept and why.
 */
export function describeRetention(outcome: RetentionOutcome): string {
  const freed = `${(outcome.freedBytes / 1024 / 1024).toFixed(1)} MiB`
  const parts = [`removed ${outcome.removed.length} archived export dir(s), freed ${freed}`]
  if (outcome.keptUnarchived.length > 0) parts.push(`kept ${outcome.keptUnarchived.length} unarchived`)
  if (outcome.keptNotSession.length > 0) parts.push(`ignored ${outcome.keptNotSession.length} non-session dir(s)`)
  if (outcome.errors.length > 0) parts.push(`${outcome.errors.length} error(s): ${outcome.errors.map((e) => `${e.name} ${e.message}`).join('; ')}`)
  return `browser bridge: gdrive retention — ${parts.join(', ')}`
}

/** Total bytes under one directory tree. */
async function measureTree(path: string): Promise<number> {
  let total = 0
  for (const dirent of await readdir(path, { withFileTypes: true })) {
    const child = join(path, dirent.name)
    if (dirent.isDirectory()) total += await measureTree(child)
    else total += (await stat(child)).size
  }
  return total
}

/**
 * The real filesystem, bound to one export root.
 *
 * @param root - the export root (`~/.dsh/gdrive`).
 * @returns the filesystem half of a retention pass.
 */
export function nodeRetentionIo(root: string): RetentionIo {
  return {
    async listDirectories(): Promise<ExportEntry[]> {
      if (!existsSync(root)) return []
      const entries: ExportEntry[] = []
      for (const dirent of await readdir(root, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue
        const path = join(root, dirent.name)
        entries.push({ name: dirent.name, path, mtimeMs: (await stat(path)).mtimeMs })
      }
      return entries
    },
    measure: measureTree,
    async remove(path: string): Promise<void> {
      await rm(path, { recursive: true, force: true })
    },
  }
}
