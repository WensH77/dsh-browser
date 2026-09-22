# dsh Browser Control Extension (Chrome MV3)

English | [中文](README.zh.md)

The **pure browser-operation end** of dsh: the model reads and operates the browser page you have open — extract content, click elements, fill forms, scroll, and navigate, all in the real page with your login state preserved. This is a pure-tool extension: there is no in-panel chat. Conversation and sessions happen in the official dsh UI; the extension connects to the dsh bridge on load (auto-discovery), binds a session to the tab you are viewing on its first browser call, and surfaces a minimal status view (which page is being operated), an options page (connection, sharing, trusted origins, notifications), and an action popup (pending approvals).

## What the model can do

| Capability | Action | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Title/URL/main text/numbered inventory/form fields (sensitive values masked); `delta: true` returns only changes |
| Click element | `browser_click` | Click by inventory number (links/buttons/checkboxes…), React/Vue compatible |
| Fill forms | `browser_type` | Type text; `replace` clears first |
| Keys | `browser_press` | Enter/Tab/Escape/arrows etc. |
| Scroll | `browser_scroll` | Viewport scrolling (up/down/top/bottom) |
| Navigate | `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | Navigation inside the controlled tab, login state preserved |
| Read region | `browser_get_text` | Lazy-loaded content / partial text |
| Wait | `browser_wait` | Page load and render-settle detection |

## Architecture

```
status panel / options / popup ◄─runtime messages─► background SW/event page ◄─WS─► dsh bridge plugin
                                 │
                     tabs.sendMessage (DSH_ACTION / DSH_BUDGET / DSH_CONTENT_READY)
                                 ▼
                        content script (snapshot/actions/privacy)
```

- **background** (`src/background/`): bridge connection (token auth + exponential-backoff reconnect + keepalive), the two bridge-internal RPC calls, and **fail-closed tool dispatch to a user-controlled tab**.
- **content script** (`src/content/`): text snapshot (readability main text + numbered interactive inventory + form fields), **stable element numbers** (`data-dsh-el`), delta changes, click/type/press/scroll/navigate actions, and sensitive-field masking.
- **capture** (`src/background/capture.ts`): Chrome-only screenshots over `chrome.debugger` (`Page.captureScreenshot`). Attach-per-capture, downscale-and-reencode to the host's image limits, detach in `finally`; bytes stay in memory and travel to the host as base64.
- **panel / options** (`src/panel/`, `src/options/`): minimal React pages — the status panel (also opened as the floating-window popup, per the `statusMode` setting) shows connection state, the controlled tab, recent operations, and pending approvals; the options page manages the bridge URL/token, page sharing, trusted origins, and approval notifications.
- **Protocol**: `protocol.ts` in the `@yuxianglin/dsh-bridge-browser` workspace package is the single source of truth, shared by both ends through the package's source export.

## Build

```sh
pnpm install
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run test
```

Run these commands from the repository root. Chrome outputs to `extensions/dsh-browser/dist/`.

## Install and use

The recommended zero-configuration command does not require Git or a local clone:

1. **Build and install the extension**:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
   ```

   On Windows, run this in PowerShell instead:

   ```powershell
   $s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
   ```

   The script downloads a managed workspace to `~/.dsh/dsh-browser`, builds the bridge plugin, registers its official bundle in the local dsh `web` profile, builds the extension, copies the output to the stable directory `~/.dsh/browser-extension`, and opens `chrome://extensions`. Enable Developer mode, choose Load unpacked, and select the extension directory. Running the command again updates the managed installation.

   A cloned checkout uses the same installer without downloading or overwriting source files:

   ```sh
   git clone https://github.com/Lum1104/dsh-browser.git
   cd dsh-browser
   ./scripts/install.sh
   ```

   Windows checkouts run `.\scripts\install.ps1` instead.

2. **Start dsh with the bridge plugin mounted**. Use either the workspace-pinned runtime:

   ```sh
   cd ~/.dsh/dsh-browser && pnpm start
   ```

   From a clone, run `pnpm start` in the repository root instead.

   Or the exact supported public runtime (pinned 0.1.5 pre-release):

   ```sh
   npx @deepseek-ai/dsh@0.1.5-rc.1 web
   ```

   Both commands load the same bundle from the local `web` profile. Port 3080 is used by default; append `--port <port>` when it is occupied.

   **DSH Desktop users**: the Desktop app assigns a random local Web port by default (`dsh-desktop.port: 0`), so port-based auto-discovery cannot predict it. Pin the port to `43189` in Desktop settings (see the [deepseek-harness-desktop user guide](https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/docs/user-guide.en.md)); auto-discovery covers that port. Alternatively, enter `http://127.0.0.1:<port>` manually in the extension options.

   The extension connects to the auto-discovered bridge as soon as it loads and keeps retrying with backoff; approvals can surface in the status window even while you work in other tabs. If the connection drops or another browser profile replaces it, the extension reconnects on its own.

3. **Use it**: open a normal `http://` or `https://` page and click the DeepSeek whale icon. The build auto-discovers local dsh, and loopback connections need no address or token.

Pages that were already open before extension installation or reload are instrumented automatically on the first action, so they do not require a manual refresh. Browser-internal and protected pages such as `chrome://` and the Chrome Web Store cannot be read or operated.

For extension-only development, load `extensions/dsh-browser/dist/` from `chrome://extensions`. Rebuild and reload after code changes.

## Why text is the default view (and when vision joins)

- **Snapshot as the view**: the model's primary view of the page is structured text (title/URL/main/numbered elements/forms), budgeted at 32k chars by default (plugin-configurable, negotiated to the extension via `hello.ok`). When the calling model route declares image input, `browser_snapshot` adds a screenshot of the same moment and `browser_capture` returns one on demand. A route without image input silently drops back to text, and the result names why no screenshot accompanied it.
- **Page text is untrusted input**: snapshots and targeted text reads are enclosed in a fresh nonce-bound trust marker and explicitly tell the model never to treat page-authored commands as instructions. This is defense in depth; extension-side action approval is the enforcement boundary.
- **Icon-only controls stay clickable**: an interactive element with no text falls back to its `title` / `data-original-title` / `data-tooltip`, then to an icon class such as `icon-specialist-email` (readable, heuristic - never overriding real text). The inventory also ranks content-area controls above persistent chrome (nav/header/footer) so a sidebar full of links cannot consume the item budget.
- **Page chrome is not resent**: when nav/header/footer items are byte-identical to the previous snapshot, they are folded into one line (`N unchanged … items from snapshot vK are omitted`) instead of being re-sent; their indices stay valid and `browser_dom_query` returns their selectors.
- **Automatic reads are cheaper than explicit ones**: the snapshot attached after a navigation is capped at 8k characters (vs 32k for `browser_snapshot`), and the model can follow up when it needs more.
- **Page pictures come back as pictures**: `browser_image` returns an `<img>`, `<canvas>`, SVG `<image>`, or CSS background at its original resolution through the same attachment path as a screenshot. It needs no `chrome.debugger`, so it works while DevTools is open and on a background tab; the bytes are passed through untouched when they fit the deployment&#39;s admission limits, and only an oversized raster is refitted (the envelope then reports the original dimensions).
- **Page text is searchable**: `browser_get_text` takes `find` (case-insensitive literal) with `context` (characters on each side, default 300). The search runs over the whole extracted text rather than a truncated head, returns one bounded window per match with its character range, and reports how many characters it searched when nothing matches — so "what does slide 10 say" is one call instead of a chain of `browser_eval` DOM slicing.
- **Narrow DOM reads**: `browser_dom_query` returns the fields you ask for (`href`, `value`, `checked`, …) plus each match's accessible name and unique selector — the cheap, read-only alternative to inspecting the DOM through `browser_eval`.
- **A capped inventory stays actionable**: when the item cap drops controls, the snapshot lists the top 8 dropped ones with a verified unique CSS selector (`Omitted by the inventory cap`), and the note says to click them by selector instead of only suggesting more text.
- **Selector addressing**: `browser_click` / `browser_type` accept a CSS `selector` next to `index`; it resolves in the target frame, prefers a visible match, scrolls it into view, and still runs through approval and settle detection - so acting on what the screenshot shows never requires clicking inside `browser_eval`.
- **SVG controls are addressable**: the visibility check, the unique-selector builder and the click path all handle SVG elements (Slides filmstrip thumbnails, chart and map controls) — `browser_dom_query` reports their real visibility and a verified `selector=`, and clicking one dispatches a real `MouseEvent` instead of calling a `click()` that only HTML elements have. `browser_dom_query` also labels each match's computed accessible name as `name=`, so it is never mistaken for an `aria-label` attribute.
- **Stable numbering**: element numbers persist across snapshots (WeakMap + `data-dsh-el`), so the model can say "click 7"; a large page change explicitly reports "numbers reindexed".
- **Delta mode**: `browser_snapshot({delta:true})` returns only changed element numbers, saving tokens.
- **Privacy**: password/credit-card values always render as `••••` and never leave the page; accessible names never use a sensitive field's current value. Screenshots are a page read: they obey the same sharing policy (`ask`/`auto`/`off`), stay in memory, and are never written to disk by the extension.
- **Tab affinity**: the first browser-tool call binds the then-active tab before any action runs. A manual tab/window switch pauses later tools and the assistant asks (through an approval in the status window) whether it should stay on the original tab or follow the newly visible one. Staying permits explicit background operation without changing the user's visible tab; following resets page-reference state. A closed controlled tab fails closed until the next call binds a page you explicitly choose, and a switch withdraws any open action approval.
- **Debugging is opt-in**: screenshots, console, network, response overrides, and page evaluation run over `chrome.debugger`, and are only registered while the extension's “Allow browser debugging” setting is on (off on first install). While off the host never registers them, so the model cannot see or call them at all; switching the setting reconnects the bridge so the capability travels in the handshake.
- **Build skew is named, not guessed**: `hello`/`hello.ok` carry `proto` (handshake version) and `toolset` (extension feature level). A host that cannot serve this build refuses the handshake with a readable reason, and the extension shows it verbatim in the options page and side panel next to the next step (restart dsh, or reload the extension); a host that never answers produces its own notice instead of an unexplained "Connecting…". In the other direction the host narrows the model-facing tool set to the level this extension declares, so an older build is never handed a `selector` it cannot resolve.
- **Buffers start when the tab binds**: with debugging allowed, binding a page attaches the debugger and opens the console/network buffers immediately, so a page's own load-time requests and early errors are captured instead of starting at the model's first read. Turning debugging off, unbinding, or closing the tab releases the session; a dismissed debugging notice is noticed and the tab is primed again on the next affinity change.
- **JavaScript dialogs freeze the page**: a native `alert`/`confirm`/`prompt` blocks the renderer's main thread, so content-script tools and `Runtime.evaluate` queue behind it until someone answers. `browser_dialog` answers it over CDP (accept/dismiss, optional prompt text) and reports the message it closed; the opening dialog is also pushed into the console buffer as a warning.
- **Debugging tools are tab-scoped**: console/network buffers, response overrides and evaluation need `chrome.debugger` (Chrome only, and never while DevTools is open on that tab); blocking and header rules are session rules carrying `tabIds`, so they never touch other tabs and vanish with the browser session. `browser_eval` prompts every time unless “trusted origins may also run JavaScript” is enabled in Settings; header rewriting always prompts, while blocking may be covered by origin trust. A prompt that is never answered is withdrawn when the controlled tab changes, and the tool reports that nothing ran.
- **Consent before the request**: a session's first `browser_navigate` resolves trust/approval for the destination first and creates the tab second, so a denied or unanswered call never loads the URL.
- **Proportional approval**: Google Drive exports run through the same action gate — origin-scoped, trustable, and prompted only while their document host is untrusted. The default `auto` mode lets the model read the controlled tab without an extra prompt; `ask` restores per-read confirmation and `off` blocks reads. In `ask` mode, the read dialog can allow one read or persistently switch back to `auto`, which remains reversible in Settings. State-changing tools still fail closed and show their exact origin plus a redacted action summary. The user may deny, allow once, or trust one origin for the current session; temporary trust clears on service-worker restart. Permanent trust is managed explicitly in the options page. An approval stays pending for up to 60 seconds; when notifications are enabled, a system notification opens the status window for review. Caller cancellation or bridge timeout withdraws any open approval before an action can run.

## Permissions

The extension requests `debugger` (tab screenshots, console/network buffers, page evaluation and response overrides over CDP; Chrome shows its debugging notice while a session is attached and refuses to attach while DevTools holds that tab) and `declarativeNetRequestWithHostAccess` (blocking and header rewriting, declared without an extra install warning because the extension already holds http/https host permissions).

It uses `sidePanel` for its status surface, and also requests `storage` (settings), `notifications` (optional reminders for approvals received while no status window is open), `tabs` + `activeTab` + `scripting` (observe tab changes and inject/message the explicitly controlled tab, including lazy recovery for pages opened before install), `webNavigation` (enumerate and bind messages to that tab's frame documents), `alarms` (background keepalive), and `http/https` (content-script injection on normal pages). The extension never changes the visible tab or silently follows a manual switch; background operation happens only after the user chooses to stay on the original tab.

## Known limitations

- Only one extension connection at a time. An unopened browser profile never claims it; if another browser profile replaces a live connection, the replaced client yields instead of starting a reconnect fight.
- Tab affinity is global to that extension connection rather than per chat session.
- Accessible cross-origin iframes are snapshotted and operated with stable `(frame, index)` addresses. Restricted or short-lived frames are reported as unavailable without failing the whole page snapshot.
- Captcha/image-only controls cannot be handled — the tool result reports "elements with no accessible name" and asks the user to complete that step manually.
- No automatic token rotation.
- Synthetic `browser_press` events do not trigger browser-native default actions such as Tab focus movement, arrow-key scrolling, or Enter activation; use manual input when a workflow depends on those defaults.
- `browser_wait` considers page load plus a fixed quiet window, but does not observe continuously changing DOM state; a live-updating SPA may be reported as stable.
