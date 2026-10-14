/**
 * The panel's Update button, background half.
 *
 * The update command depends on where the plugin runs from and on the platform,
 * so only the host can compose it; the worker's job is to ask for it over the
 * bridge rpc channel and hand the answer to the panel. Nothing is executed:
 * the panel copies the command, and the user runs it.
 *
 * The rpc call is passed in rather than imported, so this module stays free of
 * the worker's own state and can be tested directly. Asking per press is
 * deliberate — the install mode and the path behind the command can change
 * between presses, so there is nothing to cache.
 *
 * @module
 */

import { BRIDGE_UPDATE_COMMAND_METHOD } from 'dsh-bridge-browser/src/protocol.ts'

/** What the background answers `{ type: 'update-command' }` with. */
export interface UpdateCommandAnswer {
  /** The bare command line to copy, present only when one arrived. */
  command?: string
  /** Why no command arrived; the panel words the failure from this. */
  error?: string
}

/**
 * Ask the host for this installation's update command.
 *
 * Every failure — no connection, a timeout, an old host refusing the method —
 * comes back as `error`, never as an empty command the panel could mistake for
 * success.
 *
 * @param rpc - one bridge rpc call (the worker passes its `bridgeRpc`).
 * @returns the command, or why there is none.
 */
export async function fetchUpdateCommand(
  rpc: (method: string, payload: unknown) => Promise<unknown>,
): Promise<UpdateCommandAnswer> {
  try {
    const result = await rpc(BRIDGE_UPDATE_COMMAND_METHOD, {})
    const command = typeof result === 'string' ? result.trim() : ''
    return command === ''
      ? { error: 'the host returned no update command' }
      : { command }
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
