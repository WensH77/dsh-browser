/**
 * Decide which handshake problem, if any, the UI should show.
 *
 * Two independent sources feed this: a failed handshake reported by the bridge
 * client, and the protocol version a *connected* host echoes in `hello.ok`. The
 * combination is a pure function so every skew direction is unit-testable — the
 * three real-world mismatches (host silent, host older, extension older) all
 * looked like unrelated mysteries at the time.
 *
 * @module
 */

import { BRIDGE_PROTO, declaredProto, type BridgeCaps } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { BridgeNotice, BridgeState } from './bridge.ts'

/**
 * The notice to show, or null when both halves agree.
 *
 * @param state - current bridge connection state.
 * @param caps - capabilities the connected host echoed, or null.
 * @param handshake - last handshake failure reported by the client.
 * @returns the notice, or null.
 */
export function bridgeNotice(
  state: BridgeState,
  caps: BridgeCaps | null,
  handshake: BridgeNotice | null,
): BridgeNotice | null {
  if (state !== 'connected') return handshake
  const hostProto = declaredProto(caps ?? undefined)
  if (hostProto < BRIDGE_PROTO) return { kind: 'host-older', detail: `plugin protocol ${hostProto}` }
  if (hostProto > BRIDGE_PROTO) return { kind: 'host-newer', detail: `plugin protocol ${hostProto}` }
  return null
}
