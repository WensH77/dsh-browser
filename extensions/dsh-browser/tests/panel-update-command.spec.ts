/**
 * The Update button: its rule, its press, and the copy both need.
 *
 * The button copies the command that updates the dsh plugin and extension. It
 * must not be pressable when there is no bridge to ask, must never report a
 * command it did not copy, and must never read as "updated" — the user still has
 * to run the command and reload the extension.
 */

import { describe, expect, it, vi } from 'vitest'
import { en, zh } from '../src/panel/App.tsx'
import {
  requestUpdateCommand,
  updateButtonView,
  type UpdateCommandDeps,
  type UpdateCopy,
} from '../src/panel/update-command.ts'

const COPY: UpdateCopy = {
  update: 'Update',
  updateHint: 'Copy the update command to the clipboard',
  updateCopied: 'Copied',
  updateFailed: 'Copy failed',
  updateNeedsBridge: 'Connect the bridge first',
  updateUnavailable: 'The host returned no update command',
}

describe('updateButtonView', () => {
  it('disables the button, with its reason, while there is no bridge to ask', () => {
    // The command is composed by the host and travels over the bridge socket,
    // so no connection means nothing to copy. A press would only produce a
    // failure the user cannot act on.
    for (const state of ['stopped', 'connecting', 'reconnecting']) {
      expect(updateButtonView(state, 'idle', COPY), state).toEqual({
        label: COPY.update,
        title: COPY.updateNeedsBridge,
        reason: COPY.updateNeedsBridge,
        disabled: true,
      })
    }
  })

  it('leaves the button usable on a connected bridge', () => {
    expect(updateButtonView('connected', 'idle', COPY)).toEqual({
      label: COPY.update,
      title: COPY.updateHint,
      reason: null,
      disabled: false,
    })
  })

  it('reports a copy that failed, and says why', () => {
    expect(updateButtonView('connected', 'failed', COPY)).toEqual({
      label: COPY.updateFailed,
      title: COPY.updateUnavailable,
      reason: COPY.updateUnavailable,
      disabled: false,
    })
  })

  it('shows the copy feedback only after one happened', () => {
    expect(updateButtonView('connected', 'copied', COPY).label).toBe(COPY.updateCopied)
    expect(updateButtonView('connected', 'copied', COPY).reason).toBeNull()
  })
})

describe('requestUpdateCommand', () => {
  function deps(answer: unknown, copied = true): { deps: UpdateCommandDeps, send: ReturnType<typeof vi.fn>, copy: ReturnType<typeof vi.fn> } {
    const send = vi.fn(async () => answer)
    const copy = vi.fn(async () => copied)
    return { deps: { send, copy } as unknown as UpdateCommandDeps, send, copy }
  }

  it('asks the background for the command and copies exactly what it answered', async () => {
    const { deps: injected, send, copy } = deps({ command: './scripts/install.sh' })

    const attempt = await requestUpdateCommand(injected)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ type: 'update-command' })
    expect(copy).toHaveBeenCalledTimes(1)
    expect(copy).toHaveBeenCalledWith('./scripts/install.sh')
    expect(attempt).toEqual({ outcome: 'copied', command: './scripts/install.sh', reason: null })
  })

  it('reports a failure when the host refused or the background answered an error', async () => {
    const { deps: injected, copy } = deps({ error: 'bridge refuses RPC method bridge.updateCommand' })

    const attempt = await requestUpdateCommand(injected)

    expect(copy).not.toHaveBeenCalled()
    expect(attempt.outcome).toBe('failed')
    expect(attempt.reason).toBe('bridge refuses RPC method bridge.updateCommand')
  })

  it('reports a failure when the request itself rejects', async () => {
    const send = vi.fn(async () => { throw new Error('Bridge is not connected') })
    const copy = vi.fn(async () => true)

    const attempt = await requestUpdateCommand({ send, copy })

    expect(copy).not.toHaveBeenCalled()
    expect(attempt.outcome).toBe('failed')
    expect(attempt.reason).toBe('Bridge is not connected')
  })

  it('never reports success for an empty command or a refused clipboard write', async () => {
    // An empty string copied to the clipboard would look like a successful copy
    // and leave the user with nothing to paste.
    const empty = await requestUpdateCommand(deps({ command: '   ' }).deps)
    expect(empty.outcome).toBe('failed')
    expect(empty.reason).not.toBeNull()

    // `copyTextToClipboard` answers false when both clipboard paths fail.
    const refused = await requestUpdateCommand(deps({ command: './scripts/install.sh' }, false).deps)
    expect(refused.outcome).toBe('failed')
    expect(refused.reason).not.toBeNull()
  })
})

describe('panel copy for the Update button', () => {
  it('carries every key in both languages', () => {
    // A missing translation renders as `undefined`: the button would lose its
    // label, or its reason, in one language only.
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const key of ['update', 'updateHint', 'updateCopied', 'updateFailed', 'updateNeedsBridge', 'updateUnavailable'] as const) {
      expect(zh[key], `zh.${key}`).toBeTruthy()
      expect(en[key], `en.${key}`).toBeTruthy()
    }
  })

  it('never claims the extension was updated', () => {
    // Copying is not updating: the user runs the command and reloads the
    // extension by hand, so no label, tooltip or reason may say otherwise.
    for (const [locale, copy] of [['zh', zh], ['en', en]] as const) {
      const text = [copy.update, copy.updateHint, copy.updateCopied, copy.updateFailed, copy.updateNeedsBridge, copy.updateUnavailable].join(' ')
      expect(text, locale).not.toMatch(/updated|update complete|已更新|更新完成/i)
    }
  })
})
