# dsh Browser Control

**English** | [中文](README.zh.md)

<img width="1701" height="897" alt="dsh Browser Control" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to the Chrome tab you are already using. The model can read page content, click controls, fill forms, scroll, and navigate while preserving your login state, session, and cookies. A status surface — a floating window by default, or the side panel — shows which page is currently being operated.

`dsh` is DeepSeek AI's open-source, plugin-based agent harness. This repository provides a companion browser bridge plugin and Chrome MV3 extension as one standalone pnpm workspace.

Pages become structured text with a numbered inventory of interactive elements, and the model addresses those elements by number. `browser_snapshot` pairs that text with a screenshot of the same moment, and `browser_capture` returns a screenshot on demand — both only for image-capable models, and both kept in memory: the extension never writes the image to disk, while a text-only route degrades to the text snapshot with a named reason. Screenshots go through `chrome.debugger`, so they need the extension's debugging switch (off by default — see [Core capabilities](#core-capabilities)).

> [!IMPORTANT]
> This repository pins the runtime at `0.1.7-rc.1`: npm's `latest` for `@deepseek-ai/dsh` is now `0.1.7-rc.2` and `next` is `0.2.0-rc.1`, while the bridge declares a peer range of `>=0.1.7-rc.1 <0.3.0` — so the same plugin mounts on any dsh in that range. See the [upgrade note](docs/dsh-0.1.7-rc-upgrade.md) for the version history.

## Quick install

The standard `dsh plugin` command alone cannot install this project. The integration contains both a dsh bridge plugin and a browser extension. The one-line installer currently sets up the Chrome build.

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

Windows, in PowerShell:

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

The installer puts the extension files in `~/.dsh/browser-extension` and opens `chrome://extensions`: load or reload **AI Browser Assistant** there — that is the only browser-side click — then restart dsh once. The plugin keeps those files current at startup, so nothing has to be copied by hand. Each later update: rerun the same install command, then one more “Reload” in Chrome. See [Detailed installation and usage](#detailed-installation-and-usage) for prerequisites, startup commands, updates, and development commands.

> [!IMPORTANT]
> The unscoped [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) package on npm belongs to a different project and is not affiliated with this repository. This project is not currently published as an npm package; use the installer above.

## Core capabilities

| Capability | Tool | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Structured text snapshot: title, URL, main text, numbered controls, and masked form fields; `delta: true` returns only changes; carries a same-moment screenshot unless `visual: false` |
| Capture the page † | `browser_capture` | Screenshot of the viewport (or the whole page with `fullPage: true`) delivered as an image; never written to disk. Prefer the viewport — a long page's full-page capture is scaled to the model's image budget, so its text is not legible |
| Read console and network † | `browser_console` / `browser_network` | Console messages and uncaught errors with a cursor; request list with status and timing, one response body by id, and in-memory response overrides |
| Answer a page dialog † | `browser_dialog` | Accept or dismiss an `alert` / `confirm` / `prompt`; such a dialog freezes the page, so every other tool blocks until it is answered |
| Run page JavaScript † | `browser_eval` | Evaluate an expression in the page's own context; page CSP does not block it, and every call is approved on its own |
| Block or rewrite requests | `browser_block` / `browser_headers` | Block matching requests, or rewrite request/response headers — scoped to the controlled tab and session-only |
| Click element | `browser_click` | Click by inventory number, or by CSS selector when a control has no usable inventory entry (icon-only buttons). On a native `<select>`, pass `option` (its value or visible text): a synthetic click cannot open a native popup, and `browser_dom_query { fields: ["options"] }` lists the choices |
| Click a control bound to the press | `browser_click_pointer` | Sends `pointerdown`, `mousedown`, `pointerup`, `mouseup`, and `click` at the element's centre — for canvas/SVG editors such as Google Slides, where `browser_click` reports success and nothing changes |
| Open a Google Slides page | `browser_slides_open_page` | Opens one page of the deck in the controlled tab by 1-based number: drives the editor's grid view, checks the landing through the URL hash, and loads the slide by hash when a press changes nothing. Safer than pressing a filmstrip thumbnail yourself, whose press resolves by coordinates |
| Fill forms | `browser_type` | React/Vue-compatible input by inventory number or CSS selector; `replace` clears the field first |
| Press keys | `browser_press` | Keyboard events such as Enter, Tab, Escape, and arrow keys |
| Scroll | `browser_scroll` | Viewport scrolling: up, down, top, and bottom |
| Navigate | `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | Navigation inside the controlled tab, with login state preserved |
| Read region | `browser_get_text` | Lazy-loaded or partial page text; `find` (+ `context`) locates a phrase and returns a bounded window |
| Inspect elements | `browser_dom_query` | Read the fields you name off elements matching a CSS selector, each with a verified unique selector to act on |
| Read a page picture | `browser_image` | A picture the page embeds (`<img>` / `<canvas>` / SVG `<image>` / CSS background) at its original resolution; needs no debugging capability, so DevTools open or a background tab is fine |
| Bind a page | `browser_bind_interactive` | List the bindable pages, ask the user to pick one, and bind this session to it |
| Export a Google file | `google_drive_export` | Docs and Sheets only; those two page types refuse the page tools, so read them through the export. Slides and Drive files are ordinary pages |
| Bridge status | `browser_status` | Connection state, extension id and version, whether protocol/toolset match the plugin, whether the mirrored files are current, the recent debugging events, and the single next action |
| Refresh the extension files | `browser_setup` | Mirror the extension bundled in the plugin into `~/.dsh/browser-extension` and open `chrome://extensions` |
| Print the update command | `browser_update` | Prints the update command for this machine; never runs it |
| Wait for stability | `browser_wait` | Page-load and render-settle detection |

† These five tools run over Chrome's `chrome.debugger` and are governed by the extension's **“Allow browser debugging”** setting, which is off on first install: while it is off the plugin does not register them at all, so the model can neither see nor call them. Turn it on in the options page when needed (the bridge reconnects and the capability travels in the handshake). `browser_snapshot` itself still works, but the same-moment screenshot it carries by default also goes through `chrome.debugger`: with debugging off the result carries the text plus a line naming why the screenshot is unavailable. When DevTools is open on the controlled tab, Chrome refuses a second debugger and the tool says so.

## Repository layout

```
packages/browser/bridge-browser/   the bridge: WebSocket carrier + the browser_* tool set
extensions/dsh-browser/            the Chrome MV3 extension (background, content script, panel/options)
.dsh/skills/                       skills shipped with the repository
scripts/install.sh                 installer (macOS/Linux; install.ps1 on Windows)
scripts/install-skills.mjs         skill install (step 3 of the installer)
docs/                              upgrade notes and investigation records
```

## Why this design

- **Your real browser, not a headless copy**: the model works in the page you already have open, retaining logins, sessions, and cookies.
- **A text-first page interface**: numbered controls, stable IDs across snapshots, delta updates, and masked sensitive values make pages operable without screenshots.
- **A narrow privacy boundary**: passwords and payment-card values are always rendered as `••••` and never leave the page.
- **Debugging is opt-in**: the tools that run over `chrome.debugger` are not registered until the user turns the switch on, so the model never sees them by default.
- **A guarded bridge**: authenticated handshakes protect remote connections, the bridge services only browser tool frames and two bridge-internal RPCs, and the extension binds tools to one user-controlled tab.

## Detailed installation and usage

Requirements: Node.js 22 or newer (the installer only checks that `node` and `pnpm` exist), Corepack/pnpm, and Chrome 116+ (the extension's `minimum_chrome_version`). Windows additionally needs Windows PowerShell 5.1, which ships with Windows, or PowerShell 7+.

### Install or update

For a managed installation, run:

```sh
curl -fsSL https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

or, on Windows:

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

The installer downloads `main`, builds and registers the bridge plugin, builds the Chrome extension into `~/.dsh/browser-extension`, and opens `chrome://extensions`. On the first install, load that directory as an unpacked extension; afterwards a single **Reload** on that page is enough — the plugin re-syncs the extension files into that directory on every start (no installer rerun needed), but the code Chrome already loaded only changes when Chrome reloads it. A running dsh hot-loads the plugin within seconds.

`scripts/install.sh` covers macOS and Linux, and `scripts/install.ps1` covers Windows; both write the same managed workspace and the same install metadata. The installer copies the extension path to the clipboard when a clipboard tool is available (`pbcopy`, `wl-copy`, `xclip`, `xsel`, or PowerShell's `Set-Clipboard`), and prints the path either way. When no Chrome or Chromium install is found, it prints the command that installs one; set `DSH_INSTALL_BROWSER=1` to let the installer attempt that install itself.

The Windows command downloads `install.ps1` and runs it rather than piping it into `Invoke-Expression`: the script is UTF-8 with a byte order mark so Windows PowerShell renders its Chinese output, and `Invoke-Expression` rejects a leading mark.

Updates rerun the command above to pull the newer version, then one more **Reload** on the extensions page. Not sure which command that is? Ask the assistant: `browser_update` prints the one for this machine, and does not run it for you.

### Skills shipped with this repository

The repository also ships the operational knowledge that goes with these tools, as skills under `.dsh/skills/`. They live in the repo so a change in browser behaviour and the advice about that behaviour are reviewed and committed together, and they are installed into `~/.dsh/skills/` so that a session in **any other workspace** can use them — the skill filesystem provider scans the project root at rank 100 and the user's `~/.dsh/skills` at rank 400, so the repo copy alone would only reach sessions started inside this repo.

`scripts/install-skills.mjs` (step 3 of the installer, or `pnpm run skills:install`) links each skill into `~/.dsh/skills`; `--copy` copies instead, which is what the Windows installer uses because creating a link there needs Developer Mode or elevation. A symlink is the default on macOS and Linux, so editing the repo copy takes effect with no reinstall and the installed skill cannot drift from it. A skill is only loaded when its description matches what the session is doing — `google-slides-via-browser`, for example, loads when the controlled tab is a Google Slides editor.

### Start and use

Start the managed installation with:

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

The exact supported public runtime is currently the pinned 0.1.7 pre-release:

```sh
npx @deepseek-ai/dsh@0.1.7-rc.1 web
```

Local Chrome use requires no configuration. Clicking the DeepSeek whale icon in the toolbar opens the status surface — a floating window by default, switchable to Chrome's side panel in the extension options: it shows the connection state, the tab being operated, the grants this session holds, and the recent debugging events. Open any `http://` or `https://` page and wait for **Connected**. Existing tabs are instrumented on the first action; browser-internal pages such as `chrome://`, the extension stores, and another extension's own page (`chrome-extension://`) are not supported.

When the bridge will not connect or tools are missing, tell the assistant “what is the browser bridge status”: `browser_status` reports whether the extension is connected, whether its build and protocol level match the plugin (and names the fix — reload the extension, or restart dsh), whether the mirrored files are current, the recent debugging events, and the single next action; `browser_setup` re-mirrors the extension files when they are stale.

## Troubleshooting

**Status surface stays "Not connected"**

- Make sure dsh web is running locally (default `http://127.0.0.1:3080`).
- Verify the bridge is loaded: open `http://127.0.0.1:3080/ext/bridge-config`. It should return JSON such as `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}`. If it returns a web page instead of JSON, the running dsh predates the bridge registration — restart dsh and refresh the page; the extension reconnects on its own.
- The extension probes ports 3080, 3081, 3090, 14389, and 43189 (dsh Desktop) automatically. If dsh runs on another port — or you use a remote `--host 0.0.0.0` deployment — set the address (and bridge token) in the extension options.

**`browser_capture`, `browser_console`, `browser_network`, `browser_eval`, or `browser_dialog` is missing**

They run over `chrome.debugger` and are governed by the extension's “Allow browser debugging” setting, which is off on first install: while it is off the plugin does not register those tools, so the model cannot see them. Turning it on reconnects the bridge and the capability arrives in the handshake.

**A debugging tool reports that another debugger is already attached**

Chrome refuses a second debugger while DevTools holds the controlled tab. Close DevTools on that tab and retry.

**Another session is already operating the browser**

One extension connection serves one session at a time. While a session holds it, a new session's bind or call is refused with the holder's session id; unbind in that session (or let it end) before binding here.

## Development

The bridge plugin and Chrome extension are both members of this repository's workspace. Run all commands from the repository root. For the first development installation, run `pnpm install`.

```sh
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run skills:install

pnpm --filter dsh-bridge-browser run build
pnpm --filter dsh-bridge-browser run typecheck
pnpm --filter dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run test
```

Notes:

- The bridge plugin must have a built `lib/` before startup because the loader consumes it; both `scripts/install.sh` and the root `pnpm run build` build the plugin before the extension.
- The dependencies of `@deepseek-ai/dsh` and the bridge plugin are pinned to the same tested public release line (the plugin's peer range is `>=0.1.7-rc.1 <0.3.0`). An upgrade must update the manifests and lockfile together and rerun the root checks.

## Security

- The bridge path sits outside the `/api` trust boundary and performs its own bearer-token authentication.
- Local Chrome extension origins retain zero-configuration loopback access.
- Privileged gateway methods such as `settings.*`, `credentials.*`, and `host.open*` reject non-loopback sources.
- One active connection. Page reads are text by default, and `browser_snapshot` adds a screenshot unless the current model route declares no image input. The tools that run over `chrome.debugger` (screenshots, console, network, page evaluation, `browser_dialog`) are off by default: while the switch is off the plugin does not register them, and Chrome shows its usual debugging notice while a session is attached. Screenshots stay in memory — nothing is written to disk — and password or payment-card values never leave the page.
- When the assistant starts operating a page, it binds to the then-active tab at the first browser-tool call. A manual tab switch neither interrupts it nor rebinds it, and it does not withdraw a prompt that is waiting for your approval — the prompt lives in the dsh page, so you have to be able to switch to it and answer. Only losing the bound tab pauses the session, until the next call explicitly picks a page; the extension never silently retargets or changes your visible tab. One extension connection serves one session, so a second session's bind is refused with the holder's session id instead of stealing the tab.
- Page-authored text is wrapped as untrusted input. The default `auto` mode reads only the controlled tab without an extra prompt; privacy-sensitive users can select `ask` for per-read confirmation or `off` to block reads entirely. In `ask` mode, the read dialog can allow one read or persistently switch back to `auto`; this can be reversed in Settings. Read page text is sent to the selected model.
- Click, type, keypress, navigation, history, and reload calls fail closed until the user approves them. A session's first `browser_navigate` opens its new tab only after that approval, so a denied or unanswered call issues no request at all. By default `browser_navigate` may only reach the host of the currently bound page (switch hosts by binding or by an initial navigation); enabling “Allow cross-domain navigation” in the options lifts that. Settings also carry a blocked-origin list, and a blocked origin refuses both reads and operations. Google Drive exports are approved the same way — scoped to the document host, and skipped once that origin is trusted — and Docs/Sheets refuse the page tools, so the export is the only way to read them. An origin may be trusted for the current session, while permanent trust is managed explicitly in the extension options.
- Actions that cannot be scoped to one origin (`browser_eval`, `browser_headers`, `browser_dialog`, `browser_network` with `mock`/`mockClear`, history moves) have no "Trust this site" and offer "Allow in this session" instead: remembered per session and per action, they stop prompting for that action until the session unbinds, is explicitly bound to another tab, loses its tab, or the browser session ends. `browser_navigate` is not among them — its risk is the destination, so a session grant would turn one approved destination into permission to go anywhere for the rest of the session; it keeps prompting per destination. `browser_eval` prompts on every call unless origin trust is allowed to cover JavaScript execution in Settings. A prompt that expires unanswered (60 seconds) can still be re-raised by calling the same tool again.
