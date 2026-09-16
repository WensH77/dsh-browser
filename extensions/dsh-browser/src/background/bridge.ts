/**
 * Bridge WebSocket client (background side): connects to the dsh bridge,
 * authenticates with the bearer token, keeps the connection alive with
 * exponential-backoff reconnects, and answers protocol pings.
 *
 * The reconnect policy mirrors the dsh GUI's own ConnectionController: base
 * 500ms, ×2 per attempt, capped at 10s, jittered 0.5–1×.
 *
 * @module
 */

import type { BridgeCaps, ClientFrame, ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import {
  BRIDGE_PROTO,
  BRIDGE_TOOLSET,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  HANDSHAKE_MISMATCH_CLOSE_CODE,
  isServerFrame,
  parseBridgeFrame,
} from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { visionAvailable } from './capture.ts'

/** Coarse connection state for the UI. */
export type BridgeState = 'connecting' | 'connected' | 'reconnecting' | 'stopped'

/**
 * A handshake-level problem worth showing the user. Two builds that disagree
 * about the protocol cannot be diagnosed from the model's side: the frames
 * either fail to parse or carry arguments the other half never implemented.
 */
export interface BridgeNotice {
  /**
   * `host-rejected` — this host refused the handshake and named the fix;
   * `host-silent` — the socket opened but no `hello.ok` came back (typical of a
   * dsh build older than this extension); `host-older` — the handshake worked
   * but the plugin speaks an older protocol, so its tools and descriptions are
   * not in play yet; `host-newer` — the plugin is newer than this extension, so
   * reloading the extension is what brings its tools into play.
   */
  kind: 'host-rejected' | 'host-silent' | 'host-older' | 'host-newer'
  /** Verbatim detail from the host (close code/reason), when there is one. */
  detail?: string
}

/** Frame/state sinks owned by the background assembly. */
export interface BridgeSinks {
  onStateChange(state: BridgeState): void
  onFrame(frame: ServerFrame): void
  onHelloOk(caps: BridgeCaps): void
  /** Report a handshake-level problem, or null once a handshake succeeds. */
  onNotice(notice: BridgeNotice | null): void
}

/** Resolve whether opening a WebSocket is expected to succeed. */
type BridgeProbe = (url: string) => Promise<boolean>

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 10_000
const HELLO_ACK_TIMEOUT_MS = 5_000

/**
 * Owns one WebSocket connection generation and the reconnect loop.
 */
export class BridgeClient {
  private ws: WebSocket | null = null
  private attempt = 0
  private running = false
  /** Per-start generation token: a new start() invalidates any in-flight loop. */
  private generation = 0
  private url = ''
  private token = ''
  private ackTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly sinks: BridgeSinks,
    private readonly probe: BridgeProbe = async () => true,
    /** Whether the user allowed browser debugging; read at every handshake. */
    private readonly debugEnabled: () => boolean = () => false,
  ) {}

  /** Current coarse state (mirrors the last emitted sink value). */
  state: BridgeState = 'stopped'

  /**
   * Connect (or reconnect) to the bridge. Idempotent: calling again with the
   * same url/token restarts the loop from attempt 0.
   * @param url - bridge WebSocket URL (e.g. ws://127.0.0.1:3080/ext/bridge).
   * @param token - bearer token from settings.
   */
  start(url: string, token: string): void {
    this.stop()
    this.url = url
    this.token = token
    this.running = true
    this.attempt = 0
    this.generation += 1
    void this.loop(this.generation)
  }

  /** Stop the loop and close the current socket. */
  stop(): void {
    this.running = false
    this.clearAckTimer()
    this.ws?.close()
    this.ws = null
    this.emitState('stopped')
  }

  /** Whether a frame can be sent right now. */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /**
   * Send one client frame.
   * @param frame - frame to send.
   * @returns false when no live socket exists.
   */
  send(frame: ClientFrame): boolean {
    const socket = this.ws
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }

  private async loop(generation: number): Promise<void> {
    while (this.running && generation === this.generation) {
      const reachable = await this.probe(this.url).catch(() => false)
      if (!this.running || generation !== this.generation) return
      if (!reachable) {
        this.emitState('reconnecting')
        await this.waitBeforeRetry()
        continue
      }

      const socket = new WebSocket(this.url)
      this.ws = socket
      // A replacement is an ownership handoff, not a transient transport
      // failure. Yield permanently so two open profiles cannot reconnect in a
      // tight loop and repeatedly evict one another.
      socket.addEventListener('close', (event) => {
        if (event.code !== 4000 || this.ws !== socket || !this.running) return
        this.running = false
        this.clearAckTimer()
        this.ws = null
        this.emitState('stopped')
      }, { once: true })
      this.emitState('connecting')

      await new Promise<void>((resolve) => {
        socket.addEventListener('open', () => { resolve() }, { once: true })
        socket.addEventListener('close', () => { resolve() }, { once: true })
        socket.addEventListener('error', () => { resolve() }, { once: true })
      })
      if (!this.running || generation !== this.generation) {
        socket.close()
        return
      }
      if (socket.readyState !== WebSocket.OPEN) {
        await this.fail(socket)
        continue
      }

      // Authenticate: hello must be accepted before any other traffic. `proto`
      // and `toolset` let both halves detect a mismatched build instead of
      // failing later on an argument the other side never implemented.
      socket.send(JSON.stringify({
        t: 'hello',
        token: this.token,
        caps: {
          proto: BRIDGE_PROTO,
          toolset: BRIDGE_TOOLSET,
          debugger: this.debugEnabled() && visionAvailable(),
          snapshotMaxChars: DEFAULT_SNAPSHOT_MAX_CHARS,
          maxInteractiveItems: 60,
        },
      } satisfies ClientFrame))

      let authed = false
      let refusal: { code: number; reason: string } | undefined
      let ackTimedOut = false
      const accepted = await new Promise<boolean>((resolve) => {
        const onMessage = (event: MessageEvent): void => {
          const frame = parseBridgeFrame(String(event.data))
          if (frame === undefined) return
          if (!authed) {
            if (frame.t === 'hello.ok') {
              authed = true
              this.clearAckTimer()
              resolve(true)
              // Caps first, then clear the notice: the background derives the
              // "host is older" case from the caps it just stored, so the last
              // state broadcast reflects the handshake that actually succeeded.
              this.sinks.onHelloOk(frame.caps)
              this.sinks.onNotice(null)
            } else if (frame.t === 'rpc.result') {
              this.sinks.onFrame(frame)
            }
            return
          }
          if (frame.t === 'ping') {
            socket.send(JSON.stringify({ t: 'pong' } satisfies ClientFrame))
            return
          }
          if (isServerFrame(frame)) this.sinks.onFrame(frame)
        }
        socket.addEventListener('message', onMessage)
        socket.addEventListener('close', (event) => {
          this.clearAckTimer()
          refusal = { code: event.code, reason: event.reason }
          resolve(false)
        }, { once: true })
        this.ackTimer = setTimeout(() => {
          ackTimedOut = true
          resolve(false)
        }, HELLO_ACK_TIMEOUT_MS)
      })
      if (!accepted || !this.running || generation !== this.generation) {
        // A stop() or a newer generation is not a handshake failure: only a
        // live attempt that got no `hello.ok` earns a notice.
        if (this.running && generation === this.generation) {
          this.sinks.onNotice(handshakeNotice(refusal, ackTimedOut))
        }
        await this.fail(socket)
        continue
      }

      this.attempt = 0
      this.emitState('connected')

      await new Promise<void>((resolve) => {
        socket.addEventListener('close', () => resolve(), { once: true })
        socket.addEventListener('error', () => resolve(), { once: true })
      })
      if (!this.running || generation !== this.generation) {
        socket.close()
        return
      }
      await this.fail(socket)
    }
  }

  private async fail(socket: WebSocket): Promise<void> {
    if (this.ws === socket) this.ws = null
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close()
    }
    if (!this.running) return
    this.emitState('reconnecting')
    await this.waitBeforeRetry()
  }

  private async waitBeforeRetry(): Promise<void> {
    this.attempt += 1
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, this.attempt - 1))
    const delay = cap / 2 + Math.random() * (cap / 2)
    await new Promise<void>((resolve) => { setTimeout(resolve, delay) })
  }

  private clearAckTimer(): void {
    if (this.ackTimer !== undefined) {
      clearTimeout(this.ackTimer)
      this.ackTimer = undefined
    }
  }

  private emitState(state: BridgeState): void {
    this.state = state
    this.sinks.onStateChange(state)
  }
}

/**
 * Turn a failed handshake into one message the user can act on. The host's own
 * close reason is kept verbatim: when this plugin refuses a newer extension it
 * names the fix, and when it never answers the likely cause is an older build.
 *
 * @param refusal - close code/reason seen before the hello was acknowledged.
 * @param ackTimedOut - true when nothing at all came back within the budget.
 * @returns the notice to surface.
 */
export function handshakeNotice(
  refusal: { code: number; reason: string } | undefined,
  ackTimedOut: boolean,
): BridgeNotice {
  if (refusal !== undefined && refusal.code === HANDSHAKE_MISMATCH_CLOSE_CODE) {
    return { kind: 'host-rejected', detail: refusal.reason }
  }
  if (refusal !== undefined) {
    return { kind: 'host-silent', detail: `closed with ${refusal.code}${refusal.reason === '' ? '' : ` ${refusal.reason}`}` }
  }
  return { kind: 'host-silent', detail: ackTimedOut ? 'no hello.ok within 5s' : 'the socket closed before hello.ok' }
}
