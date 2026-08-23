// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { SelectionTracker } from '../src/background/selection.ts'

const capture = {
  text: 'quoted text',
  truncated: false,
  title: 'Example page',
  url: 'https://example.com/a',
}

describe('selection tracker', () => {
  it('stamps the newest capture and reports it once', () => {
    const tracker = new SelectionTracker()

    expect(tracker.capture({ tabId: 1, frameId: 0 }, capture, 1_000)).toBe(true)
    expect(tracker.current()).toEqual({ ...capture, capturedAt: 1_000 })
    expect(tracker.capture({ tabId: 1, frameId: 0 }, capture, 2_000)).toBe(false)
    expect(tracker.current()?.capturedAt).toBe(1_000)
  })

  it('replaces an older selection instead of collecting it', () => {
    const tracker = new SelectionTracker()
    tracker.capture({ tabId: 1, frameId: 0 }, capture, 1_000)

    expect(tracker.capture({ tabId: 1, frameId: 0 }, { ...capture, text: 'newer' }, 2_000)).toBe(true)
    expect(tracker.current()).toEqual({ ...capture, text: 'newer', capturedAt: 2_000 })
  })

  it('treats the same text in another frame as a new selection', () => {
    const tracker = new SelectionTracker()
    tracker.capture({ tabId: 1, frameId: 0 }, capture, 1_000)

    expect(tracker.capture({ tabId: 1, frameId: 3 }, capture, 2_000)).toBe(true)
  })

  it('drops the selection when its own page goes away', () => {
    const tracker = new SelectionTracker()
    tracker.capture({ tabId: 1, frameId: 0 }, capture, 1_000)

    expect(tracker.clearTab(2)).toBe(false)
    expect(tracker.current()).not.toBeNull()
    expect(tracker.clearTab(1)).toBe(true)
    expect(tracker.current()).toBeNull()
  })

  it('reports whether a clear changed anything', () => {
    const tracker = new SelectionTracker()

    expect(tracker.clear()).toBe(false)
    tracker.capture({ tabId: 1, frameId: 0 }, capture, 1_000)
    expect(tracker.clear()).toBe(true)
    expect(tracker.current()).toBeNull()
  })

  it('hands out copies so a panel broadcast cannot mutate the state', () => {
    const tracker = new SelectionTracker()
    tracker.capture({ tabId: 1, frameId: 0 }, capture, 1_000)

    const first = tracker.current()!
    first.text = 'tampered'

    expect(tracker.current()?.text).toBe('quoted text')
  })
})
