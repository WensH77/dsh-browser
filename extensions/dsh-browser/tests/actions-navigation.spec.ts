// @vitest-environment jsdom
/**
 * Navigation hand-off: the content script answers its tool first, then asks the
 * background to navigate the tab.
 *
 * Driving the navigation from the browser process (`chrome.tabs.update` /
 * `goBack` / `reload`) instead of assigning `location` here keeps Chrome's
 * blocked-beforeunload intervention out of the extension's error list: the
 * intervention is reported against the script that requested the navigation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

const budget = { maxItems: 20, maxForms: 10, maxChars: 8_000 }
const context = (): { ids: ElementIds; budget: typeof budget } => ({ ids: new ElementIds(), budget })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.replaceChildren()
  window.history.replaceState({}, '', '/')
})

/** A chrome stub that records the messages the content script sends. */
function chromeStub(): { sent: unknown[] } {
  const sent: unknown[] = []
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'extension-id',
      sendMessage: async (message: unknown) => { sent.push(message) },
    },
  })
  return { sent }
}

/** Wait for the 0ms hand-off task scheduled after the tool answer. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('content navigation hand-off', () => {
  it('hands browser_navigate to the background', async () => {
    const { sent } = chromeStub()

    await expect(runAction('browser_navigate', { url: 'https://example.com/a' }, context()))
      .resolves.toMatchObject({ navigationPending: true })
    await settle()

    expect(sent).toEqual([{ type: 'DSH_CONTENT_NAVIGATE', url: 'https://example.com/a' }])
  })

  it('hands history and reload to the background', async () => {
    const { sent } = chromeStub()
    window.history.pushState({}, '', '/one')
    window.history.pushState({}, '', '/two')

    await runAction('browser_back', {}, context())
    await runAction('browser_forward', {}, context())
    await runAction('browser_reload', {}, context())
    await settle()

    expect(sent).toEqual([
      { type: 'DSH_CONTENT_HISTORY', delta: -1 },
      { type: 'DSH_CONTENT_HISTORY', delta: 1 },
      { type: 'DSH_CONTENT_RELOAD' },
    ])
  })

  it('hands a cross-document link click to the background', async () => {
    const { sent } = chromeStub()
    const link = document.createElement('a')
    link.href = 'https://example.com/next'
    link.scrollIntoView = vi.fn()
    // Keep the link's default navigation out of jsdom: the action decides to
    // navigate itself once the page did not cancel the synthetic click.
    const dispatch = vi.spyOn(link, 'dispatchEvent').mockReturnValue(true)
    const ids = { elementByIndex: vi.fn(() => link) } as unknown as ElementIds

    await expect(runAction('browser_click', { index: 1 }, { ids, budget }))
      .resolves.toMatchObject({ navigationPending: true })
    await settle()

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'click' }))
    expect(sent).toEqual([{ type: 'DSH_CONTENT_NAVIGATE', url: 'https://example.com/next' }])
  })

  it('keeps this frame as the fallback when there is no background to ask', async () => {
    // No chrome stub: a plain DOM harness, or an invalidated extension context.
    // The action still answers; it does not throw trying to reach the worker.
    // A hash-only URL keeps jsdom from logging its not-implemented navigation;
    // what this test asserts is that the action answers instead of throwing.
    await expect(runAction('browser_navigate', { url: 'http://localhost:3000/#fallback' }, context()))
      .resolves.toMatchObject({ navigationPending: true })
  })
})
