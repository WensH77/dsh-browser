// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearNavigationFailure,
  pageLoadFailure,
  recordedNavigationFailure,
  recordNavigationFailure,
} from '../src/background/page-errors.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('page load failures', () => {
  it('records a top-frame failure and forgets it on commit', () => {
    recordNavigationFailure(4, 0, 'https://example.com/a', 'net::ERR_EMPTY_RESPONSE')
    expect(recordedNavigationFailure(4)).toEqual({
      error: 'net::ERR_EMPTY_RESPONSE',
      url: 'https://example.com/a',
    })

    clearNavigationFailure(4)
    expect(recordedNavigationFailure(4)).toBeUndefined()
  })

  it('ignores a sub-frame failure: an iframe is not the page', () => {
    recordNavigationFailure(5, 3, 'https://ads.example.net/frame', 'net::ERR_BLOCKED_BY_CLIENT')
    expect(recordedNavigationFailure(5)).toBeUndefined()
  })

  it('asks Chrome when nothing was recorded', async () => {
    vi.stubGlobal('chrome', {
      webNavigation: {
        getFrame: async () => ({ errorOccurred: true, url: 'https://example.com/b' }),
      },
    })

    await expect(pageLoadFailure(6, undefined)).resolves.toEqual({
      error: 'the page did not load',
      url: 'https://example.com/b',
    })
  })

  it('reports nothing when the frame loaded or cannot be read', async () => {
    vi.stubGlobal('chrome', {
      webNavigation: { getFrame: async () => ({ errorOccurred: false }) },
    })
    await expect(pageLoadFailure(7, undefined)).resolves.toBeUndefined()

    vi.stubGlobal('chrome', {
      webNavigation: { getFrame: async () => { throw new Error('No tab with id: 8') } },
    })
    await expect(pageLoadFailure(8, undefined)).resolves.toBeUndefined()
  })

  it('prefers the recorded error name over Chrome\'s bare "it failed"', async () => {
    recordNavigationFailure(9, 0, 'https://example.com/c', 'net::ERR_CONNECTION_RESET')
    vi.stubGlobal('chrome', {
      webNavigation: { getFrame: async () => ({ errorOccurred: true, url: 'https://example.com/c' }) },
    })

    await expect(pageLoadFailure(9, undefined)).resolves.toEqual({
      error: 'net::ERR_CONNECTION_RESET',
      url: 'https://example.com/c',
    })
    clearNavigationFailure(9)
  })
})
