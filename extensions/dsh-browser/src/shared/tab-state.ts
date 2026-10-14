/**
 * Whether the controlled tab is being looked at, and what that costs a driven step.
 *
 * The browser delivers no focus events to a hidden tab or to a window that has lost
 * system focus, and it refuses clipboard writes there. Neither condition is visible
 * in an action's own report: the events are dispatched, the page simply ignores them,
 * and the tool answers "ok". The two values are independent — a tab can be visible
 * while its window is unfocused — so both are read and both are named.
 *
 * Measured 2026-10-13 on intranet-v2: in a hidden tab a `focus()`/`blur()` pair
 * delivered zero blur and zero focusout events, and a save that depended on the
 * `blur` commit posted the field's stale value while the tool reported success.
 *
 * @module
 */

/**
 * The clause a result carries when the tab's state can explain a silent no-op.
 *
 * @param hidden - `document.visibilityState` is not `visible`.
 * @param unfocused - `document.hasFocus()` is false.
 * @returns the note, or `''` when the tab is visible and focused.
 */
export function tabStateNote(hidden: boolean, unfocused: boolean): string {
  if (!hidden && !unfocused) return ''
  const state = hidden && unfocused
    ? 'hidden and its window does not hold system focus'
    : hidden ? 'hidden' : 'in a window that does not hold system focus'
  return `The controlled tab is ${state}. No focus events reach it in this state and clipboard writes are refused, so a step that depends on either can do nothing silently.`
}

/**
 * Read both values off the live document.
 *
 * @returns the note for this document's current state.
 */
export function liveTabStateNote(): string {
  return tabStateNote(document.visibilityState !== 'visible', document.hasFocus() === false)
}
