// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForTabCommit } from '../src/background/tab-commit.ts'

/** Minimal chrome.tabs.get stub driven by a queue of observations. */
function stubTabs(observations: Array<chrome.tabs.Tab | Error>): { calls: () => number } {
  let index = 0
  const get = vi.fn(async (): Promise<chrome.tabs.Tab> => {
    const next = observations[Math.min(index, observations.length - 1)]!
    index += 1
    if (next instanceof Error) throw next
    return next
  })
  vi.stubGlobal('chrome', { tabs: { get } })
  return { calls: () => get.mock.calls.length }
}

const tab = (url: string): chrome.tabs.Tab => ({ id: 7, windowId: 1, url } as chrome.tabs.Tab)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('waitForTabCommit', () => {
  it('waits past the empty first observation and returns the committed tab', async () => {
    vi.useFakeTimers()
    stubTabs([tab(''), tab('about:blank'), tab('https://docs.example/deck')])

    const pending = waitForTabCommit(7, 5_000, 10)
    await vi.advanceTimersByTimeAsync(100)
    const committed = await pending

    expect(committed?.url).toBe('https://docs.example/deck')
  })

  it('returns immediately when the tab already committed', async () => {
    const stub = stubTabs([tab('https://docs.example/deck')])

    await expect(waitForTabCommit(7, 5_000, 10)).resolves.toMatchObject({ url: 'https://docs.example/deck' })
    expect(stub.calls()).toBe(1)
  })

  it('gives up after the budget instead of failing the navigation', async () => {
    vi.useFakeTimers()
    stubTabs([tab('')])

    const pending = waitForTabCommit(7, 300, 50)
    await vi.advanceTimersByTimeAsync(400)

    await expect(pending).resolves.toBeUndefined()
  })

  it('stops watching a tab that was closed', async () => {
    stubTabs([new Error('No tab with id: 7')])

    await expect(waitForTabCommit(7, 5_000, 10)).resolves.toBeUndefined()
  })
})
