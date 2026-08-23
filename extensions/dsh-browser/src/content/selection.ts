/**
 * Capture of the text the user highlights in a page.
 *
 * The watcher stays disarmed until the service worker says a side panel is
 * open and page sharing is allowed: `selectionchange` fires on every drag in
 * every tab, and an always-on watcher would wake the MV3 service worker for
 * highlights nobody can see.
 *
 * Selections inside password and payment fields are never read, matching the
 * snapshot privacy boundary — the value never leaves the page.
 *
 * @module
 */

import { normalizeSelectionText, type SelectionCapture } from '../selection.ts'
import { isSensitiveField } from './privacy.ts'

/** Quiet period after the last selection change before a capture is emitted. */
const SELECTION_SETTLE_MS = 250

/** Read the current highlight, preferring a focused field's own selection. */
function selectedText(): string {
  const active = document.activeElement
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    // A field's own selection is invisible to window.getSelection() in Chrome.
    if (isSensitiveField(active)) return ''
    try {
      const { selectionStart, selectionEnd } = active
      if (selectionStart !== null && selectionEnd !== null && selectionEnd > selectionStart) {
        return active.value.slice(selectionStart, selectionEnd)
      }
    } catch {
      // selectionStart throws on input types that do not support selection.
    }
  }
  try {
    return window.getSelection()?.toString() ?? ''
  } catch {
    return ''
  }
}

/**
 * Read the frame's current selection as a capture.
 * @returns the capture, or null when nothing quotable is selected.
 */
export function readSelectionCapture(): SelectionCapture | null {
  const raw = selectedText()
  if (raw === '') return null
  const { text, truncated } = normalizeSelectionText(raw)
  if (text === '') return null
  return { text, truncated, title: document.title, url: location.href }
}

/**
 * Debounced `selectionchange` watcher for one frame.
 *
 * Emits only settled, changed, non-empty selections: a drag fires the event
 * per character, and re-emitting an unchanged highlight would replace the
 * panel's capture with an identical one.
 */
export class SelectionWatcher {
  private enabled = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastEmitted = ''

  constructor(
    private readonly emit: (capture: SelectionCapture) => void,
    private readonly settleMs: number = SELECTION_SETTLE_MS,
  ) {}

  /** Arm or disarm the watcher; repeated calls in the same state do nothing. */
  setEnabled(next: boolean): void {
    if (next === this.enabled) return
    this.enabled = next
    if (next) {
      document.addEventListener('selectionchange', this.onSelectionChange)
      // Opening the panel arms the watcher, and the text the user highlighted
      // just before opening it fires no further selectionchange.
      this.onSelectionChange()
      return
    }
    document.removeEventListener('selectionchange', this.onSelectionChange)
    this.cancel()
    this.lastEmitted = ''
  }

  /** Release page listeners left behind by a replaced content script. */
  dispose(): void {
    this.setEnabled(false)
  }

  private cancel(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private readonly onSelectionChange = (): void => {
    this.cancel()
    this.timer = setTimeout(this.flush, this.settleMs)
  }

  private readonly flush = (): void => {
    this.timer = undefined
    if (!this.enabled) return
    const capture = readSelectionCapture()
    // A cleared highlight keeps the panel's capture: the user may have clicked
    // into the page while composing the request about what they selected.
    if (capture === null || capture.text === this.lastEmitted) return
    this.lastEmitted = capture.text
    this.emit(capture)
  }
}
