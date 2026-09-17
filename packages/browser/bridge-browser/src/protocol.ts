/**
 * Wire contract between the dsh bridge plugin and the browser extension.
 *
 * Zero-dependency module (pure types, constants, and a parser): both the
 * plugin (node) and the Chrome extension (browser bundle) import this file, so
 * the frame shapes can never drift between the two halves.
 *
 * Frames are one JSON object per WebSocket message, discriminated by `t`.
 * Correlation ids (`id`) are minted by the requestor and echoed by the
 * responder; they are opaque strings, never parsed.
 *
 * @module
 */

/** WebSocket pathname the bridge plugin registers on the host webserver. */
export const BRIDGE_PATH = '/ext/bridge'

/** Zero-config discovery endpoint: returns `{ wsUrl }` for the extension. */
export const BRIDGE_CONFIG_PATH = '/ext/bridge-config'

/** Internal RPC used by the options page to reveal the GDrive export root. */
export const BRIDGE_OPEN_GDRIVE_FOLDER_METHOD = 'bridge.openGDriveFolder'

/** Internal RPC used by the extension to move a finished download into the session folder. */
export const BRIDGE_GDRIVE_MOVE_METHOD = 'bridge.gdrive.moveIntoSession'

/**
 * Extension IDs the bridge accepts on its loopback no-token path.
 *
 * A Chromium extension's origin is `chrome-extension://<32-char id>`, so the ID
 * is the only part of a WebSocket `Origin` header that can distinguish one
 * extension from another. Accepting any `chrome-extension://` prefix (the
 * previous behaviour) accepted every extension the user has installed, each of
 * which can present its own genuine origin — and a local process can present
 * any string at all.
 *
 * The ID is not a secret and not a cryptographic proof: it is derived from the
 * public key in the extension manifest, so it is stable across installs and
 * re-derivable with `scripts/extension-id.mjs` (a test asserts the two agree).
 * Pinning it closes the "any extension, no credentials" hole; a local process
 * that knows the ID can still forge the header, which is why the loopback path
 * remains a convenience and not an authentication boundary.
 */
export const BRIDGE_EXTENSION_IDS = ['edihbhncneajmmoomljfjacbhelaipgc'] as const

/** Shape of an extension ID: 32 characters in the `a`-`p` alphabet. */
export const EXTENSION_ID_PATTERN = /^[a-p]{32}$/

/**
 * Tools that need `chrome.debugger`.
 *
 * Both halves need this list and neither may drift from the other: the host
 * registers exactly these tools (and only while the connected extension reports
 * `debugger: true`), and the extension refuses exactly these names when the
 * user's "allow browser debugging" setting is off. It lives in the shared wire
 * contract for the same reason the frame shapes do — a tool added on one side
 * and forgotten on the other would either be exposed without consent or refuse
 * itself while enabled.
 */
export const DEBUG_TOOL_NAMES = [
  'browser_capture',
  'browser_console',
  'browser_network',
  'browser_eval',
  'browser_dialog',
] as const

/**
 * How many open pages `browser_list_tabs` reports, and how many of them the
 * host offers in the binding question.
 *
 * One constant because the two numbers have to match: the extension renders the
 * list and the host parses it back, so a lower cap on either side silently hides
 * pages from the user with no sign that anything was dropped.
 */
export const MAX_BINDABLE_TABS = 60

/**
 * Render one bindable page as a line of the `browser_list_tabs` answer.
 *
 * Producer and consumer share this: the host parses exactly this shape back, so
 * a format change on one side used to leave the other returning an empty list —
 * which reads to the model as "no pages are open" rather than as a parse miss.
 * The title may itself contain ` | `; the parser takes the last field as the URL
 * and everything between the first two separators as the title.
 *
 * @param tab - the page to describe.
 * @returns one `ID=<n> | <title> | <url>` line.
 */
export function formatBindableTab(tab: { id: number; title?: string; url?: string }): string {
  return `ID=${tab.id} | ${tab.title ?? ''} | ${tab.url ?? ''}`
}

/** Parse the `browser_list_tabs` answer back into entries. */
export function parseBindableTabs(text: unknown): Array<{ id: number; title: string; url: string }> {
  if (typeof text !== 'string') return []
  const entries: Array<{ id: number; title: string; url: string }> = []
  for (const line of text.split('\n')) {
    // The title may be empty (a tab that has not set one yet); requiring a
    // character silently dropped the whole entry.
    const match = /^ID=(\d+) \| (.*?) \| (\S+)$/.exec(line.trim())
    if (match === null) continue
    const id = Number(match[1])
    if (Number.isInteger(id) && id >= 0) entries.push({ id, title: match[2] ?? '', url: match[3]! })
  }
  return entries
}

/** Hosts whose `/document/d/…` and `/spreadsheets/d/…` paths this tool can export. */
export const GDRIVE_EXPORT_HOSTS = ['docs.google.com', 'spreadsheets.google.com', 'drive.google.com'] as const

/** What to tell the model about a Google link that is not an exportable Doc or Sheet. */
export const GDRIVE_UNSUPPORTED_HINT = 'google_drive_export only handles Google Docs (/document/d/…) and Sheets (/spreadsheets/d/…) links. '
  + 'For Slides, Drive files, or any other link, read it in the browser instead: browser_navigate to it, then browser_snapshot, '
  + 'browser_capture, or browser_dom_query.'

/**
 * Which exportable kind a Google link addresses, if any.
 *
 * Both halves classify the same links — the host to decide whether to dispatch
 * the export at all, the extension to build the export URL — and each used to
 * carry its own host list and path patterns. They agreed, but only by
 * maintenance; a change to one would send the model a link the other refused.
 *
 * @param url - the link to classify.
 * @returns `docs`, `sheets`, or undefined when it is neither.
 */
export function gdriveExportKind(url: string): 'docs' | 'sheets' | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (!(GDRIVE_EXPORT_HOSTS as readonly string[]).includes(parsed.hostname.toLowerCase())) return undefined
  if (/\/document\/d\/[^/?#]+/.test(parsed.pathname)) return 'docs'
  if (/\/spreadsheets\/d\/[^/?#]+/.test(parsed.pathname)) return 'sheets'
  return undefined
}

/** Characters a fresh socket may take to present `hello` before it is closed. */
export const HELLO_TIMEOUT_MS = 5_000

/**
 * Handshake protocol version.
 *
 * `1` is the unversioned era — a peer that sends no `proto` field. `2` is the
 * first versioned handshake: `hello`/`hello.ok` carry `proto` and `toolset`,
 * and the `textOnly` compatibility marker is gone. `3` adds `extensionId`, the
 * extension's own recorded identity, so the host can check that the socket
 * carrying tool calls belongs to the extension it pinned rather than merely
 * some origin claiming `chrome-extension://`. Bump this only for a change both
 * halves must agree on; additive capabilities belong in `toolset`.
 */
export const BRIDGE_PROTO = 3

/** Peer protocol assumed when `caps.proto` is absent. */
export const LEGACY_PROTO = 1

/**
 * Feature level an extension implements; each level is a superset of the one
 * below. `0` — the level assumed when `caps.toolset` is absent — is index-only
 * targets with no `browser_dom_query` / `browser_block` / `browser_headers`;
 * {@link TOOLSET_SELECTOR_TARGETS} adds those and CSS `selector` targets;
 * {@link TOOLSET_TEXT_FIND} adds text search to `browser_get_text`;
 * {@link TOOLSET_PAGE_IMAGE} adds `browser_image` (a page picture by
 * reference); {@link TOOLSET_POINTER_CLICK} adds `browser_click_pointer`.
 *
 * A tool whose action the old build has no wire case for must be gated at the
 * level that ships it: exposing it to an older extension trades a smaller tool
 * surface, which the model can see, for an "Unknown action" failure, which it
 * cannot anticipate.
 */
export const BRIDGE_TOOLSET = 4

/** Level that first resolves CSS `selector` targets and ships the DOM/rule tools. */
export const TOOLSET_SELECTOR_TARGETS = 1

/** Level that first lets `browser_get_text` search page text (`find`). */
export const TOOLSET_TEXT_FIND = 2

/** Level that first ships `browser_image`, a page picture by reference. */
export const TOOLSET_PAGE_IMAGE = 3

/** Level that first ships `browser_click_pointer`, the full press sequence. */
export const TOOLSET_POINTER_CLICK = 4

/** Feature level assumed when `caps.toolset` is absent. */
export const LEGACY_TOOLSET = 0

/**
 * WebSocket close code for a handshake this build cannot satisfy (the peer
 * speaks a newer protocol). The reason string is shown to the user verbatim,
 * so it must stay within the 123-byte close-reason limit and name the fix.
 */
export const HANDSHAKE_MISMATCH_CLOSE_CODE = 4_003

/**
 * WebSocket close code for a connection this build refused after the token
 * check: the socket claimed an accepted extension origin, but its `hello` did
 * not corroborate it.
 *
 * Distinct from the `4002` "bad token" close on purpose. Both end the handshake,
 * but they have different fixes — a bad token means fix the token, while this is
 * what a build older than protocol 3 hits when it cannot identify itself (its
 * hello carries no `caps.extensionId`), and its fix is to reload the extension.
 * Sharing one code made the extension tell the user to restart dsh for a
 * mismatch that only a reload resolves.
 */
export const EXTENSION_UNVERIFIED_CLOSE_CODE = 4_004

/** Server-side ping cadence; the client answers `pong` to prove liveness. */
export const PING_INTERVAL_MS = 30_000

/** Default bytes of the generated bearer token (256-bit). */
export const DEFAULT_TOKEN_BYTES = 32

/** Default rendered-snapshot character budget. */
export const DEFAULT_SNAPSHOT_MAX_CHARS = 32_000

/** Smallest snapshot budget that can carry both trust boundaries and page text. */
export const MIN_SNAPSHOT_MAX_CHARS = 500

/** Error codes a tool call may settle with. Open set: consumers must tolerate unknown codes. */
export type ToolErrorCode =
  | 'no-active-tab'
  | 'content-unavailable'
  | 'action-failed'
  | 'unsupported'
  | 'timeout'
  | 'bridge-closed'
  | 'bad-args'
  | 'internal'

/** One tool-call failure: stable machine code plus human text for the model. */
export interface ToolError {
  code: ToolErrorCode
  message: string
}

/** Capabilities negotiated in `hello`/`hello.ok`. The extension performs its own actions; these bounds shape page snapshots. */
export interface BridgeCaps {
  /**
   * Handshake protocol version of the sender. Absent on builds from before
   * versioning, which are read as {@link LEGACY_PROTO}.
   */
  proto?: number
  /**
   * Extension feature level (only the extension sends it). Absent means the
   * extension predates the field: read it as {@link LEGACY_TOOLSET} and expose
   * only the tools and parameters that level implements.
   */
  toolset?: number
  /**
   * The user allowed dsh to use browser-debugging capabilities on this
   * extension (`chrome.debugger` present AND the extension's own setting on).
   * Absent or false means the debugging tools must not be exposed at all:
   * screenshots, console, network, response overrides, and page evaluation.
   */
  debugger?: boolean
  /**
   * The extension's own ID (`chrome.runtime.id`), asserted by the extension.
   * The host checks it against {@link BRIDGE_EXTENSION_IDS} so a socket that
   * merely claims a `chrome-extension://` origin cannot take the tool slot.
   * Absent on builds from before `proto` 3; those are rejected only on the
   * no-token loopback path, which is the path this guards.
   */
  extensionId?: string
  /** Upper bound on one rendered snapshot's characters (plugin config, minimum 500). */
  snapshotMaxChars: number
  /** Upper bound on interactive inventory items per snapshot (plugin config). */
  maxInteractiveItems: number
}

/** Media types a capture may declare on the wire. */
export type CapturedImageMediaType = 'image/png' | 'image/jpeg'

/** One captured raster travelling as base64 over the bridge; bytes are never written to disk by either half. */
export interface CapturedImage {
  /** Canonical base64 of the encoded image. */
  dataBase64: string
  mediaType: CapturedImageMediaType
  /** Intrinsic encoded width in CSS pixels. */
  width: number
  /** Intrinsic encoded height in CSS pixels. */
  height: number
  /** Encoded byte length. */
  bytes: number
}

/** Storage bounds the host applies to one attached image; the extension downscales to fit. */
export interface CaptureLimits {
  /** Maximum encoded bytes. */
  maxBytes: number
  /** Maximum decoded width multiplied by height. */
  maxPixels: number
  /** Maximum intrinsic width and height. */
  maxDimension: number
}

/** Capture arguments the host adds to `tool.call` frames beyond the model's own arguments. */
export interface CaptureRequest {
  /** Capture the whole scrollable page instead of the viewport. */
  fullPage?: boolean
  /** Encoded image format; `jpeg` is lossy and honours `quality`. */
  format?: 'png' | 'jpeg'
  /** JPEG quality (1-100). */
  quality?: number
  limits?: CaptureLimits
}

/** Frames sent by the extension to the bridge plugin. */
export type ClientFrame =
  /** First frame, within HELLO_TIMEOUT_MS of socket open. */
  | { t: 'hello'; token: string; caps: BridgeCaps }
  /** Unary bridge Host call (the Host adapter projects these onto dsh 0.1.2 Remotes). */
  | { t: 'rpc'; id: string; method: string; payload: unknown }
  /** Result of a previously dispatched tool call. */
  | { t: 'tool.result'; id: string; ok: true; result: unknown }
  | { t: 'tool.result'; id: string; ok: false; error: ToolError }
  /** Liveness reply. */
  | { t: 'pong' }

/** Frames sent by the bridge plugin to the extension. */
export type ServerFrame =
  /** Accepted after a valid `hello`. */
  | { t: 'hello.ok'; caps: BridgeCaps }
  /** Reply to an `rpc` frame; `result` is the bridge's stable ServerResponse envelope. */
  | { t: 'rpc.result'; id: string; ok: true; result: unknown }
  | { t: 'rpc.result'; id: string; ok: false; error: { code: string; message: string } }
  /** A model-requested browser action to execute in the user-controlled tab. */
  | { t: 'tool.call'; id: string; name: string; args: Record<string, unknown>; expiresAt: number; sessionId?: string }
  /** Withdraw a tool call that timed out or whose caller was cancelled. */
  | { t: 'tool.cancel'; id: string }
  /** Liveness probe. */
  | { t: 'ping' }

/** Any frame on the wire. */
export type BridgeFrame = ClientFrame | ServerFrame

/**
 * Type guard: is this frame one the SERVER may send? Client-only shapes
 * (hello/tool.result/pong) narrow out, so server-side consumers never
 * dispatch on their own request vocabulary.
 * @param frame - parsed frame.
 * @returns true for server-sendable frames.
 */
export function isServerFrame(frame: BridgeFrame): frame is ServerFrame {
  return frame.t === 'hello.ok'
    || frame.t === 'rpc.result'
    || frame.t === 'tool.call'
    || frame.t === 'tool.cancel'
    || frame.t === 'ping'
}


/**
 * Parse one WebSocket message into a frame.
 * @param text - raw message text.
 * @returns the frame, or `undefined` when the message is not a valid frame.
 */
export function parseBridgeFrame(text: string): BridgeFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const frame = value as Record<string, unknown>
  if (typeof frame.t !== 'string') return undefined
  switch (frame.t) {
    case 'hello':
      return typeof frame.token === 'string'
        && isCaps(frame.caps)
        ? { t: 'hello', token: frame.token, caps: frame.caps }
        : undefined
    case 'rpc':
      return typeof frame.id === 'string' && typeof frame.method === 'string'
        ? { t: 'rpc', id: frame.id, method: frame.method, payload: frame.payload }
        : undefined
    case 'tool.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'tool.result', id: frame.id, ok: true, result: frame.result }
      }
      return isToolError(frame.error)
        ? { t: 'tool.result', id: frame.id, ok: false, error: frame.error }
        : undefined
    case 'pong':
      return { t: 'pong' }
    case 'hello.ok':
      return isCaps(frame.caps)
        ? { t: 'hello.ok', caps: frame.caps }
        : undefined
    case 'rpc.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'rpc.result', id: frame.id, ok: true, result: frame.result }
      }
      return typeof frame.error === 'object' && frame.error !== null
        ? { t: 'rpc.result', id: frame.id, ok: false, error: frame.error as { code: string; message: string } }
        : undefined
    case 'tool.call':
      if (frame.sessionId !== undefined
        && (typeof frame.sessionId !== 'string' || frame.sessionId.trim() === '')) return undefined
      return typeof frame.id === 'string' && typeof frame.name === 'string'
        && typeof frame.args === 'object' && frame.args !== null && !Array.isArray(frame.args)
        && typeof frame.expiresAt === 'number' && Number.isFinite(frame.expiresAt) && frame.expiresAt > 0
        ? {
            t: 'tool.call',
            id: frame.id,
            name: frame.name,
            args: frame.args as Record<string, unknown>,
            expiresAt: frame.expiresAt,
            ...(typeof frame.sessionId === 'string' ? { sessionId: frame.sessionId } : {}),
          }
        : undefined
    case 'tool.cancel':
      return typeof frame.id === 'string' ? { t: 'tool.cancel', id: frame.id } : undefined
    case 'ping':
      return { t: 'ping' }
    default:
      return undefined
  }
}

function isCaps(value: unknown): value is BridgeCaps {
  if (typeof value !== 'object' || value === null) return false
  const caps = value as Record<string, unknown>
  return (caps.debugger === undefined || typeof caps.debugger === 'boolean')
    && isProto(caps.proto)
    && isToolset(caps.toolset)
    && (caps.extensionId === undefined
      || (typeof caps.extensionId === 'string' && EXTENSION_ID_PATTERN.test(caps.extensionId)))
    && typeof caps.snapshotMaxChars === 'number'
    && Number.isInteger(caps.snapshotMaxChars)
    && caps.snapshotMaxChars >= MIN_SNAPSHOT_MAX_CHARS
    && typeof caps.maxInteractiveItems === 'number' && caps.maxInteractiveItems > 0
}

function isProto(value: unknown): boolean {
  return value === undefined
    || (typeof value === 'number' && Number.isInteger(value) && value >= LEGACY_PROTO)
}

/**
 * Whether a declared feature level is one this build knows how to serve.
 *
 * The bound is the OLDEST level, not the current one. A `hello` declaring a
 * lower level is exactly the skew the negotiation exists for: the host narrows
 * the tool surface to what that build implements (`setClientToolset` maps every
 * level down to a definition set). Requiring the current level here rejected
 * those frames outright -- `parseBridgeFrame` returned undefined and the
 * socket closed with `1008 unparseable frame` -- so the degradation path could
 * never run and an older extension could not connect at all.
 */
function isToolset(value: unknown): boolean {
  return value === undefined
    || (typeof value === 'number' && Number.isInteger(value) && value >= LEGACY_TOOLSET)
}

/**
 * Protocol version a peer declared, defaulting to {@link LEGACY_PROTO} when the
 * field is absent. Exported so both halves read version skew the same way.
 *
 * @param caps - the peer's capabilities (undefined while nothing is connected).
 * @returns the declared version.
 */
export function declaredProto(caps: BridgeCaps | undefined): number {
  return caps?.proto ?? LEGACY_PROTO
}

/**
 * Feature level an extension declared, defaulting to {@link LEGACY_TOOLSET}
 * when the field is absent.
 *
 * @param caps - the peer's capabilities.
 * @returns the declared feature level.
 */
export function declaredToolset(caps: BridgeCaps | undefined): number {
  return caps?.toolset ?? LEGACY_TOOLSET
}

/**
 * Why this host must refuse a `hello`, or undefined when it can proceed.
 * Only the "extension is newer than the plugin" direction is fatal: older
 * extensions are accepted with a reduced toolset (see `declaredToolset`).
 *
 * @param caps - capabilities from the incoming `hello`.
 * @returns a short, actionable close reason, or undefined.
 */
export function handshakeRefusal(caps: BridgeCaps): string | undefined {
  const proto = declaredProto(caps)
  return proto > BRIDGE_PROTO
    ? `restart dsh: extension bridge protocol ${proto} is newer than this plugin (${BRIDGE_PROTO})`
    : undefined
}

function isToolError(value: unknown): value is ToolError {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).code === 'string'
    && typeof (value as Record<string, unknown>).message === 'string'
}

