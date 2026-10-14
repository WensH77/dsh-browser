/**
 * The panel's Update button: what it shows, and what one press does.
 *
 * The button copies the command that updates this dsh plugin and extension. It
 * never runs anything: the installer writes into the user's dsh home and needs a
 * manual Reload on `chrome://extensions`, so running it is the user's call. That
 * is also why no label or tooltip here may read "updated" — the only outcomes
 * are "copied" and "copy failed".
 *
 * Both halves live here rather than in the JSX so they are unit-testable: this
 * repository has no React render tests. `updateButtonView` is the rule, and
 * `requestUpdateCommand` is the press with its two side effects injected (the
 * panel passes `sendUiRequest` and its own `copyTextToClipboard`).
 *
 * @module
 */

import type { UiRequest } from '../shared/messages.ts'

/** Feedback of one press, mirroring the Log button's states. */
export type UpdateOutcome = 'idle' | 'copied' | 'failed'

/** Strings the button needs; supplied by the panel for the active locale. */
export interface UpdateCopy {
  /** Label while the button is usable and idle. */
  update: string
  /** Tooltip while usable: what a press does, and what it does not do. */
  updateHint: string
  /** Label right after a successful copy. */
  updateCopied: string
  /** Label right after a failed copy. */
  updateFailed: string
  /** Why the button cannot be pressed at all. */
  updateNeedsBridge: string
  /** Why no command arrived on a press that was made. */
  updateUnavailable: string
}

/** What the panel renders for this state. */
export interface UpdateButtonView {
  label: string
  title: string
  /** The reason shown to the user, or null when there is nothing to explain. */
  reason: string | null
  disabled: boolean
}

/**
 * The Update button's rule.
 *
 * The command is composed by the host and travels over the bridge socket, so
 * with no connection there is nothing to copy and the button is disabled with
 * that reason instead of failing on a press. A press that did reach the host and
 * came back empty — an old host refusing the method, a timeout, a clipboard that
 * refused the write — reports a failure; it never reports success.
 *
 * @param state - the panel's `ui.bridgeState` value.
 * @param outcome - feedback from the most recent press.
 * @param copy - the strings of the active locale.
 * @returns the label, tooltip, reason and disabled state to render.
 */
export function updateButtonView(state: string, outcome: UpdateOutcome, copy: UpdateCopy): UpdateButtonView {
  if (state !== 'connected') {
    // Disabled and explained: a press here could only produce a failure the
    // user cannot act on, and the reason is something they can act on.
    return { label: copy.update, title: copy.updateNeedsBridge, reason: copy.updateNeedsBridge, disabled: true }
  }
  if (outcome === 'copied') {
    return { label: copy.updateCopied, title: copy.updateHint, reason: null, disabled: false }
  }
  if (outcome === 'failed') {
    return { label: copy.updateFailed, title: copy.updateUnavailable, reason: copy.updateUnavailable, disabled: false }
  }
  return { label: copy.update, title: copy.updateHint, reason: null, disabled: false }
}

/** Where one press gets its two side effects. */
export interface UpdateCommandDeps {
  /** Deliver one UI request to the background; the panel passes `sendUiRequest`. */
  send: (message: UiRequest) => Promise<unknown>
  /** Put text on the clipboard; the panel passes its own `copyTextToClipboard`. */
  copy: (text: string) => Promise<boolean>
}

/** What one press did. */
export interface UpdateAttempt {
  /** 'copied' only when a command arrived and the clipboard took it. */
  outcome: 'copied' | 'failed'
  /** The command that arrived, or '' when none did. */
  command: string
  /** Why it failed, or null. */
  reason: string | null
}

/**
 * Ask the background for the update command and copy it.
 *
 * The command is fetched per press and never cached: the install mode and the
 * path behind it belong to the host and can change. Every path that does not end
 * with a successful clipboard write settles as `failed`.
 *
 * @param deps - the request and clipboard calls to use.
 * @returns the outcome, the command that arrived, and any failure reason.
 */
export async function requestUpdateCommand(deps: UpdateCommandDeps): Promise<UpdateAttempt> {
  let command = ''
  let reason: string | null = null
  try {
    const answer = await deps.send({ type: 'update-command' })
    const answerCommand = (answer as { command?: unknown } | undefined)?.command
    const answerError = (answer as { error?: unknown } | undefined)?.error
    if (typeof answerCommand === 'string' && answerCommand.trim() !== '') command = answerCommand.trim()
    else reason = typeof answerError === 'string' && answerError !== '' ? answerError : 'the background returned no update command'
  } catch (error: unknown) {
    reason = error instanceof Error ? error.message : String(error)
  }
  // An empty command is never copied and never reported as a success: a
  // clipboard write of '' would look like it worked.
  if (command === '') return { outcome: 'failed', command, reason }
  const copied = await deps.copy(command)
  return copied
    ? { outcome: 'copied', command, reason: null }
    : { outcome: 'failed', command, reason: reason ?? 'the clipboard refused the write' }
}
