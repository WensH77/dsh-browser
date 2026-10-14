// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { liveTabStateNote, tabStateNote } from '../src/shared/tab-state.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tabStateNote', () => {
  it('says nothing while the tab is visible and focused', () => {
    expect(tabStateNote(false, false)).toBe('')
  })

  it('names each condition on its own, because they are independent', () => {
    expect(tabStateNote(true, false)).toContain('The controlled tab is hidden.')
    expect(tabStateNote(false, true)).toContain('in a window that does not hold system focus')
    expect(tabStateNote(true, true)).toContain('hidden and its window does not hold system focus')
  })

  it('reads both values off the live document', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    expect(liveTabStateNote()).toBe('')

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    expect(liveTabStateNote()).toContain('The controlled tab is hidden.')

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    expect(liveTabStateNote()).toContain('in a window that does not hold system focus')
  })
})
