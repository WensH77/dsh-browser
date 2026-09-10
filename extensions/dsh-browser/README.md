# dsh Browser Control Extension (Chrome and Firefox MV3)

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
- **content script** (`src/content/`): text-only snapshot (readability main text + numbered interactive inventory + form fields), **stable element numbers** (`data-dsh-el`), delta changes, click/type/press/scroll/navigate actions, and sensitive-field masking.
- **panel / options** (`src/panel/`, `src/options/`): minimal React pages — the status panel (also opened as the floating-window popup, per the `statusMode` setting) shows connection state, the controlled tab, recent operations, and pending approvals; the options page manages the bridge URL/token, page sharing, trusted origins, and approval notifications.
- **Protocol**: `protocol.ts` in the `@yuxianglin/dsh-bridge-browser` workspace package is the single source of truth, shared by both ends through the package's source export.

## Build

```sh
pnpm install
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

Run these commands from the repository root. Chrome outputs to `extensions/dsh-browser/dist/`; Firefox outputs to `extensions/dsh-browser/dist-firefox/`.

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

3. **Use it**: open a normal `http://` or `https://` page and click the DeepSeek whale icon. Both builds auto-discover local dsh. Chrome loopback connections need no address or token; Firefox must be given the token from `~/.dsh/ext-bridge-token` because a `moz-extension://` UUID is not an add-on identity.

Pages that were already open before extension installation or reload are instrumented automatically on the first action, so they do not require a manual refresh. Browser-internal and protected pages such as `chrome://` and the Chrome Web Store cannot be read or operated.

For extension-only development, load `extensions/dsh-browser/dist/` from `chrome://extensions`, or run `build:firefox` and load `extensions/dsh-browser/dist-firefox/manifest.json` from `about:debugging#/runtime/this-firefox`. Rebuild and reload after code changes.

## Why browser operation stays text-only

- **Snapshot as the view**: the model's entire view of the page is structured text (title/URL/main/numbered elements/forms), budgeted at 32k chars by default (plugin-configurable, negotiated to the extension via `hello.ok`).
- **Page text is untrusted input**: snapshots and targeted text reads are enclosed in a fresh nonce-bound trust marker and explicitly tell the model never to treat page-authored commands as instructions. This is defense in depth; extension-side action approval is the enforcement boundary.
- **Stable numbering**: element numbers persist across snapshots (WeakMap + `data-dsh-el`), so the model can say "click 7"; a large page change explicitly reports "numbers reindexed".
- **Delta mode**: `browser_snapshot({delta:true})` returns only changed element numbers, saving tokens.
- **Privacy**: password/credit-card values always render as `••••` and never leave the page; accessible names never use a sensitive field's current value.
- **Tab affinity**: the first browser-tool call binds the then-active tab before any action runs. A manual tab/window switch pauses later tools and the assistant asks (through an approval in the status window) whether it should stay on the original tab or follow the newly visible one. Staying permits explicit background operation without changing the user's visible tab; following resets page-reference state. A closed controlled tab fails closed until the next call binds a page you explicitly choose, and a switch withdraws any open action approval.
- **Proportional approval**: the default `auto` mode lets the model read the controlled tab without an extra prompt; `ask` restores per-read confirmation and `off` blocks reads. In `ask` mode, the read dialog can allow one read or persistently switch back to `auto`, which remains reversible in Settings. State-changing tools still fail closed and show their exact origin plus a redacted action summary. The user may deny, allow once, or trust one origin for the current session; temporary trust clears on service-worker restart. Permanent trust is managed explicitly in the options page. An approval stays pending for up to 60 seconds; when notifications are enabled, a system notification opens the status window for review. Caller cancellation or bridge timeout withdraws any open approval before an action can run.

## Permissions

Chrome uses `sidePanel`; Firefox uses `sidebar_action`. Both request `storage` (settings), `notifications` (optional reminders for approvals received while no status window is open), `tabs` + `activeTab` + `scripting` (observe tab changes and inject/message the explicitly controlled tab, including lazy recovery for pages opened before install), `webNavigation` (enumerate and bind messages to that tab's frame documents), `alarms` (background keepalive), and `http/https` (content-script injection on normal pages). Firefox's AMO manifest declares the browsing activity, website content/activity, and personal communications that the add-on sends to the configured dsh/model service. The extension never changes the visible tab or silently follows a manual switch; background operation happens only after the user chooses to stay on the original tab.

## Known limitations

- Only one extension connection at a time. An unopened browser profile never claims it; if another browser profile replaces a live connection, the replaced client yields instead of starting a reconnect fight.
- Tab affinity is global to that extension connection rather than per chat session.
- Accessible cross-origin iframes are snapshotted and operated with stable `(frame, index)` addresses. Restricted or short-lived frames are reported as unavailable without failing the whole page snapshot.
- Captcha/image-only controls cannot be handled — the tool result reports "elements with no accessible name" and asks the user to complete that step manually.
- No automatic token rotation.
- Synthetic `browser_press` events do not trigger browser-native default actions such as Tab focus movement, arrow-key scrolling, or Enter activation; use manual input when a workflow depends on those defaults.
- `browser_wait` considers page load plus a fixed quiet window, but does not observe continuously changing DOM state; a live-updating SPA may be reported as stable.
