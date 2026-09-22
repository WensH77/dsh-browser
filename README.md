# dsh Browser Control

**English** | [中文](README.zh.md)

<img width="1701" height="897" alt="dsh Browser Control" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to the Chrome tab you are already using. The model can read page content, click controls, fill forms, scroll, and navigate while preserving your login state, session, and cookies. A status panel shows which page is currently being operated.

`dsh` is DeepSeek AI's open-source, plugin-based agent harness. This repository provides a companion browser bridge plugin and Chrome MV3 extension as one standalone pnpm workspace.

Pages become structured text with a numbered inventory of interactive elements, and the model addresses those elements by number. `browser_snapshot` pairs that text with a screenshot of the same moment, and `browser_capture` returns a screenshot on demand — both only for image-capable models, and both kept in memory: the extension never writes the image to disk, while a text-only route degrades to the text snapshot with a named reason.

> [!IMPORTANT]
> The migration branch's runtime pin is `0.1.5-rc.1` (raised from `0.1.2-rc.1` to `0.1.5-alpha.1` on 2026-09-09, then to `0.1.5-rc.1` on 2026-09-10; see the [upgrade note](docs/dsh-0.1.5-rc-upgrade.md)); it moves to the stable `0.1.5` tag when that is published on npm.

## Quick install

The standard `dsh plugin` command alone cannot install this project. The integration contains both a dsh bridge plugin and a browser extension. The one-line installer currently sets up the Chrome build.

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

Windows, in PowerShell:

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

When the installer opens `chrome://extensions`, follow its instructions to load or reload **AI Browser Assistant**. If dsh is already running, restart it after installation. See [Detailed installation and usage](#detailed-installation-and-usage) for prerequisites, startup commands, updates, and developer installation.

> [!IMPORTANT]
> The unscoped [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) package on npm belongs to a different project and is not affiliated with this repository. This project is not currently published as an npm package; use the installer above.

## Performance

In a paired 60-run end-to-end benchmark on August 18, 2026, both backends completed all 30 assigned runs successfully, while dsh Browser Control required fewer model/tool round trips and finished faster:

| Backend | Success | Mean end-to-end latency | Mean browser tool calls |
|---|---:|---:|---:|
| **dsh Browser Control** | **30/30** | **5.32 s** | **3.4** |
| Matched Playwright baseline | 30/30 | 6.67 s | 4.7 |

The paired Playwright / extension duration ratio was **1.24** (95% CI **1.16–1.34**): Playwright took about 24% longer, or equivalently, dsh Browser Control reduced latency by about 20% and saved 1.35 seconds per task on average. The suite used six browser tasks, five deterministic seeds, the same DSH profile and model (`deepseek-v4-flash`), and independently validated page state. See the [benchmark methodology and reproduction guide](benchmark/README.md).

## Core capabilities

| Capability | Tool | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Structured text snapshot: title, URL, main text, numbered controls, and masked form fields; `delta: true` returns only changes; carries a same-moment screenshot unless `visual: false` |
| Capture the page | `browser_capture` | Screenshot of the viewport (or the whole page with `fullPage: true`) delivered as an image; never written to disk. Prefer the viewport — a long page's full-page capture is scaled to the model's image budget, so its text is not legible |
| Read console and network | `browser_console` / `browser_network` | Console messages and uncaught errors with a cursor; request list with status and timing, one response body by id, and in-memory response overrides |
| Answer a page dialog | `browser_dialog` | Accept or dismiss an `alert` / `confirm` / `prompt`; such a dialog freezes the page, so every other tool blocks until it is answered |
| Run page JavaScript | `browser_eval` | Evaluate an expression in the page's own context; page CSP does not block it, and every call is approved on its own |
| Block or rewrite requests | `browser_block` / `browser_headers` | Block matching requests, or rewrite request/response headers — scoped to the controlled tab and session-only |
| Click element | `browser_click` | Click by inventory number, or by CSS selector when a control has no usable inventory entry (icon-only buttons) |
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
| Export a Google file | `google_drive_export` | Docs and Sheets only; Slides and Drive files are ordinary pages read with the browser tools |
| Wait for stability | `browser_wait` | Page-load and render-settle detection |

## Repository layout

```
packages/browser/bridge-browser/
  cordis.patch.yml
extensions/dsh-browser/
.dsh/skills/
scripts/install.sh
scripts/install.ps1
scripts/install-skills.mjs
```

## Why this design

- **Your real browser, not a headless copy**: the model works in the page you already have open, retaining logins, sessions, and cookies.
- **A text-first page interface**: numbered controls, stable IDs across snapshots, delta updates, and masked sensitive values make pages operable without screenshots.
- **A narrow privacy boundary**: passwords and payment-card values are always rendered as `••••` and never leave the page.
- **A guarded bridge**: authenticated handshakes protect remote connections, the bridge services only browser tool frames and two bridge-internal RPCs, and the extension binds tools to one user-controlled tab.

## Detailed installation and usage

Requirements: Node.js `^22.19` or `>=24`, Corepack/pnpm, and Chrome 116+. Windows additionally needs Windows PowerShell 5.1, which ships with Windows, or PowerShell 7+.

### Install or update

For a managed installation, run:

```sh
curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

or, on Windows:

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

The installer downloads `main`, builds and registers the bridge plugin, builds the Chrome extension into `~/.dsh/browser-extension`, and opens `chrome://extensions`. On the first install, load that directory as an unpacked extension; on updates, click **Reload**. Restart dsh if it is already running.

`scripts/install.sh` covers macOS and Linux, and `scripts/install.ps1` covers Windows; both write the same managed workspace and the same install metadata. The installer copies the extension path to the clipboard when a clipboard tool is available (`pbcopy`, `wl-copy`, `xclip`, `xsel`, or PowerShell's `Set-Clipboard`), and prints the path either way. When no Chrome or Chromium install is found, it prints the command that installs one; set `DSH_INSTALL_BROWSER=1` to let the installer attempt that install itself.

The Windows command downloads `install.ps1` and runs it rather than piping it into `Invoke-Expression`: the script is UTF-8 with a byte order mark so Windows PowerShell renders its Chinese output, and `Invoke-Expression` rejects a leading mark.

To install the current branch from a source checkout instead:

```sh
git clone https://github.com/Lum1104/dsh-browser.git
cd dsh-browser
./scripts/install.sh
```

On Windows, run `.\scripts\install.ps1` from the checkout instead. After pulling or switching revisions, rerun the installer and reload the extension.

### Skills shipped with this repository

The repository also ships the operational knowledge that goes with these tools, as skills under `.dsh/skills/`. They live in the repo so a change in browser behaviour and the advice about that behaviour are reviewed and committed together, and they are installed into `~/.dsh/skills/` so that a session in **any other workspace** can use them — the skill filesystem provider scans the project root at rank 100 and the user's `~/.dsh/skills` at rank 400, so the repo copy alone would only reach sessions started inside this repo.

`scripts/install-skills.mjs` (step 4 of the installer, or `pnpm run skills:install`) links each skill into `~/.dsh/skills`; `--copy` copies instead, which is what the Windows installer uses because creating a link there needs Developer Mode or elevation. A symlink is the default on macOS and Linux, so editing the repo copy takes effect with no reinstall and the installed skill cannot drift from it. A skill is only loaded when its description matches what the session is doing — `google-slides-via-browser`, for example, loads when the controlled tab is a Google Slides editor.

### Start and use

Start the managed installation with:

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

From a source checkout, run `pnpm start` in the repository root. The exact supported public runtime is currently the pinned 0.1.5 pre-release:

```sh
npx @deepseek-ai/dsh@0.1.5-rc.1 web
```

Local Chrome use requires no configuration. Open an `http://` or `https://` page, click the DeepSeek whale icon, and wait for **Connected**. Existing tabs are instrumented on the first action; protected browser pages and extension stores are not supported.

## Troubleshooting

**Status panel stays "Not connected"**

- Make sure dsh web is running locally (default `http://127.0.0.1:3080`).
- Verify the bridge is loaded: open `http://127.0.0.1:3080/ext/bridge-config`. It should return JSON such as `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}`. If it returns a web page instead of JSON, the running dsh predates the bridge registration — restart dsh and refresh the page; the extension reconnects on its own.
- The extension probes ports 3080, 3081, 3090, 14389, and 43189 (dsh Desktop) automatically. If dsh runs on another port — or you use a remote `--host 0.0.0.0` deployment — set the address (and bridge token) in the extension options.

## Development

The bridge plugin and Chrome extension are both members of this repository's workspace. Run all commands from the repository root. For the first development installation, run `pnpm install`.

```sh
pnpm run build
pnpm run typecheck
pnpm run test

pnpm --filter @yuxianglin/dsh-bridge-browser run build
pnpm --filter @yuxianglin/dsh-bridge-browser run typecheck
pnpm --filter @yuxianglin/dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run test
```

Notes:

- The bridge plugin must have a built `lib/` before startup because the loader consumes it; both `scripts/install.sh` and the root `pnpm run build` build the plugin before the extension.
- The dependencies of `@deepseek-ai/dsh` and the bridge plugin are pinned to the same tested public release line. An upgrade must update the manifests and lockfile together and rerun the root checks.

## Security

- The bridge path sits outside the `/api` trust boundary and performs its own bearer-token authentication.
- Local Chrome extension origins retain zero-configuration loopback access.
- Privileged gateway methods such as `settings.*`, `credentials.*`, and `host.open*` reject non-loopback sources.
- Page reads are text by default: `browser_snapshot` adds a screenshot unless the current model route declares no image input. Console, network, evaluation, blocking, and header rules use the extension's `debugger` and `declarativeNetRequestWithHostAccess` capabilities; screenshots use `debugger` (Chrome shows its usual debugging notice while a capture runs) and stay in memory — nothing is written to disk. Password and payment-card values never leave the page.
- When the assistant starts operating a page, it binds to the then-active tab at the first browser-tool call. If you switch tabs manually, later browser actions pause and the assistant asks whether it should continue on the original tab or follow the new one. Choosing the original tab permits background operation; the extension never silently retargets or changes your visible tab. Closing the controlled tab also pauses tools until the next call binds a page you explicitly choose.
- Page-authored text is wrapped as untrusted input. The default `auto` mode reads only the controlled tab without an extra prompt; privacy-sensitive users can select `ask` for per-read confirmation or `off` to block reads entirely. In `ask` mode, the read dialog can allow one read or persistently switch back to `auto`; this can be reversed in Settings. Read page text is sent to the selected model.
- The first browser tool call of a session binds the tab that is active at that moment, and the session then keeps operating *that* tab: looking at another page (Gmail, another tab, the dsh page) neither interrupts it nor withdraws a prompt that is waiting for your approval — the prompt lives in the dsh page, so you have to be able to switch to it and answer. Only losing the bound tab pauses the session, until the next call explicitly picks a page; the extension never silently rebinds to another tab.
- Click, type, keypress, navigation, history, and reload calls fail closed until the user approves them. A session's first `browser_navigate` opens its new tab only after that approval, so a denied or unanswered call issues no request at all. Google Drive exports are approved the same way — scoped to the document host, and skipped once that origin is trusted. An origin may be trusted for the current session, while permanent trust is managed explicitly in the extension options. Explicit cross-origin `browser_navigate` calls and unknown history destinations always prompt again.
- Actions that cannot be scoped to one origin (`browser_eval`, `browser_headers`, `browser_dialog`, `browser_network` with `mock`/`mockClear`, history moves) have no "Trust this site" and offer "Allow in this session" instead: remembered per session and per action, they stop prompting for that action until the session unbinds, is explicitly bound to another tab, loses its tab, or the browser session ends. `browser_navigate` is not among them — its risk is the destination, so a session grant would turn one approved destination into permission to go anywhere for the rest of the session; it keeps prompting per destination (per-site trust stops those prompts when the destination is a single origin). A prompt that expires unanswered (60 seconds) can still be re-raised by calling the same tool again.
