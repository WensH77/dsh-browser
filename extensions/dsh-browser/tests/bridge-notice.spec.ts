// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { BRIDGE_PROTO } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { bridgeNotice } from '../src/background/bridge-notice.ts'
import type { BridgeNotice } from '../src/background/bridge.ts'

const caps = (proto?: number) => ({ ...(proto === undefined ? {} : { proto }), snapshotMaxChars: 32_000, maxInteractiveItems: 60 })

describe('bridgeNotice', () => {
  it('shows the handshake failure while no connection is established', () => {
    const failure: BridgeNotice = { kind: 'host-silent', detail: 'no hello.ok within 5s' }
    expect(bridgeNotice('reconnecting', null, failure)).toEqual(failure)
    expect(bridgeNotice('connecting', caps(BRIDGE_PROTO), failure)).toEqual(failure)
    expect(bridgeNotice('stopped', null, null)).toBeNull()
  })

  it('reports each version skew direction once connected', () => {
    expect(bridgeNotice('connected', caps(BRIDGE_PROTO), null)).toBeNull()
    expect(bridgeNotice('connected', caps(), null)).toEqual({ kind: 'host-older', detail: `plugin protocol ${BRIDGE_PROTO - 1}` })
    expect(bridgeNotice('connected', caps(BRIDGE_PROTO + 1), null)).toEqual({ kind: 'host-newer', detail: `plugin protocol ${BRIDGE_PROTO + 1}` })
  })

  it('replaces a stale handshake failure with the skew of the live connection', () => {
    const failure: BridgeNotice = { kind: 'host-silent', detail: 'closed with 1008 unparseable frame' }
    expect(bridgeNotice('connected', caps(BRIDGE_PROTO), failure)).toBeNull()
    expect(bridgeNotice('connected', caps(), failure)).toEqual({ kind: 'host-older', detail: `plugin protocol ${BRIDGE_PROTO - 1}` })
  })
})
