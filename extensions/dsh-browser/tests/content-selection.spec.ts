// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_SELECTION_CHARS } from '../src/selection.ts'
import { SelectionWatcher, readSelectionCapture } from '../src/content/selection.ts'

function selectText(value: string): void {
  vi.stubGlobal('getSelection', () => ({ toString: () => value }))
  window.getSelection = () => ({ toString: () => value }) as unknown as Selection
}

afterEach(() => {
  document.body.innerHTML = ''
  document.title = ''
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('reading a page selection', () => {
  it('captures the highlight with its page identity', () => {
    document.title = 'Example page'
    selectText('  quoted   text  ')

    expect(readSelectionCapture()).toEqual({
      text: 'quoted text',
      truncated: false,
      title: 'Example page',
      url: location.href,
    })
  })

  it('reports nothing when no text is highlighted', () => {
    selectText('')
    expect(readSelectionCapture()).toBeNull()
  })

  it('marks a highlight that exceeded the capture ceiling', () => {
    selectText('z'.repeat(MAX_SELECTION_CHARS + 1))
    expect(readSelectionCapture()?.truncated).toBe(true)
  })

  it('reads a focused field selection that window.getSelection() hides', () => {
    document.body.innerHTML = '<textarea id="notes">hello world</textarea>'
    const field = document.getElementById('notes') as HTMLTextAreaElement
    field.focus()
    field.setSelectionRange(0, 5)
    selectText('')

    expect(readSelectionCapture()?.text).toBe('hello')
  })

  it('never reads a selection inside a password or payment field', () => {
    document.body.innerHTML = '<input id="secret" type="password" value="hunter2">'
    const field = document.getElementById('secret') as HTMLInputElement
    field.focus()
    field.setSelectionRange(0, 7)
    selectText('')

    expect(readSelectionCapture()).toBeNull()
  })
})

describe('selection watcher', () => {
  it('stays silent until a panel arms it', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = new SelectionWatcher(emit, 10)

    selectText('quoted text')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(50)
    expect(emit).not.toHaveBeenCalled()

    watcher.setEnabled(true)
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(50)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]?.[0]).toMatchObject({ text: 'quoted text' })
  })

  it('reports a highlight made before the panel opened', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = new SelectionWatcher(emit, 10)

    selectText('highlighted before opening')
    watcher.setEnabled(true)
    vi.advanceTimersByTime(20)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]?.[0]).toMatchObject({ text: 'highlighted before opening' })
  })

  it('emits once for a drag that fires many selection changes', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = new SelectionWatcher(emit, 10)
    watcher.setEnabled(true)

    for (const partial of ['q', 'qu', 'quoted text']) {
      selectText(partial)
      document.dispatchEvent(new Event('selectionchange'))
      vi.advanceTimersByTime(5)
    }
    vi.advanceTimersByTime(20)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]?.[0]).toMatchObject({ text: 'quoted text' })
  })

  it('keeps the captured quote when the user clears the highlight', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = new SelectionWatcher(emit, 10)
    watcher.setEnabled(true)

    selectText('quoted text')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(20)
    selectText('')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(20)

    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('does not resend an unchanged highlight', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = new SelectionWatcher(emit, 10)
    watcher.setEnabled(true)

    selectText('quoted text')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      document.dispatchEvent(new Event('selectionchange'))
      vi.advanceTimersByTime(20)
    }

    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('releases the page listener when it is disarmed', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const watcher = new SelectionWatcher(emit, 10)
    watcher.setEnabled(true)
    watcher.dispose()

    selectText('quoted text')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(50)

    expect(emit).not.toHaveBeenCalled()
  })
})
