import { describe, expect, it } from 'vitest'
import {
  RETENTION_DAYS,
  describeRetention,
  pruneExports,
  shouldRemoveExport,
  type ExportEntry,
  type RetentionIo,
} from '../src/gdrive-retention.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)
const entry = (name: string, ageDays: number): ExportEntry => ({
  name,
  path: `/exports/${name}`,
  mtimeMs: NOW - ageDays * DAY,
})

describe('shouldRemoveExport', () => {
  it('removes an archived session\'s exports once they are past the window', () => {
    expect(shouldRemoveExport(entry('session-old', RETENTION_DAYS + 1), ['session-old'], NOW)).toBe(true)
  })

  it('keeps them inside the window', () => {
    expect(shouldRemoveExport(entry('session-new', RETENTION_DAYS - 1), ['session-new'], NOW)).toBe(false)
    // Exactly on the boundary counts as inside it.
    expect(shouldRemoveExport(entry('session-edge', RETENTION_DAYS), ['session-edge'], NOW)).toBe(false)
  })

  it('keeps an unarchived session\'s exports however old they are', () => {
    // The whole point of the rule: an investigation still in progress must not
    // lose the workbook it is reading.
    expect(shouldRemoveExport(entry('session-live', 365), [], NOW)).toBe(false)
    expect(shouldRemoveExport(entry('session-live', 365), ['session-other'], NOW)).toBe(false)
  })

  it('keeps a directory that is not a session\'s at all, however old', () => {
    // A bare uuid is not the spelling this plugin writes; age alone is never a
    // reason to delete something it cannot identify.
    expect(shouldRemoveExport(entry('ee9479b4-228a-47e5-8101-1bfb3bcbbb99', 400), ['ee9479b4-228a-47e5-8101-1bfb3bcbbb99'], NOW)).toBe(false)
    expect(shouldRemoveExport(entry('scratch', 400), ['scratch'], NOW)).toBe(false)
  })

  it('matches on the canonical prefixed spelling only', () => {
    expect(shouldRemoveExport(entry('session-1d74e5c5', RETENTION_DAYS + 1), ['session-1d74e5c5'], NOW)).toBe(true)
    // Without the prefix the name is not the shape this plugin writes, so it is
    // left alone even when the bare id is a real session.
    expect(shouldRemoveExport(entry('1d74e5c5', RETENTION_DAYS + 1), ['1d74e5c5'], NOW)).toBe(false)
  })
})

/** An in-memory export root that records what was removed. */
function fakeIo(entries: ExportEntry[]): RetentionIo & { removedPaths: string[] } {
  const removedPaths: string[] = []
  return {
    removedPaths,
    async listDirectories() { return entries },
    async measure() { return 1024 },
    async remove(path) { removedPaths.push(path) },
  }
}

describe('pruneExports', () => {
  it('removes only the archived directories that aged out, and reports the split', async () => {
    const io = fakeIo([
      entry('session-archived-old', RETENTION_DAYS + 6),
      entry('session-archived-new', 1),
      entry('session-live-old', 300),
      entry('ee9479b4-228a-47e5-8101-1bfb3bcbbb99', 8),
    ])

    const outcome = await pruneExports(io, ['session-archived-old', 'session-archived-new'], NOW)

    expect(outcome.removed).toEqual(['session-archived-old'])
    expect(outcome.keptUnarchived).toEqual(['session-archived-new', 'session-live-old'])
    expect(outcome.keptNotSession).toEqual(['ee9479b4-228a-47e5-8101-1bfb3bcbbb99'])
    expect(io.removedPaths).toEqual(['/exports/session-archived-old'])
    expect(outcome.freedBytes).toBe(1024)
    expect(outcome.errors).toEqual([])
  })

  it('keeps going when one removal fails', async () => {
    const io = fakeIo([entry('session-a', 30), entry('session-b', 30)])
    io.remove = async (path) => {
      if (path.endsWith('session-a')) throw new Error('EBUSY')
    }

    const outcome = await pruneExports(io, ['session-a', 'session-b'], NOW)

    expect(outcome.removed).toEqual(['session-b'])
    expect(outcome.errors).toEqual([{ name: 'session-a', message: 'EBUSY' }])
  })

  it('reports a root it cannot read instead of throwing at startup', async () => {
    const io = fakeIo([])
    io.listDirectories = async () => { throw new Error('EACCES') }

    const outcome = await pruneExports(io, [], NOW)

    expect(outcome.removed).toEqual([])
    expect(outcome.errors).toEqual([{ name: '', message: 'EACCES' }])
  })

  it('summarizes a pass in one line', () => {
    const text = describeRetention({
      removed: ['a'],
      keptUnarchived: ['b'],
      keptNotSession: ['c'],
      freedBytes: 2 * 1024 * 1024,
      errors: [],
    })

    expect(text).toContain('removed 1 archived export dir(s)')
    expect(text).toContain('2.0 MiB')
    expect(text).toContain('kept 1 unarchived')
    expect(text).toContain('ignored 1 non-session dir(s)')
  })
})
