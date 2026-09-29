// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

/**
 * A `chrome.storage.session` stand-in whose contents outlive a module reload —
 * that reload is what a service worker restart looks like to this module.
 */
function installChromeStorage(): Map<string, unknown> {
  const store = new Map<string, unknown>()
  ;(globalThis as { chrome?: unknown }).chrome = {
    runtime: { getManifest: () => ({ version: '0.1.3' }) },
    storage: {
      session: {
        get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value)
        },
      },
    },
  }
  return store
}

/** Import a fresh instance, as a newly started service worker would. */
async function loadModule(): Promise<typeof import('../src/background/debug-log.ts')> {
  vi.resetModules()
  return await import('../src/background/debug-log.ts')
}

describe('debug event log', () => {
  it('starts with the worker line and keeps only the newest events', async () => {
    installChromeStorage()
    const log = await loadModule()
    for (let index = 0; index < log.MAX_DEBUG_EVENTS + 10; index += 1) {
      log.recordDebugEvent('tool-error', `failure ${index}`)
    }

    const events = await log.readDebugEvents()

    expect(events).toHaveLength(log.MAX_DEBUG_EVENTS)
    expect(events[0]!.detail).toBe('failure 10')
    expect(events[events.length - 1]!.detail).toBe(`failure ${log.MAX_DEBUG_EVENTS + 9}`)
    // The worker-start line is not special-cased: once the ring fills, the
    // newest events are the ones worth keeping.
    expect(events.some((event) => event.kind === 'worker-start')).toBe(false)
  })

  it('restores what a previous worker recorded, so a restart cannot erase its own evidence', async () => {
    installChromeStorage()
    const first = await loadModule()
    first.recordDebugEvent('attach', 'tab 7 attached (CDP 1.3)')
    await first.readDebugEvents()

    const second = await loadModule()
    const events = await second.readDebugEvents()

    expect(events.map((event) => event.detail)).toContain('tab 7 attached (CDP 1.3)')
    expect(events.filter((event) => event.kind === 'worker-start')).toHaveLength(2)
  })

  it('renders one line per event, and says so when nothing was recorded', async () => {
    installChromeStorage()
    const log = await loadModule()

    expect(log.renderDebugEvents([])).toContain('no debugging events recorded')
    expect(log.renderDebugEvents([{ at: '2026-09-29T00:00:00.000Z', kind: 'attach', detail: 'tab 7 attached' }]))
      .toBe('2026-09-29T00:00:00.000Z attach tab 7 attached')
  })

  it('collapses whitespace and clips one long Chrome message', async () => {
    installChromeStorage()
    const log = await loadModule()
    log.recordDebugEvent('attach-failed', `line one\n   line two ${'x'.repeat(400)}`)

    const event = (await log.readDebugEvents()).find((entry) => entry.kind === 'attach-failed')!

    expect(event.detail.startsWith('line one line two')).toBe(true)
    expect(event.detail.length).toBeLessThanOrEqual(300)
  })

  it('renders only the newest events for the panel, clipped to the count asked for', async () => {
    installChromeStorage()
    const log = await loadModule()
    for (let index = 0; index < 40; index += 1) log.recordDebugEvent('tool-error', `failure ${index}`)

    const lines = (await log.recentDebugEventsText(30)).split('\n')

    expect(lines).toHaveLength(30)
    expect(lines[0]).toContain('failure 10')
    expect(lines[lines.length - 1]).toContain('failure 39')
  })

  it('still records when there is no storage area at all', async () => {
    delete (globalThis as { chrome?: unknown }).chrome
    const log = await loadModule()
    log.recordDebugEvent('detach', 'tab 7 detached by Chrome: canceled_by_user')

    const events = await log.readDebugEvents()

    expect(events.some((event) => event.detail === 'tab 7 detached by Chrome: canceled_by_user')).toBe(true)
  })
})
