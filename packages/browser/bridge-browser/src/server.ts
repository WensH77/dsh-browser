/**
 * Bridge WebSocket carrier: token-authenticated connection registry and
 * tool-call dispatch to the connected browser extension.
 *
 * The route this server mounts (`/ext/bridge`) lives OUTSIDE the /api trust
 * fence (which only guards the client-connection routes), so the bridge brings
 * its own authentication: a bearer token presented in the `hello` frame within
 * HELLO_TIMEOUT_MS. The bridge is a pure tool channel: it carries no chat,
 * settings, credentials, or gateway passthrough. Five bridge-internal RPCs
 * remain (`bridge.gdrive.moveIntoSession`, `bridge.openGDriveFolder`,
 * `bridge.uiLanguage`, `bridge.toolWaiting`, `bridge.updateCommand`), serviced
 * directly by plugin dependencies or recorded for this connection; every other
 * RPC method is refused.
 *
 * One active connection at a time: a new authenticated socket replaces the
 * previous one (the old socket is closed and its in-flight tool calls settle
 * as `bridge-closed`).
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import {
  BRIDGE_EXTENSION_IDS,
  EXTENSION_UNVERIFIED_CLOSE_CODE,
  BRIDGE_GDRIVE_MOVE_METHOD,
  BRIDGE_OPEN_GDRIVE_FOLDER_METHOD,
  BRIDGE_TOOL_WAITING_METHOD,
  BRIDGE_UI_LANGUAGE_METHOD,
  BRIDGE_UPDATE_COMMAND_METHOD,
  HANDSHAKE_MISMATCH_CLOSE_CODE,
  HELLO_TIMEOUT_MS,
  PING_INTERVAL_MS,
  handshakeRefusal,
  parseBridgeFrame,
  parseToolWaitingPayload,
  parseUiLanguagePayload,
  type BridgeFrame,
  type BridgeCaps,
  type ClientFrame,
  type ToolErrorCode,
  type UiLanguage,
} from './protocol.ts'
import { verifyToken } from './token.ts'
import { currentPlatform, updateCommand } from './update-source.ts'

/** Loopback IPv4/IPv6 literals (IPv4-mapped included). Exported for tests and reuse. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * The extension ID an origin names, or undefined when it names none.
 *
 * A Chromium extension's origin is `chrome-extension://<id>` (or a
 * `chrome-extension://<id>` prefix for its pages). Anything shorter than a full
 * 32-character ID is not an identity — it would match every extension.
 *
 * @param origin - the `Origin` header on the upgrade request.
 * @returns the bare extension ID, or undefined.
 */
export function extensionIdFromOrigin(origin: string): string | undefined {
  const match = /^chrome-extension:\/\/([a-p]{32})(?:\/|$)/.exec(origin)
  return match?.[1]
}

/** Error thrown by requestTool; the tool registry turns it into an isError result. */
export class BridgeToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    /**
     * Whether a page choice would let the caller retry this call successfully;
     * see {@link ToolError.needsPageChoice}. False for every failure this host
     * raises itself — those name a transport or argument problem, not a page.
     */
    readonly needsPageChoice = false,
  ) {
    super(message)
    this.name = 'BridgeToolError'
  }
}

/** Dependencies the bridge needs from the host. */
export interface BridgeServerDeps {
  /** Bearer token the extension must present in `hello`. */
  token: string
  /** Default per-tool-call timeout in ms. */
  toolTimeoutMs: number
  /** Capabilities to echo in `hello.ok` (negotiated snapshot budgets). */
  caps: BridgeCaps
  /** Reveal the GDrive export root in the system file manager. */
  openGDriveFolder: () => void | Promise<void>
  /** Move a finished Google download into ~/.dsh/gdrive/<sessionId>/. */
  gdriveMoveIntoSession: (sourcePath: string, sessionId: string) => Promise<{ filePath: string }>
  /**
   * The command that updates this installation, as `bridge.updateCommand`
   * answers it. Defaults to this install's own command
   * (`updateCommand(currentInstallMode(), currentPlatform())`); the seam exists
   * so a test can answer for a managed and a checkout install without either
   * being on disk. Production never sets it.
   */
  updateCommand?: () => string
  /**
   * Test seam: force the remote address seen by the hello loopback gate. The
   * sandbox cannot bind arbitrary loopback literals, so the non-loopback
   * branch is exercised through this override; production never sets it.
   */
  remoteAddressOverride?: string
  /** Seconds a fresh socket may present `hello`; defaults to HELLO_TIMEOUT_MS. */
  helloTimeoutMs?: number
  /** Server ping cadence; defaults to PING_INTERVAL_MS. */
  pingIntervalMs?: number
  /**
   * Called whenever the connected extension's capabilities change — on hello,
   * on replacement, and on disconnect (undefined). The tool registry uses it to
   * expose debugging tools only while a connection allows them.
   */
  onCapabilities?: (caps: BridgeCaps | undefined) => void
}

/** One in-flight tool call awaiting the extension's `tool.result`. */
interface PendingTool {
  resolve: (result: unknown) => void
  reject: (error: BridgeToolError) => void
  timer: NodeJS.Timeout
  /**
   * Called when the extension reports this call entering or leaving a wait for
   * the user's answer in Chrome; absent when the caller passed none, or when
   * the connected extension cannot report (see
   * {@link BridgeServer.clientReportsWaiting}).
   */
  onWaiting?: (waiting: boolean) => void
}

/** A socket that passed authentication and owns the single active slot. */
interface ReadyConnection {
  ws: WebSocket
  ping: NodeJS.Timeout
}

function sendFrame(ws: WebSocket, frame: BridgeFrame): void {
  /* v8 ignore next -- teardown race: the socket can die between a pump's
  readiness check and this write; the guard refuses writes on dead sockets */
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(frame))
}

/**
 * Decode one ws message payload to text. Exported so all three delivery
 * shapes (fragmented buffer list, Buffer, ArrayBuffer) are unit-testable
 * directly — node ws only ever delivers Buffers in practice.
 * @param data - ws message payload.
 * @returns the decoded UTF-8 text.
 */
export function messageToText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * The update command `bridge.updateCommand` hands the panel's Update button.
 *
 * Sampled per request rather than cached: the platform is a property of the running host,
 * and a caller that asks now must not get a command composed for a different machine.
 *
 * **Always the published installer, by the user's ruling (2026-10-14).** The button used to
 * answer with this installation's own mode — `./scripts/install.sh` for a checkout — and the
 * user asked for the `curl … | bash` line in every case. The trade-off is worth writing down
 * where the code is: on a checkout install that command fetches and runs the *published*
 * installer, so it installs the released tree rather than the local one. To apply local
 * work, run `./scripts/install.sh` from the repository instead (the guide says so).
 *
 * @returns one runnable command line, with no explanation text.
 */
function defaultUpdateCommand(): string {
  return updateCommand('managed', currentPlatform())
}

/**
 * Token-authenticated bridge server. Construct once per plugin instance;
 * dispose with {@link close}.
 */
export class BridgeServer {
  private readonly wss = new WebSocketServer({ noServer: true })
  private current: ReadyConnection | null = null

  /** Capabilities the connected extension reported in its last `hello`. */
  private clientCaps: BridgeCaps | undefined
  /**
   * Language the connected extension reported over `bridge.uiLanguage`.
   *
   * Per connection, like {@link clientCaps}: the extension reports it once per
   * handshake, so a reconnect starts from "unknown" rather than from the
   * previous socket's answer.
   */
  private uiLanguage: UiLanguage | undefined
  private readonly pendingTools = new Map<string, PendingTool>()
  private closed = false

  constructor(private readonly deps: BridgeServerDeps) {}

  /**
   * Handle one HTTP upgrade for the bridge path.
   * @param req - upgrade request (carries the client's remote address).
   * @param socket - raw socket transferred by the HTTP server.
   * @param head - bytes already read after the upgrade headers.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const remote = this.deps.remoteAddressOverride ?? req.socket.remoteAddress
    const origin = req.headers.origin
    this.wss.handleUpgrade(req, socket, head, (ws) => { this.attach(ws, remote, origin) })
  }

  /**
   * Request one browser action from the connected extension.
   * @param name - tool name (also the wire action name).
   * @param args - validated tool arguments.
   * @param signal - caller cancellation (abort settles the call as cancelled).
   * @param timeoutMs - per-call budget; defaults to the plugin config value.
   * @param sessionId - optional owning Agent session for approval continuity.
   * @param onWaiting - called when the extension reports this call entering
   *   (`true`) or leaving (`false`) a wait for the user's answer in Chrome. It
   *   only ever fires on a build that declares
   *   {@link BridgeServer.clientReportsWaiting}; the call itself is unaffected.
   * @returns the extension's action result.
   * @throws BridgeToolError when no extension is connected, the call times
   *   out, is cancelled, or the extension reports a failure.
   */
  requestTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number = this.deps.toolTimeoutMs,
    sessionId?: string,
    onWaiting?: (waiting: boolean) => void,
  ): Promise<unknown> {
    const conn = this.current
    if (conn === null) {
      throw new BridgeToolError('bridge-closed', 'no browser extension is connected to the bridge')
    }
    // A caller that already aborted must not dispatch: the abort listener
    // below does not replay for pre-aborted signals, so the call would be
    // sent to the extension and executed despite the cancellation.
    if (signal.aborted) {
      throw new BridgeToolError('bridge-closed', 'tool call cancelled before dispatch')
    }
    const id = randomUUID()
    const expiresAt = Date.now() + timeoutMs
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout
      const settle = (error: BridgeToolError): void => {
        clearTimeout(timer)
        this.pendingTools.delete(id)
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
      const cancel = (error: BridgeToolError): void => {
        // The extension may be paused on a user approval after the caller has
        // stopped waiting. Withdraw that approval before settling locally so
        // a late click cannot execute an expired action.
        sendFrame(conn.ws, { t: 'tool.cancel', id })
        settle(error)
      }
      const onAbort = (): void => {
        cancel(new BridgeToolError('bridge-closed', 'tool call cancelled before the extension answered'))
      }
      timer = setTimeout(() => {
        // Not "the action failed": this budget is the bridge's own. An unanswered approval no
        // longer lands here at all — the extension answers it at 60 seconds, inside this
        // budget — so what is left is a page that stopped answering, or a card the user
        // answered and an action still running. Say that, and the next step.
        cancel(new BridgeToolError('timeout',
          `browser action "${name}" got no answer within ${timeoutMs}ms — the bridge's own budget (toolTimeoutMs), not a verdict on the action. `
          + 'The page may be stuck, or the action may still be running after a confirmation was answered. '
          + 'Check Chrome (the extension marks a waiting prompt on its toolbar badge), then retry or raise toolTimeoutMs.'))
      }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingTools.set(id, { resolve, reject, timer, ...onWaiting === undefined ? {} : { onWaiting } })
      conn.ws.send(JSON.stringify({
        t: 'tool.call',
        id,
        name,
        args,
        expiresAt,
        ...(sessionId === undefined ? {} : { sessionId }),
      } satisfies BridgeFrame), (error) => {
        /* v8 ignore next -- teardown race: when the write fails, the socket's
        close handler settles the same call with the same code; the callback
        path is a defensive second settle, covered via the close path */
        if (error != null) {
          settle(new BridgeToolError('bridge-closed', `bridge socket failed before delivery: ${error.message}`))
        }
      })
    })
  }

  /**
   * Terminate the server: close the acceptor, drop all sockets, reject all
   * in-flight tool calls.
   * @returns a promise resolving after the acceptor stops.
   */
  async close(): Promise<void> {
    // Idempotent: a second close must not touch the acceptor (ws throws
    // "The server is not running" when closing an already-closed server).
    if (this.closed) return
    this.closed = true
    this.replaceConnection()
    for (const socket of this.wss.clients) socket.terminate()
    this.current = null
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        /* v8 ignore next -- acceptor close cannot fail: close() is idempotent
        and the noServer acceptor only reports teardown of already-terminated clients */
        if (error === undefined) resolve()
        /* v8 ignore next -- same unreachable arm */
        else reject(error)
      })
    })
  }

  /** @returns whether an authenticated extension is currently connected. */
  hasConnection(): boolean {
    return this.current !== null
  }

  private attach(ws: WebSocket, remoteAddress: string | undefined, origin: string | undefined): void {
    let helloTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      ws.close(4001, 'hello timeout')
    }, this.deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS)

    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const text = messageToText(data)
      const frame = parseBridgeFrame(text)
      if (frame === undefined) {
        ws.close(1008, 'unparseable frame')
        return
      }
      if (helloTimer !== undefined) {
        // Pending state: only `hello` is legal.
        if (frame.t !== 'hello') {
          ws.close(1008, 'hello first')
          return
        }
        // Zero-config local mode: loopback sockets skip the token (the
        // extension auto-discovers the bridge and connects without setup).
        // WebSockets have no same-origin policy, so a malicious page could
        // open a cross-origin socket to 127.0.0.1 with a loopback remote —
        // hence the Origin requirement. But `Origin` alone is only a header:
        // a local process can send any string, and every OTHER extension the
        // user has installed can send its own genuine `chrome-extension://<id>`.
        // So the ID itself is pinned to the extension this repo builds
        // (BRIDGE_EXTENSION_IDS, derived from the manifest's public key), and
        // the extension also reports its own `chrome.runtime.id` in `hello` —
        // the two must agree. An extension this repo does not build is absent
        // from BRIDGE_EXTENSION_IDS, so it must present the bearer token instead
        // of inheriting the zero-config path.
        // Non-loopback remotes must present the bearer token as well.
        const loopbackNoToken = isLoopbackAddress(remoteAddress)
          && typeof origin === 'string'
          && (BRIDGE_EXTENSION_IDS as readonly string[]).includes(extensionIdFromOrigin(origin) ?? '')
        if (!loopbackNoToken && !verifyToken(this.deps.token, frame.token)) {
          ws.close(4002, 'bad token')
          return
        }
        // A connection admitted without a token must be the pinned extension,
        // not something that guessed an accepted origin. `extensionId` arrived
        // with `proto` 3; a build too old to send it cannot use the no-token
        // path, which is what the token alternative above is for.
        if (loopbackNoToken && frame.caps.extensionId !== extensionIdFromOrigin(origin ?? '')) {
          // Its own code, not `4002`: the token was fine, the extension just
          // cannot say which extension it is. A build older than protocol 3 has
          // no `extensionId` in its hello, and reloading it is the fix.
          ws.close(EXTENSION_UNVERIFIED_CLOSE_CODE, 'extension did not identify itself: reload it from chrome://extensions')
          return
        }
        // An extension built after this plugin cannot be served: it may rely on
        // frame or argument shapes this build does not know. Refuse with a
        // reason the extension surfaces verbatim, instead of accepting and
        // failing later with an unreadable error.
        const refusal = handshakeRefusal(frame.caps)
        if (refusal !== undefined) {
          clearTimeout(helloTimer)
          helloTimer = undefined
          ws.close(HANDSHAKE_MISMATCH_CLOSE_CODE, refusal)
          return
        }
        clearTimeout(helloTimer)
        helloTimer = undefined
        this.promote(ws, frame.caps)
        return
      }
      this.handleReadyFrame(frame)
    }
    const onClose = (): void => {
      if (helloTimer !== undefined) clearTimeout(helloTimer)
      if (this.current !== null && this.current.ws === ws) this.replaceConnection()
    }
    ws.on('message', onMessage)
    ws.once('close', onClose)
    ws.once('error', onClose)
  }

  /** Promote an authenticated socket to the single active slot. */
  private promote(ws: WebSocket, clientCaps: BridgeCaps): void {
    this.replaceConnection()
    const ping = setInterval(() => { sendFrame(ws, { t: 'ping' }) }, this.deps.pingIntervalMs ?? PING_INTERVAL_MS)
    this.current = { ws, ping }
    this.clientCaps = clientCaps
    this.deps.onCapabilities?.(clientCaps)
    sendFrame(ws, { t: 'hello.ok', caps: this.deps.caps })
    ws.once('close', () => {
      clearInterval(ping)
    })
  }

  /**
   * Whether the connected extension allows browser-debugging capabilities.
   * False when nothing is connected, when the user left the setting off
   * (the default), or when the build has no `chrome.debugger`.
   *
   * @returns true when debugging tools may be exposed and used.
   */
  clientDebugger(): boolean {
    return this.clientCaps?.debugger === true
  }

  /**
   * Whether the connected extension reports when a call is waiting for the
   * user's answer in Chrome ({@link BRIDGE_TOOL_WAITING_METHOD}).
   *
   * False for a build that predates the report, and false with nothing
   * connected: in both cases the host cannot tell an approval wait from an
   * action that is merely slow, so the caller keeps its time-based question
   * rather than staying silent forever.
   *
   * @returns true when this connection's reports can be relied on.
   */
  clientReportsWaiting(): boolean {
    return this.clientCaps?.waitingReport === true
  }

  /**
   * The build version the connected extension reported in its last `hello`, or
   * undefined when nothing is connected or the build is too old to report one.
   *
   * The two undefined cases are deliberately not distinguishable here: the
   * caller compares the version against this plugin's own, and "no connection"
   * is already answered by {@link hasConnection}. Sampling it from
   * `clientCaps` is what gives it {@link clientDebugger}'s lifecycle for free —
   * cleared on disconnect and on replacement, so a stale version can never be
   * read against a socket it did not come from.
   *
   * @returns the reported version, or undefined.
   */
  clientExtensionVersion(): string | undefined {
    return this.clientCaps?.extensionVersion
  }

  /**
   * Language the connected extension's user-facing UI speaks, when it said.
   *
   * The two prompts this plugin raises for a human are worded from it; an
   * extension too old to report (or one that has not reported yet on this
   * connection) leaves it undefined, and those prompts stay English. Cheap and
   * cached: the value is written once per connection by the extension's own
   * report, not fetched per prompt.
   *
   * @returns `'en'`, `'zh'`, or undefined when nothing was reported.
   */
  clientUiLanguage(): UiLanguage | undefined {
    return this.uiLanguage
  }

  private handleReadyFrame(frame: BridgeFrame): void {
    switch (frame.t) {
      case 'rpc':
        void this.handleRpc(frame)
        break
      case 'tool.result':
        this.settleTool(frame.id, frame.ok, frame.ok ? frame.result : frame.error)
        break
      default:
        // Client-only traffic the server must never act on after auth
        // (hello/pong) and unsolicited server-side shapes are ignored; the
        // extension is the only sender on this channel.
        break
    }
  }

  /**
   * Service the bridge-internal RPC methods only; every other method is
   * refused. The bridge carries no gateway passthrough: chat, settings, and
   * credentials all belong to standard dsh clients now.
   */
  private async handleRpc(frame: Extract<ClientFrame, { t: 'rpc' }>): Promise<void> {
    const conn = this.current
    /* v8 ignore next -- replacement race: a frame can land between a socket
    replacement and the next promotion; the re-check keeps the handler total */
    if (conn === null) return
    if (frame.method === BRIDGE_TOOL_WAITING_METHOD) {
      const report = parseToolWaitingPayload(frame.payload)
      if (report === undefined) {
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'bad-request', message: 'id must be a non-empty string and waiting a boolean' } })
        return
      }
      // A report for a call that is no longer in flight (already settled, or
      // cancelled while the card was up) is dropped: the state it describes is
      // over, and inventing a call from it would let a stale report start a
      // prompt for nothing.
      this.pendingTools.get(report.id)?.onWaiting?.(report.waiting)
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: true, result: { id: report.id, waiting: report.waiting } })
      return
    }
    if (frame.method === BRIDGE_UI_LANGUAGE_METHOD) {
      const language = parseUiLanguagePayload(frame.payload)
      if (language === undefined) {
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'bad-request', message: 'language must be "en" or "zh"' } })
        return
      }
      // Recorded for this connection; the plugin reads it when it words a
      // prompt. Nobody waits on the report, but every rpc frame is answered.
      this.uiLanguage = language
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: true, result: { language } })
      return
    }
    if (frame.method === BRIDGE_GDRIVE_MOVE_METHOD) {
      const movePayload = gdriveMovePayload(frame.payload)
      if (movePayload === null) {
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'bad-request', message: 'sourcePath and sessionId must be non-empty strings' } })
        return
      }
      const { sourcePath, sessionId } = movePayload
      try {
        const result = await this.deps.gdriveMoveIntoSession(sourcePath, sessionId)
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: true, result })
      } catch (error: unknown) {
        sendFrame(conn.ws, {
          t: 'rpc.result', id: frame.id, ok: false,
          error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
        })
      }
      return
    }
    if (frame.method === BRIDGE_OPEN_GDRIVE_FOLDER_METHOD) {
      try {
        await this.deps.openGDriveFolder()
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: true, result: { opened: true } })
      } catch (error: unknown) {
        sendFrame(conn.ws, {
          t: 'rpc.result', id: frame.id, ok: false,
          error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
        })
      }
      return
    }
    if (frame.method === BRIDGE_UPDATE_COMMAND_METHOD) {
      // The bare command line, nothing else: the panel puts this on the user's
      // clipboard and the user runs it. `browserUpdateText`'s multi-line
      // explanation is addressed to the model, not to a clipboard.
      sendFrame(conn.ws, {
        t: 'rpc.result',
        id: frame.id,
        ok: true,
        result: (this.deps.updateCommand ?? defaultUpdateCommand)(),
      })
      return
    }
    sendFrame(conn.ws, {
      t: 'rpc.result',
      id: frame.id,
      ok: false,
      error: { code: 'method-not-allowed', message: `bridge refuses RPC method ${frame.method}` },
    })
  }

  private settleTool(id: string, ok: boolean, payload: unknown): void {
    const pending = this.pendingTools.get(id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pendingTools.delete(id)
    if (ok) pending.resolve(payload)
    else pending.reject(new BridgeToolError(payloadCode(payload), payloadMessage(payload), payloadNeedsPageChoice(payload)))
  }

  /** Close the current connection (if any) and settle its in-flight calls. */
  private replaceConnection(): void {
    const hadCaps = this.clientCaps !== undefined
    this.clientCaps = undefined
    // The language belonged to that socket too: the next extension reports its
    // own, and until it does the prompts stay English.
    this.uiLanguage = undefined
    if (hadCaps) this.deps.onCapabilities?.(undefined)
    const conn = this.current
    if (conn === null) return
    this.current = null
    clearInterval(conn.ping)
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(4000, 'replaced')
    }
    for (const [id, pending] of this.pendingTools) {
      clearTimeout(pending.timer)
      this.pendingTools.delete(id)
      pending.reject(new BridgeToolError('bridge-closed', 'the extension connection was replaced'))
    }
  }
}

/**
 * Tool error payload → stable code. The wire parser enforces string fields,
 * so the fallback branches are parser-gated; exported so the fallback
 * contract is unit-testable directly.
 * @param payload - extension-reported error payload.
 * @returns the stable error code.
 */
export function payloadCode(payload: unknown): ToolErrorCode {
  if (typeof payload === 'object' && payload !== null) {
    const code = (payload as { code?: unknown }).code
    if (typeof code === 'string') return code as ToolErrorCode
    return 'internal'
  }
  return 'internal'
}

/**
 * Tool error payload → message. The wire parser enforces string fields, so
 * the fallback branches are parser-gated; exported so the fallback contract
 * is unit-testable directly.
 * @param payload - extension-reported error payload.
 * @returns the human-readable message.
 */
export function payloadMessage(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
    return 'browser action failed'
  }
  return 'browser action failed'
}

/**
 * Tool error payload → whether a page choice resolves it.
 *
 * Strictly `true` on the wire: a build that predates the field sends nothing,
 * and anything else (a string "true", a 1) is read as "not a page problem" so a
 * malformed frame can never send the caller into a bind the extension did not
 * ask for. Exported for the same reason as {@link payloadCode}.
 *
 * @param payload - extension-reported error payload.
 * @returns true only when the extension set the flag.
 */
export function payloadNeedsPageChoice(payload: unknown): boolean {
  return typeof payload === 'object'
    && payload !== null
    && (payload as { needsPageChoice?: unknown }).needsPageChoice === true
}


function gdriveMovePayload(payload: unknown): { sourcePath: string; sessionId: string } | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const { sourcePath, sessionId } = payload as Record<string, unknown>
  if (typeof sourcePath !== 'string' || sourcePath.trim() === ''
    || typeof sessionId !== 'string' || sessionId.trim() === '') return null
  return { sourcePath, sessionId }
}
