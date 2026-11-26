# dsh Browser Control

**English** | [中文](README.zh.md)

<img width="1701" height="897" alt="dsh Browser Control" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to the Chrome tab you already use. The model can read a page, click controls, fill forms, scroll and navigate, while your login state, sessions and cookies stay in your browser. Click the toolbar icon to open the status view: what it is connected to, which page is under control, and which approvals are waiting for you.

`dsh` is DeepSeek AI's open-source, plugin-based agent harness. This repository ships its companion browser bridge plugin and Chrome MV3 extension as one standalone pnpm workspace.

A page becomes structured text plus a numbered inventory of interactive elements, and the model addresses those elements by number. `browser_snapshot` returns that text together with a screenshot of the same moment; `browser_capture` returns a screenshot alone. Screenshots stay in memory and are never written to disk, and a text-only model gets the text snapshot instead. Screenshots go through `chrome.debugger`, so they need "Allow browser debugging" in the extension options.

Three choices shape it: it drives your real browser rather than a headless copy, so your logins still apply; the page interface is text first and screenshots second; and everything that needs the debugger stays unregistered until you turn it on.

> [!IMPORTANT]
> The unscoped [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) package on npm belongs to a different project and is not affiliated with this repository. This project is not published as an npm package; use the installer below.

## Quick install

The installer sets up both halves — the dsh bridge plugin and the Chrome extension — in one command.

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

The installer does four things:

1. Puts the repository at `~/.dsh/dsh-browser` (or uses the checkout it was run from), runs `pnpm install`, then builds the extension first and the bridge plugin second.
2. Registers `dsh-bridge-browser` with the local dsh `web` profile; older package names are removed first.
3. Installs the bundled skills into `~/.dsh/skills`, where sessions in every workspace can load them.
4. Mirrors the extension build to `~/.dsh/browser-extension`, writes `install-info.json` there, opens `chrome://extensions`, and copies the extension directory to the clipboard.

One click is left: load `~/.dsh/browser-extension` as an unpacked extension in `chrome://extensions`. If the “AI Browser Assistant” card is already there, click **Reload** on it. A running dsh usually picks the plugin up within seconds; if it does not, restart dsh once.

To update, rerun the same install command and click **Reload** in Chrome again. If you are unsure which command applies, ask the assistant to run `browser_update`: it prints the one for this machine and never runs it.

## Requirements

| Item | Requirement |
|---|---|
| Browser | Chrome 116 or newer (the extension's `minimum_chrome_version`). The installer also recognises Chromium; other Chromium-based browsers are untested |
| Node.js | Follows the dsh version pinned in this workspace, which currently requires `^24.22.3 \|\| >=26.13.1`. The installer only checks that `node` exists; a mismatched version fails inside dsh |
| pnpm | Enable it through Corepack. The workspace declares `packageManager: pnpm@11.7.0` |
| Extra installer dependencies | macOS/Linux also need `curl`, `tar` and `rsync`; Windows needs the built-in PowerShell 5.1 or PowerShell 7+ |

## Start

For a managed install:

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

From a checkout, run `pnpm start` in the repository root. It is `dsh web`, listening on `http://127.0.0.1:3080` by default; `dsh` comes from this workspace's own dependencies, so nothing else has to be installed.

Open any `http://` or `https://` page and wait until the status view says **connected**. Browser pages such as `chrome://`, the extension store, and other extensions' own pages cannot be operated.

## Tools

| Tool | What it does |
|---|---|
| `browser_snapshot` | Reads the current page: title, URL, main text, numbered interactive inventory, form fields (sensitive values masked). `delta: true` returns only changes; `visual: false` omits the screenshot |
| `browser_capture` † | Screenshot of the viewport, or the whole page with `fullPage: true`; kept in memory only. Prefer the viewport — a full-page capture of a long page is scaled into the model's image budget and its text becomes unreadable |
| `browser_console` † / `browser_network` † | Console messages and uncaught errors (incremental, by cursor); request list with status and duration, response bodies by id, and in-memory response overrides |
| `browser_eval` † | Evaluates JavaScript in the page's own context, unaffected by the page's CSP |
| `browser_dialog` † | Answers an `alert` / `confirm` / `prompt`. Such a dialog freezes the page: page-facing tools are refused while it is open, and the dialog text is quoted back |
| `browser_debug` † | Line and XHR/fetch breakpoints, pause/resume/step, reading a pause with its call frames, evaluating in a paused frame, and listing scripts and event listeners |
| `browser_cookies` | Reads, writes and deletes site cookies over CDP, including HttpOnly ones `document.cookie` cannot see; a write enters the browser cookie jar, so later navigations carry it |
| `browser_block` / `browser_headers` | Blocks matching requests, or rewrites request/response headers; scoped to the controlled tab and to the current browser session |
| `browser_click` | Clicks by inventory number or CSS selector; a native `<select>` is set through `option`, by value or visible text |
| `browser_click_pointer` | Dispatches a full pointer-event sequence at the element's centre; for canvas editors such as Google Slides, where `browser_click` reports success but nothing happens |
| `browser_slides_open_page` | Opens one page of a Slides deck by page number, more reliably than pressing filmstrip thumbnails |
| `browser_type` / `browser_press` / `browser_scroll` | Types text (`replace` clears first, React/Vue controlled components included), presses a key, scrolls the viewport |
| `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | Navigation, history and reload inside the controlled tab |
| `browser_get_text` | Reads partial or lazily loaded text; `find` locates a phrase and returns a bounded window |
| `browser_dom_query` | Reads chosen fields off elements matching a CSS selector, each match carrying a verified unique selector |
| `browser_image` | Returns a picture the page embeds (img/canvas/SVG/background) at its original resolution; needs no debugging capability |
| `browser_wait` | Waits for loading and rendering to settle |
| `browser_bind_interactive` | Lists the bindable pages and lets the user bind one to this session |
| `browser_status` / `browser_setup` / `browser_update` | Bridge health report, re-mirroring the extension files, printing this machine's update command |
| `google_drive_export` | Exports a Google Doc or Sheet; only those two link types, every other Google link is read as an ordinary page |

† These six tools run over `chrome.debugger` and are controlled by **“Allow browser debugging”** in the extension options, which is off after a first install. While it is off the plugin does not register them at all, so the model cannot see them; turning it on reconnects the bridge and the capability arrives with the handshake. `browser_snapshot` itself is unaffected, but the screenshot it attaches by default needs the same debugger — with the switch off it returns text and names the reason. Chrome refuses a second debugger while DevTools is open on the same tab, and the tool says so.

A second gate is the extension's **toolset level**: `browser_cookies`, the `option` argument of `browser_click`, `browser_slides_open_page`, `browser_click_pointer`, `browser_image`, `find` in `browser_get_text`, and CSS selector targets were added level by level (levels 1–8). An older extension build lacks those tools or arguments; `browser_status` reports the level mismatch and tells you to reload the extension.

## Approvals and trust

State-changing calls fail closed — without your approval they do nothing: `browser_click`, `browser_click_pointer`, `browser_type`, `browser_press`, `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`, `browser_block`, and Google Drive exports. A denied or unanswered call issues no request at all.

An approval card offers two kinds of standing answer:

- An action that can be pinned to one site offers **Trust this site**. The grant is stored in the extension settings and managed explicitly on the options page.
- An action with no **Trust this site** option offers **Allow in this session** instead: JavaScript evaluation, JavaScript debugging, header rewriting, JavaScript dialog answers, cookie reads and writes, response overrides, history moves. The grant is remembered per session and per action — split by site where a site can be named — and dies when the session unbinds, is bound to another tab, loses or replaces its tab, or the browser session ends.
- `browser_navigate` gets no session-wide grant, because one approved destination must not become permission to go anywhere for the rest of the session; it asks per destination and can remember that destination.
- `browser_eval` asks on every call by default; a card can allow it for the session, or site trust can cover JavaScript execution through a separate switch in the options page.

Page reads follow **page content sharing**, which covers `browser_snapshot`, `browser_get_text`, `browser_dom_query`, `browser_image`, `browser_capture`, `browser_console` and `browser_network`. The default, “auto”, reads only the controlled tab with no extra prompt; “ask” confirms each read, either once or by switching back to auto; “off” blocks reads entirely. Text that is read is sent to the selected model.

Navigation reaches only the host of the currently controlled page by default; to switch hosts, bind to the target page or use an unbound session's first navigation, which opens a new tab and binds it. **Allow cross-domain navigation** lifts the restriction. Settings also carry a **blocked sites** list, and a blocked origin refuses both reads and operations. Google Drive exports are approved the same way, scoped to the document's site and skipped once that site is trusted.

Approval cards appear in the dsh page, so you have to be able to switch back to it and answer. A card that goes unanswered for 60 seconds expires; calling the same tool again re-raises it.

## Tab binding

An unbound session's `browser_navigate` takes the other path: after approval it opens a new tab in the background and binds the session to it, without taking over the page you are reading. Every other page tool lists the bindable pages instead (HTTP/HTTPS only, excluding dsh's own pages and the browser's protected pages): exactly one is bound silently, a real choice raises a pick dialog answerable for a minute, and the call then runs. Tools refused in the same step share one dialog and each rerun once a page is bound.

A session that has a page is never moved on its own, not even when you switch to another tab. If its page becomes one no extension may touch (`chrome://`, another extension's page, a local file), the call fails and says so, with three ways out: switch to an ordinary page and press Unbind, call `browser_navigate` to open one, or call `browser_bind_interactive` to pick an already open page. Nothing rebinds for you in that case.

When the controlled tab closes, the extension keeps looking for it for another 60 seconds (the failing call waits 2 of them); if it comes back the session is silently rebound, otherwise it pauses until the next call binds a page.

The options page also has **follow origins**: a page newly opened on one of those origins becomes the controlled page automatically. Only pages opened after binding are followed, nothing is followed by default, a page in another environment asks first, and a followed page that closes hands the browser back to the previous one.

One extension connection serves one session at a time, and a new connection replaces the old one. A second session's bind is refused with the holder's session id instead of stealing the tab.

## Status view and session indicator

Click the toolbar icon (the DeepSeek whale) to open the status view. It is a floating window by default and can be switched to Chrome's side panel in the options page: it shows the connection state, the controlled tab, the grants this session holds and recent operations, and lists the approvals waiting for you. When no window can show an approval, system notifications can be enabled.

The dsh Web GUI sidebar marks the session that currently holds the controlled tab with a small globe icon, coloured like that row's status dot. It is a marker, not a button. It appears and disappears with the binding state the extension reports: the socket frame carries the session id, tab id, window id and tab title, while the `GET /bridge-browser/bindings` route the GUI reads exposes only session id and tab id. Page URLs and contents never leave the extension. The route sits outside `/api` and applies the same Host/Origin and browser-auth checks as the rest of the GUI.

## Troubleshooting

| Symptom | What to do |
|---|---|
| The status view keeps saying “not connected” | Check that dsh web is running, then open `http://127.0.0.1:3080/ext/bridge-config` in the browser. It should return JSON shaped like `{"wsUrl":...}`. A web page instead means the running dsh predates the bridge registration — restart dsh and the extension reconnects |
| dsh is not on port 3080 | The extension probes 3080/3081/3090 (dsh web), 43189 (DSH Desktop) and 14389 (the old desktop port). When dsh runs on another port on this machine, set the address and token in the extension options |
| The bridge runs on another machine | The extension's CSP allows only `ws://127.0.0.1:*`, `http://127.0.0.1:*` and raw.githubusercontent.com, so a remote address is blocked by the browser; a remote bridge cannot be reached today |
| Screenshot, console, network, eval, dialog or debug tools are missing | Turn on “Allow browser debugging”; the bridge reconnects and the capability arrives. `browser_debug` additionally needs extension toolset level ≥ 7, which older builds do not have |
| “Another debugger is already attached” | DevTools is open on the controlled tab. Close DevTools there and retry |
| “The page is paused on a breakpoint” | Read the pause with `browser_debug { action: "wait" }`, then `resume` or `step`. `browser_console` and `browser_network` keep working meanwhile |
| It says another session is operating the browser | Unbind in that session, or end it |
| You cannot tell what is wrong with the bridge | Ask the assistant for “browser bridge status”. `browser_status` reports the connection, the extension version, whether protocol and toolset match, whether the mirrored files are current, recent debug events, and the single next step; `browser_setup` re-mirrors the extension files |

## Development

The bridge plugin and the Chrome extension share one workspace; all commands run from the repository root.

```sh
pnpm install
pnpm run build        # build the extension first, then the bridge plugin, which packages the extension
pnpm run typecheck
pnpm run test         # installer encoding checks, skill checks, then both packages' vitest suites
pnpm run skills:install
```

Per package:

```sh
pnpm --filter dsh-bridge-browser run build
pnpm --filter dsh-bridge-browser run typecheck
pnpm --filter dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build   # output: extensions/dsh-browser/dist
pnpm --filter dsh-browser-extension run test
```

Notes:

- The bridge plugin needs `lib/` before the Loader can mount it, which is why the order cannot be swapped.
- The workspace pins all `@deepseek-ai` dependencies to one batch (currently `0.2.3-alpha.2`, see `package.json`). The bridge declares a peer range of `>=0.1.7-rc.1 <0.3.0`, so one build of the plugin mounts on any dsh in that range; an upgrade must update the manifests and lockfile together and rerun the root checks.
- `docs/` holds the upgrade history (0.1.5-alpha → 0.1.5-rc → 0.1.7-rc) and several research notes. The 0.2.x upgrade has not been written up yet.

## Security

- The bridge sits outside the `/api` trust fence and performs its own bearer-token authentication (the token lives in `~/.dsh/ext-bridge-token`, mode 0600). Loopback access without a token needs three things at once: a loopback peer, an Origin of the pinned extension id, and a matching extension id declared in the handshake.
- One extension connection is accepted at a time; a new one replaces the old, which is closed as replaced.
- One controlled tab belongs to one session, and page-authored text is marked as untrusted input.
- The `chrome.debugger` capabilities are off by default and their tools are not registered while off. Chrome shows its usual debugging notice while a session is attached, and screenshots stay in memory — nothing is written to disk.
- Password and payment-card fields are shown as `••••` in a snapshot; their values never leave the page.
- Clicks, typing, keypresses, navigation, reload and request blocking fail closed until approved; cross-domain navigation is off by default; sites can be blocked outright.

## Repository layout

```
packages/browser/bridge-browser/   Bridge plugin: the WebSocket carrier and the browser_* tool set
extensions/dsh-browser/            Chrome MV3 extension (background, content script, status view, options)
.dsh/skills/                       Skills shipped with this repository
scripts/install.sh                 Installer (install.ps1 on Windows)
scripts/install-skills.mjs         Skill install (step 3 of the installer)
docs/                              Upgrade history and research notes
```

Each half has its own README: [bridge plugin](packages/browser/bridge-browser/README.md) and [extension](extensions/dsh-browser/README.md). Operating know-how lives in the two skills under `.dsh/skills/`.

This repository is a fork of [omdsh-dev/dsh-browser](https://github.com/omdsh-dev/dsh-browser).
