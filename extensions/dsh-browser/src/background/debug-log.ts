/**
 * The last few debugging-session events, kept where a machine we cannot attach
 * to can still be read from.
 *
 * The reports that reach us arrive as symptoms — "screenshots fail", "eval does
 * not work", "the debug banner appeared and disappeared a few seconds later" —
 * and they come from someone else's Chrome. Two facts settle most of them:
 * Chrome names the reason a session ended (`chrome.debugger.onDetach`), and the
 * service worker's own start line says whether the worker was torn down while a
 * session was live (a worker restart takes the attach with it, which is exactly
 * a banner that vanishes on its own). Both are recorded here, ring-buffered,
 * and persisted to `chrome.storage.session` so a worker restart — the prime
 * suspect — cannot erase its own evidence.
 *
 * Nothing here is page content: kinds are fixed strings and details are
 * Chrome's own error text, tool names, and reasons.
 *
 * @module
 */

/** One event, rendered as one line. */
export interface DebugEvent {
  /** ISO timestamp of the moment it was recorded. */
  at: string
  /** Fixed event kind: worker-start, attach, attach-failed, detach, tool-error, … */
  kind: string
  /** Chrome's own words, or the numbers that identify the session. */
  detail: string
}

/** How many events one extension keeps. A failure needs the tail, not a log. */
export const MAX_DEBUG_EVENTS = 60

/** Storage key inside `chrome.storage.session`. */
const STORAGE_KEY = 'debugEvents'

/** Longest detail kept per event; Chrome's messages are short, tracebacks are not. */
const MAX_DETAIL_CHARS = 300

let events: DebugEvent[] = []
let restore: Promise<void> | undefined
let writes: Promise<void> = Promise.resolve()

function storageArea(): chrome.storage.StorageArea | undefined {
  return typeof chrome === 'undefined' ? undefined : chrome.storage?.session
}

function isEvent(value: unknown): value is DebugEvent {
  const candidate = value as Partial<DebugEvent> | null
  return typeof candidate?.at === 'string' && typeof candidate.kind === 'string' && typeof candidate.detail === 'string'
}

/**
 * Restore what a previous worker instance recorded.
 *
 * Started on module load and awaited by readers only: `recordDebugEvent` stays
 * synchronous so callers inside an attach path never await storage, and events
 * recorded before the restore lands keep their order after it.
 */
function restoreEvents(): Promise<void> {
  if (restore !== undefined) return restore
  restore = (async () => {
    const area = storageArea()
    if (area === undefined) return
    try {
      const stored = await area.get(STORAGE_KEY)
      const value = stored?.[STORAGE_KEY]
      if (!Array.isArray(value)) return
      events = [...value.filter(isEvent), ...events].slice(-MAX_DEBUG_EVENTS)
    } catch {
      // Storage is a convenience here: without it the ring still serves the
      // live worker, which is the common case.
    }
  })()
  return restore
}

/** Record one event; never throws, never blocks the caller. */
export function recordDebugEvent(kind: string, detail: string): void {
  const entry: DebugEvent = {
    at: new Date().toISOString(),
    kind,
    detail: detail.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS),
  }
  events = [...events, entry].slice(-MAX_DEBUG_EVENTS)
  const area = storageArea()
  if (area === undefined) return
  writes = writes.then(async () => {
    // Restore first: the worker-start line recorded at module load would
    // otherwise overwrite the previous instance's events before they are read
    // back — erasing exactly the evidence this file exists to keep.
    await restoreEvents()
    try {
      await area.set({ [STORAGE_KEY]: events })
    } catch {
      // Best effort: a failed write must not turn a diagnostic into a fault.
    }
  }, () => undefined)
}

/** Every recorded event, oldest first. */
export async function readDebugEvents(): Promise<DebugEvent[]> {
  await restoreEvents()
  await writes.catch(() => undefined)
  return [...events]
}

/** The whole ring as text: one `time kind detail` line per event. */
export function renderDebugEvents(list: readonly DebugEvent[]): string {
  if (list.length === 0) return 'no debugging events recorded in this browser session'
  return list.map((event) => `${event.at} ${event.kind} ${event.detail}`).join('\n')
}

/** The newest `count` events as text — what the panel's Log button copies. */
export async function recentDebugEventsText(count: number): Promise<string> {
  const events = await readDebugEvents()
  return renderDebugEvents(events.slice(-count))
}

// The worker may have been restarted mid-session; that start is itself the
// evidence, so it is written before anything else can happen.
recordDebugEvent('worker-start', `service worker started (extension ${typeof chrome === 'undefined' ? 'unknown' : chrome.runtime?.getManifest?.().version ?? 'unknown'})`)
