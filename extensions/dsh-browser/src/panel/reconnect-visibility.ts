/**
 * When the panel offers its manual Reconnect button.
 *
 * The bridge keeps one authenticated slot, and the socket that loses it is
 * closed with code 4000; the client reads that as the terminal `stopped` state
 * and its keepalive deliberately does not retry. The button is the way out
 * without reloading the extension.
 *
 * No other state shows it. `BridgeClient.start()` begins with `teardown()`, so
 * pressing Reconnect while `connected` silently drops a healthy socket and its
 * in-flight calls; that path cancels nothing. `connecting` and `reconnecting`
 * already run a live retry loop, so the button there would only restart a
 * retry that is already under way.
 *
 * Kept out of the JSX so the rule is unit-testable — this repository has no
 * React render tests.
 *
 * @module
 */

/**
 * Whether the panel should render the manual reconnect.
 *
 * @param state - the panel's `ui.bridgeState` value.
 * @returns true only for the terminal `stopped` state.
 */
export function showsReconnect(state: string): boolean {
  return state === 'stopped'
}
