# @yuxianglin/dsh-bridge-browser

English | [中文](README.zh.md)

The **pure browser-tool bridge** for dsh: mounts a token-authenticated WebSocket carrier (`/ext/bridge`) that the Chrome extension connects to, and registers the `browser_*` tool set that reads and operates the user's active tab through the extension — click elements, fill forms, scroll, and navigate in the real browser, login state preserved. The bridge carries **only tool frames**: no chat, settings, credentials, or event streams pass through it, so dsh's gateway can keep evolving without touching this contract. Chat and sessions belong to standard dsh clients (web GUI / CLI); the extension side is a status view plus options/approval popups.

**Text first, vision on request**: page snapshots stay structured text (title, main content, numbered interactive inventory, and masked form fields), and every browser action uses stable inventory numbers. `browser_snapshot` additionally returns a screenshot of the same moment and `browser_capture` returns one on demand — only when the calling model route declares image input, and only as an in-memory image attachment: the extension never writes a screenshot to disk.

## Config

| Key | Type | Default | Description |
|---|---|---|---|
| `token` | `string` | generated | Fixed bearer token. When absent, a token is generated on first boot, persisted at `~/.dsh/ext-bridge-token` (chmod 0600), and printed in the boot log. |
| `toolTimeoutMs` | `number` | 90000 | Per-tool-call budget, leaving time for the extension's 60-second approval window. |
| `snapshotMaxChars` | `number` | 32000 | Upper bound on one rendered snapshot's characters, minimum 500 (also negotiated to the extension via `hello.ok` caps). |
| `maxInteractiveItems` | `number` | 60 | Upper bound on interactive inventory items per snapshot. |

## Usage

The remote installer downloads an installer-managed workspace, builds the plugin, and registers its official bundle in the local dsh `web` profile. It requires neither Git nor a local clone:

```sh
curl -fsSL https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.sh | bash
cd ~/.dsh/dsh-browser && pnpm start
```

On Windows, run the PowerShell installer instead:

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
cd $HOME\.dsh\dsh-browser; pnpm start
```

Developers can instead clone the repository and run `./scripts/install.sh` followed by `pnpm start` from that checkout. The local mode uses the current branch without downloading or overwriting source files. Both installation modes register the same profile bundle; build tools resolve only from the selected workspace and never from a parent checkout or parent `node_modules` directory.

The pinned 0.1.7 pre-release runtime loads the registered bundle; pre-0.1.2 runtimes are not supported:

```sh
npx @deepseek-ai/dsh@0.1.7-rc.1 web
```

The installer copies the unpacked extension to `~/.dsh/browser-extension` and opens `chrome://extensions`. Load that stable directory in Chrome and use the assistant window (status side panel or floating popup, per settings). Loopback connections are discovered automatically and require no token entry; non-loopback deployments still require the configured bearer token.

## Security model

- The bridge route lives **outside** the `/api` trust fence (which only guards client-connection's routes), so it carries its own bearer-token authentication: the first frame must be `hello` with the token within 5s, verified in constant time. Failed auth closes the socket.
- Gateway methods the `/api` carrier pins to loopback (`settings.*`, `credentials.*`, `host.pickDirectory`, `host.openPath`) are refused for non-loopback remotes **even with a valid token** — defense in depth for `--host 0.0.0.0` deployments.
- One active connection at a time; a new authenticated socket replaces the previous one.
- The bridge is a confused-deputy boundary, not a general auth layer: never expose `dsh web --host 0.0.0.0` on untrusted networks.
- Extracted page text is marked as untrusted model input. Page reads honor the extension's ask/auto/off policy, while state-changing tools require an origin-scoped approval and fail closed without one. Same-origin repetition can be trusted for the current session; permanent trust remains an explicit setting.

## Wire protocol

Frames are JSON objects discriminated by `t`, defined in [`protocol.ts`](src/protocol.ts) — the single source of truth shared with the extension through the workspace package's `./src/*` export. The built package also publishes `@yuxianglin/dsh-bridge-browser/protocol` for external consumers.

- Client → server: `hello` (auth + caps), `rpc` (one of the two GDrive-internal methods), `tool.result`, `pong`.
- Server → client: `hello.ok` (echoes negotiated caps), `rpc.result`, `tool.call`, `tool.cancel`, `ping`, `error`.

`tool.call` carries a stable id the extension echoes back on its `tool.result`; `expiresAt` lets a stale call settle as `timeout`. The bridge is a request/response channel only — once auth completes, no event frames flow.

Both halves negotiate versions in `hello`/`hello.ok`: `proto` is the handshake version (a build that sends none reads as 1) and `toolset` is the extension's feature level (none = 0). A host that cannot serve a newer extension closes with code `4003` and a reason the extension shows verbatim; an extension that declares an older level gets a narrowed tool surface (no `browser_dom_query`/`browser_block`/`browser_headers`, and `browser_click`/`browser_type` without `selector`) instead of argument errors at call time. The extension shows the same skew in its options page and side panel, naming the fix (restart dsh, or reload the extension).

Loopback sockets may skip the bearer token, but only for one extension: the `Origin` must name an ID in `BRIDGE_EXTENSION_IDS`, and the extension's own `caps.extensionId` must match that same ID. Any other `chrome-extension://` origin is refused with `4002` — otherwise every other installed extension could take the single tool slot and read the model's tool calls, since `Origin` is only a header. The pinned ID is derived from the public key in the extension manifest (`scripts/extension-id.mjs`; a test asserts the two agree), so it stays stable across installs. This is not cryptographic proof of identity: a local process that knows the ID can still forge the header, which is why non-loopback connections always require the token.

## Tools

| Tool | Purpose |
|---|---|
| `browser_snapshot` | Structured text snapshot (title/URL/main/inventory/forms); `delta: true` returns only changes; pairs the text with a same-moment screenshot unless `visual: false`. |
| `browser_capture` | Screenshot of the viewport (`fullPage: true` for the whole page) as an image block; kept in memory, never written to disk. |
| `browser_click` / `browser_type` / `browser_press` | Operate inventory items by stable index; click and type also accept a CSS `selector` for controls the inventory cannot name (icon-only buttons). |
| `browser_scroll` / `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | Page movement. |
| `browser_get_text` / `browser_wait` | Read regions / settle detection. `find` (+ `context`) locates a phrase in the whole scope and returns a bounded window per match, so one call answers "what does this part say" without scripting the DOM. |
| `browser_dom_query` | Narrow DOM read: fields of the elements a CSS selector matches, each with a verified unique selector. |
| `browser_image` | A picture the page embeds (`<img>` / `<canvas>` / SVG `<image>` / CSS background) at its original resolution. Needs no `chrome.debugger`, so it works with DevTools open and on a background tab. |
| `browser_console` / `browser_network` | Console messages and uncaught errors; request list, one response body by id, and in-memory response overrides. |
| `browser_dialog` | Accept or dismiss the page's JavaScript dialog — the escape hatch when a page is frozen behind an `alert`/`confirm`. |
| `browser_eval` | Evaluate an expression in the page's own context (page CSP does not block it). |
| `browser_bind_interactive` | List the bindable pages, ask the user to pick one through the standard question flow, and bind this session to it — one tool for the whole interaction. |
| `google_drive_export` | Export a Google Doc (`/document/d/…`) or Sheet (`/spreadsheets/d/…`) with the signed-in session; every other Google link is read in the browser instead. |
| `browser_block` / `browser_headers` | Block matching requests, or rewrite request/response headers; session rules scoped to the controlled tab. |
| `browser_status` | Host-side self-check, available whether or not the extension is connected: connection state, the extension's id/build version and declared `proto`/`toolset` measured against this plugin's own (naming "reload the extension" or "restart dsh"), whether the mirrored extension files are current, and the single next action. Not affected by the debugging setting or the extension's toolset level. |
| `browser_setup` | Host-side installer helper: re-syncs the extension files into `~/.dsh/browser-extension`, opens `chrome://extensions`, copies that path to the clipboard when a clipboard tool exists, and names the one remaining manual step. Idempotent. |

## Model Experience

- **Token effect**: one `browser_snapshot` (default 32k chars) costs roughly 8–10k tokens for typical English text, plus one image; the exact count depends on language and tokenizer, and delta snapshots cost a fraction of that. Pass `visual: false` on text-only follow-up reads, and prefer `browser_capture` over a full snapshot when only the appearance matters. The system-prompt section tells the model to snapshot on demand rather than hoard page text.
- **KV-cache effect**: none beyond ordinary tool results; snapshots are not cached server-side.
- **Latency**: each action awaits the extension's real-page execution plus settle detection (typically 0.2–2s; navigation up to 5s).
- **Failure modes**: `bridge-closed` (extension not connected), `timeout`, `no-active-tab`, `content-unavailable` (page needs a refresh), `action-failed` (stale inventory index — the model should re-snapshot).

## Extension points

- The tool set is the consumer surface; the seam is the bridge wire (`protocol.ts`). Add tools by registering on `ctx.tools` and dispatching over the bridge; the extension's content script dispatches by action name.
- Negotiated caps (`hello.ok`) let the plugin dictate snapshot budgets to the extension without a shared config file.

## Known Limitations and Deferred Work

- One active extension connection (a second window replaces the first).
- Accessible cross-origin iframes are snapshotted and operated with stable `(frame, index)` addresses. Restricted or short-lived frames are reported as unavailable without failing the whole page snapshot.
- Token rotation is manual (edit `~/.dsh/ext-bridge-token` or set `token` in config); no expiry.
- Approval is enforced in the extension service worker rather than delegated to model behavior. A future dsh tool-pipeline integration may surface the same policy in other clients.
