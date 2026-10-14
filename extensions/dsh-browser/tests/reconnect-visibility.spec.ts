/**
 * The Reconnect button's rule, one case per `ui.bridgeState` value.
 *
 * The button is only a way out of the terminal `stopped` state (socket closed
 * with code 4000: the bridge's single slot went to another client). In every
 * other state it either tears down something healthy or restarts a retry that
 * is already running, so the panel must not render it there.
 */

import { describe, expect, it } from 'vitest'
import { showsReconnect } from '../src/panel/reconnect-visibility.ts'

describe('showsReconnect', () => {
  it('shows it in the terminal stopped state', () => {
    expect(showsReconnect('stopped')).toBe(true)
  })

  it('hides it while the socket is healthy', () => {
    // `BridgeClient.start()` tears the current socket down first, so offering
    // the button here would drop a working connection and lose its in-flight
    // calls.
    expect(showsReconnect('connected')).toBe(false)
  })

  it('hides it during the first connect and during a retry', () => {
    // Both already have a retry loop running; the button would only restart it.
    expect(showsReconnect('connecting')).toBe(false)
    expect(showsReconnect('reconnecting')).toBe(false)
  })

  it('hides it for a state this build does not know', () => {
    // A newer worker with another state must not get a button whose meaning
    // this build cannot judge; only the one state the client calls terminal
    // qualifies.
    expect(showsReconnect('paused')).toBe(false)
    expect(showsReconnect('')).toBe(false)
  })
})
