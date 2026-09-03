/**
 * dsh 0.1.2 Host adapter (slim).
 *
 * The bridge is a pure tool channel, so its only remaining host interaction
 * is the running-session listing that guards `bridge.session.purge` (a purge
 * must never delete the durable files of a live session). Everything the
 * adapter once carried for the chat surface — unary passthrough, Remote Event
 * streams, waterfalls and their responses, workspace/session followers — was
 * deleted with the panel.
 *
 * @module @yuxianglin/dsh-bridge-browser/src/remote-host-api
 */

/** Structural subset of dsh 0.1.2's Host TypertGateway service. */
export interface TypertGatewayLike {
  invoke(request: {
    readonly namespace: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
    readonly signal?: AbortSignal
  }): Promise<unknown>
}

/** One row of the gateway `session.list` projection. */
export interface SessionListEntry {
  readonly sessionId: string
  readonly running: boolean
}

/**
 * List sessions through the gateway `session.list` Remote. Malformed rows are
 * skipped (the purge guard is best-effort); a throwing or mis-shapen listing
 * propagates so the caller can fall back to an unguarded purge.
 *
 * @param gateway - the host TypertGateway service.
 * @param signal - abort for the listing call.
 * @returns the well-formed listing rows.
 */
export async function listRunningSessions(
  gateway: TypertGatewayLike,
  signal: AbortSignal,
): Promise<SessionListEntry[]> {
  const value = await gateway.invoke({
    namespace: 'session',
    method: 'list',
    args: { _request: {} },
    signal,
  })
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new TypeError('session.list returned an invalid listing')
  }
  const entries: SessionListEntry[] = []
  for (const item of value.items) {
    if (isRecord(item) && typeof item.sessionId === 'string' && typeof item.running === 'boolean') {
      entries.push({ sessionId: item.sessionId, running: item.running })
    }
  }
  return entries
}

/** Narrow unknown JSON-like data without accepting arrays. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
