// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { BRIDGE_PROTO, BRIDGE_TOOLSET, LEGACY_PROTO } from 'dsh-bridge-browser/src/protocol.ts'
import { bridgeNotice } from '../src/background/bridge-notice.ts'
import type { BridgeNotice } from '../src/background/bridge.ts'

const caps = (proto?: number) => ({ ...(proto === undefined ? {} : { proto }), snapshotMaxChars: 32_000, maxInteractiveItems: 60 })
const toolsetCaps = (toolset?: number) => ({
  proto: BRIDGE_PROTO,
  ...(toolset === undefined ? {} : { toolset }),
  snapshotMaxChars: 32_000,
  maxInteractiveItems: 60,
})

describe('bridgeNotice', () => {
  it('shows the handshake failure while no connection is established', () => {
    const failure: BridgeNotice = { kind: 'host-silent', detail: 'no hello.ok within 5s' }
    expect(bridgeNotice('reconnecting', null, failure)).toEqual(failure)
    expect(bridgeNotice('connecting', caps(BRIDGE_PROTO), failure)).toEqual(failure)
    expect(bridgeNotice('stopped', null, null)).toBeNull()
  })

  it('reports each version skew direction once connected', () => {
    expect(bridgeNotice('connected', caps(BRIDGE_PROTO), null)).toBeNull()
    // A host that sends no `proto` predates versioning: read as LEGACY_PROTO
    // (the handshake's own lowest version), not as "one below the current one".
    expect(bridgeNotice('connected', caps(), null)).toEqual({ kind: 'host-older', detail: `plugin protocol ${LEGACY_PROTO}` })
    expect(bridgeNotice('connected', caps(BRIDGE_PROTO + 1), null)).toEqual({ kind: 'host-newer', detail: `plugin protocol ${BRIDGE_PROTO + 1}` })
  })

  it('names the toolset gap in both directions, because the fix differs', () => {
    expect(bridgeNotice('connected', toolsetCaps(BRIDGE_TOOLSET), null)).toBeNull()
    // Host newer than this extension: its newest tools are missing from the
    // catalog, and reloading the extension is what brings them back.
    expect(bridgeNotice('connected', toolsetCaps(BRIDGE_TOOLSET + 1), null))
      .toEqual({ kind: 'host-newer', detail: `plugin toolset ${BRIDGE_TOOLSET + 1}` })
    // Host older: restarting dsh is the fix, so it must not say "reload".
    expect(bridgeNotice('connected', toolsetCaps(BRIDGE_TOOLSET - 1), null))
      .toEqual({ kind: 'host-older', detail: `plugin toolset ${BRIDGE_TOOLSET - 1}` })
    // A host that predates the field reports its protocol instead of being read
    // as toolset 0, which would name the wrong fix for the same skew.
    expect(bridgeNotice('connected', toolsetCaps(), null)).toBeNull()
  })

  it('reports a protocol mismatch ahead of a toolset gap', () => {
    expect(bridgeNotice('connected', { ...toolsetCaps(BRIDGE_TOOLSET), proto: BRIDGE_PROTO + 1 }, null))
      .toEqual({ kind: 'host-newer', detail: `plugin protocol ${BRIDGE_PROTO + 1}` })
  })

  it('replaces a stale handshake failure with the skew of the live connection', () => {
    const failure: BridgeNotice = { kind: 'host-silent', detail: 'closed with 1008 unparseable frame' }
    expect(bridgeNotice('connected', caps(BRIDGE_PROTO), failure)).toBeNull()
    expect(bridgeNotice('connected', caps(), failure)).toEqual({ kind: 'host-older', detail: `plugin protocol ${LEGACY_PROTO}` })
  })
})
