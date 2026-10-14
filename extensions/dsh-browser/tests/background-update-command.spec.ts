/**
 * The background's half of the Update button.
 *
 * The command is composed by the host, so the one thing this half must get right
 * is which rpc method it asks and with what payload. Everything that is not a
 * non-empty command — no answer, a non-string answer, a refused method, a
 * timeout — has to come back as an error the panel can show, never as an empty
 * command it could copy and call a success.
 */

import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_UPDATE_COMMAND_METHOD } from 'dsh-bridge-browser/src/protocol.ts'
import { fetchUpdateCommand } from '../src/background/update-command.ts'

describe('fetchUpdateCommand', () => {
  it('asks bridge.updateCommand with no parameters', async () => {
    const rpc = vi.fn(async (_method: string, _payload: unknown) => './scripts/install.sh')

    await expect(fetchUpdateCommand(rpc)).resolves.toEqual({ command: './scripts/install.sh' })

    // The method name is the wire contract with the host; the payload is empty
    // because the method takes no arguments.
    expect(BRIDGE_UPDATE_COMMAND_METHOD).toBe('bridge.updateCommand')
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('bridge.updateCommand', {})
  })

  it('trims the command the host answered', async () => {
    const rpc = vi.fn(async () => '  ./scripts/install.sh\n')

    await expect(fetchUpdateCommand(rpc)).resolves.toEqual({ command: './scripts/install.sh' })
  })

  it('reports an answer that is not a command as an error', async () => {
    // A host that answers a wrapper object, or nothing at all, must not become
    // a copied command.
    for (const answer of [{ command: './scripts/install.sh' }, '', '   ', undefined, null, 42]) {
      const rpc = vi.fn(async () => answer)
      const result = await fetchUpdateCommand(rpc)
      expect(result.command, String(answer)).toBeUndefined()
      expect(result.error, String(answer)).toBeTruthy()
    }
  })

  it('reports a refused method or a dropped connection as an error', async () => {
    // What an old host and a dead socket produce: `bridgeRpc` rejects with the
    // host's own message ("bridge refuses RPC method bridge.updateCommand") or
    // with its own ("Bridge is not connected", a timeout).
    const rpc = vi.fn(async () => { throw new Error('bridge refuses RPC method bridge.updateCommand') })

    await expect(fetchUpdateCommand(rpc)).resolves.toEqual({
      error: 'bridge refuses RPC method bridge.updateCommand',
    })
  })

  it('reports a non-Error rejection as text rather than throwing', async () => {
    const rpc = vi.fn(async () => { throw 'no bridge' })

    await expect(fetchUpdateCommand(rpc)).resolves.toEqual({ error: 'no bridge' })
  })
})
