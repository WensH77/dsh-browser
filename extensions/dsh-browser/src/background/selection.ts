/**
 * The one page selection the side panels may attach to their next prompt.
 *
 * Only the newest highlight is kept: a selection is a pointer to what the user
 * is asking about, so an older one is stale the moment they highlight
 * something else. The tracker is deliberately pure so the lifecycle rules
 * (replace, dismiss, navigate away, close the tab) are testable without a
 * browser runtime.
 *
 * @module
 */

import type { PageSelection, SelectionCapture } from '../selection.ts'

/** The frame a capture came from; iframes report their own document. */
export interface SelectionSource {
  tabId: number
  frameId: number
}

/** Holds the latest selection for every open side panel. */
export class SelectionTracker {
  private entry: { source: SelectionSource; selection: PageSelection } | null = null

  /**
   * Record a capture as the current selection.
   * @returns true when the panels must be told; false when nothing changed.
   */
  capture(source: SelectionSource, capture: SelectionCapture, now: number = Date.now()): boolean {
    const current = this.entry
    if (current !== null
      && current.source.tabId === source.tabId
      && current.source.frameId === source.frameId
      && current.selection.text === capture.text
      && current.selection.url === capture.url) return false
    this.entry = { source: { ...source }, selection: { ...capture, capturedAt: now } }
    return true
  }

  current(): PageSelection | null {
    return this.entry === null ? null : { ...this.entry.selection }
  }

  /** @returns true when a selection was dropped. */
  clear(): boolean {
    if (this.entry === null) return false
    this.entry = null
    return true
  }

  /** Drop the selection when its page goes away (navigation, close, replace). */
  clearTab(tabId: number): boolean {
    return this.entry?.source.tabId === tabId && this.clear()
  }
}
