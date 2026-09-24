/**
 * `@yuxianglin/dsh-bridge-browser`: token-authenticated WebSocket bridge for
 * the browser extension plus the text-only `browser_*` tool set.
 *
 * The bridge mounts its own upgrade route (`/ext/bridge`) on the host
 * webserver, OUTSIDE the /api trust fence — so it brings its own bearer-token
 * authentication (first frame `hello` within HELLO_TIMEOUT_MS). It is a pure
 * tool channel: it carries browser tool frames plus the two bridge-internal
 * RPCs (gdrive move/folder reveal) and no chat or gateway passthrough. Tools execute by dispatching `tool.call` frames to the
 * connected extension, which performs the action in the tab explicitly
 * controlled by the user.
 *
 * Opt-in by design: nothing is registered unless this plugin appears in the
 * composition. No dsh core code is touched.
 *
 * @module @yuxianglin/dsh-bridge-browser
 */

import { describeRetention, nodeRetentionIo, pruneExports } from './gdrive-retention.ts'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, rename, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { BridgeServer } from './server.ts'
import { registerBrowserTools } from './tools.ts'
import { syncBundledExtension } from './extension-assets.ts'
import { BRIDGE_PROTO, BRIDGE_TOOLSET, declaredToolset, type BridgeCaps } from './protocol.ts'
import {
  BRIDGE_CONFIG_PATH,
  BRIDGE_PATH,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  MIN_SNAPSHOT_MAX_CHARS,
} from './protocol.ts'
import { resolveToken } from './token.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'bridge-browser'

/** Services required by this plugin. */
export const inject = ['webServer', 'tools', 'userQuestions']

/** Default per-tool-call budget (ms). */
const DEFAULT_TOOL_TIMEOUT_MS = 90_000

/** Default cap on interactive inventory items per snapshot. */
const DEFAULT_MAX_INTERACTIVE_ITEMS = 60

function sanitizePathSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'export' : cleaned.slice(0, 80)
}

/**
 * The part of the workspace service this plugin reads.
 *
 * The service is registered as `workspaceRegistry` (see
 * `@deepseek-ai/dsh-workspace`, which declares `Context.workspaceRegistry`),
 * and it is not one of this plugin's `inject` entries, so it is looked up
 * optionally: with no registry there is nothing archived, and nothing is
 * removed.
 */
interface WorkspaceArchiveSource {
  /** The registry-global archive set; sessions hidden from every surface. */
  archivedSessionIds: readonly string[]
}

/** The plugin context slice used for retention lookups and logging. */
interface RetentionContext {
  get(key: string): unknown
  logger?: { info(message: string): void; warn(message: string): void }
}

/** Read the archive set, treating an absent service or a fault as "nothing archived". */
function archivedSessionIdsOf(ctx: RetentionContext): readonly string[] {
  try {
    const registry = ctx.get('workspaceRegistry') as Partial<WorkspaceArchiveSource> | undefined
    return Array.isArray(registry?.archivedSessionIds) ? registry.archivedSessionIds : []
  } catch {
    return []
  }
}

/**
 * Run one retention pass over the export root and log what it did.
 *
 * Never rejects: this is called from the plugin's startup path, and a disk
 * problem there must not keep the bridge from loading.
 *
 * @param ctx - plugin context (workspace service and logger).
 * @param root - the export root.
 */
async function pruneGdriveExports(ctx: RetentionContext, root: string): Promise<void> {
  try {
    const outcome = await pruneExports(nodeRetentionIo(root), archivedSessionIdsOf(ctx))
    ctx.logger?.info(describeRetention(outcome))
  } catch (error: unknown) {
    ctx.logger?.warn(`browser bridge: gdrive retention failed — ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Reveal a folder in the system file manager (host side). */
function openFolder(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'explorer'
        : 'xdg-open'
    const child = spawn(opener, [path], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${opener} exited with code ${String(code)}`))
    })
  })
}

/** Plugin config: deployment-varying tunables only; the wire contract stays fixed. */
export interface Config {
  /** Fixed bearer token. When absent, a token is generated on first boot and persisted under the dsh home (0600). */
  token?: string
  /** Per-tool-call timeout in ms. Defaults to 90000. */
  toolTimeoutMs?: number
  /** Upper bound on one snapshot's rendered characters. Defaults to 32000; minimum 500. */
  snapshotMaxChars?: number
  /** Upper bound on interactive inventory items per snapshot. Defaults to 60. */
  maxInteractiveItems?: number
}

export const Config: z<Config> = z.object({
  token: z.string(),
  toolTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TOOL_TIMEOUT_MS),
  snapshotMaxChars: z.number().step(1).min(MIN_SNAPSHOT_MAX_CHARS).default(DEFAULT_SNAPSHOT_MAX_CHARS),
  maxInteractiveItems: z.number().step(1).min(1).default(DEFAULT_MAX_INTERACTIVE_ITEMS),
})

/** The shape after schemastery applies its defaults to every field. */
type ResolvedConfig = Required<Omit<Config, 'token'>> & Pick<Config, 'token'>

/** Configured budgets must be positive integers. Exported for validation tests. */
export function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`bridge-browser: ${name} must be a positive integer`)
  }
}

/**
 * Apply defaults and direct-call validation at the plugin boundary.
 * @param config - Loader-resolved or directly supplied plugin configuration.
 * @returns a complete configuration ready for runtime use.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    ...(config.token === undefined ? {} : { token: config.token }),
    toolTimeoutMs: config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    snapshotMaxChars: config.snapshotMaxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS,
    maxInteractiveItems: config.maxInteractiveItems ?? DEFAULT_MAX_INTERACTIVE_ITEMS,
  }
  assertPositiveInteger('toolTimeoutMs', resolved.toolTimeoutMs)
  if (!Number.isInteger(resolved.snapshotMaxChars) || resolved.snapshotMaxChars < MIN_SNAPSHOT_MAX_CHARS) {
    throw new Error(`bridge-browser: snapshotMaxChars must be an integer of at least ${MIN_SNAPSHOT_MAX_CHARS}`)
  }
  assertPositiveInteger('maxInteractiveItems', resolved.maxInteractiveItems)
  return resolved
}

/**
 * Mount the bridge: resolve the token, register the upgrade route, the tool
 * set, and an optional system-prompt section, all effect-scoped for HMR.
 *
 * @param ctx - Cordis context.
 * @param config - plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)

  const tokenRes = await resolveToken(resolved.token)

  const gdriveRoot = dshHomePath('gdrive')
  // Reclaim exported files whose session has been archived and whose directory
  // is past the retention window. Startup-only, never throwing: a full disk
  // must not stop the bridge from loading, and an unarchived session's exports
  // are never touched. Runs detached from the rest of `apply` so a slow
  // filesystem cannot delay the handshake path.
  void pruneGdriveExports(ctx, gdriveRoot)
  // Keep the directory Chrome loads in step with this build without rerunning
  // the installer: a rebuild plus a browser reload is then the whole update.
  // Detached like the retention pass — a slow or read-only disk must not delay
  // startup, and syncBundledExtension reports its faults instead of throwing.
  void syncBundledExtension().then((result) => {
    if (result.status === 'synced') {
      ctx.logger.info(`browser bridge: extension mirror refreshed (${result.files} files) at ${result.target}`)
    } else if (result.status === 'failed') {
      ctx.logger.warn(`browser bridge: extension mirror refresh failed — ${result.reason ?? 'unknown error'}`)
    }
  })
  // Assigned by the tools effect below; the server calls it on every hello,
  // replacement, and disconnect.
  let capabilitiesSync: ((caps: BridgeCaps | undefined) => void) | undefined
  // Last caps the server negotiated, sampled by `browser_status` for the
  // extension's own id and declared proto/toolset. `BridgeServer` exposes the
  // version and the debugger flag only, and this is the same sample those two
  // read, so it can never describe a socket that is gone.
  let latestCaps: BridgeCaps | undefined
  const server = new BridgeServer({
    token: tokenRes.token,
    toolTimeoutMs: resolved.toolTimeoutMs,
    onCapabilities: (caps) => {
      latestCaps = caps
      capabilitiesSync?.(caps)
    },
    openGDriveFolder: async () => {
      await mkdir(gdriveRoot, { recursive: true })
      await openFolder(gdriveRoot)
    },
    gdriveMoveIntoSession: async (sourcePath, sessionId) => {
      const base = basename(sourcePath)
      if (base === '' || base === '.' || base === '..') throw new Error('invalid download path')
      const sessionDir = join(gdriveRoot, sanitizePathSegment(sessionId))
      await mkdir(sessionDir, { recursive: true })
      const target = join(sessionDir, base)
      try {
        await rename(sourcePath, target)
      } catch {
        await copyFile(sourcePath, target)
        await unlink(sourcePath).catch(() => {})
      }
      return { filePath: target }
    },
    caps: {
      // This host's handshake version: an extension built after this plugin
      // reads the older number and tells the user to restart dsh.
      proto: BRIDGE_PROTO,
      // The toolset this host offers. An extension built before the newest level
      // reads the higher number and tells the user to reload the extension;
      // without it the surface silently shrinks and nothing names the cause.
      toolset: BRIDGE_TOOLSET,
      snapshotMaxChars: resolved.snapshotMaxChars,
      maxInteractiveItems: resolved.maxInteractiveItems,
    },
  })

  const route: WebUpgradeRoute = {
    path: BRIDGE_PATH,
    handler: (req, socket, head) => { server.handleUpgrade(req, socket, head) },
  }
  ctx.effect(() => ctx.webServer.registerUpgrade(route), 'bridge-browser: /ext/bridge upgrade route')
  // 异步 disposer：HMR/卸载时先等桥完全关闭（socket/泵/acceptor 静默）再继续。
  ctx.effect(() => () => server.close(), 'bridge-browser: bridge server')

  // Zero-config discovery endpoint: the extension fetches this to learn the
  // bridge WebSocket URL without any manual configuration. The URL carries no
  // secret (loopback connections skip the token); non-loopback deployments
  // keep requiring the token on the WS itself.
  const configRoute: WebRoute = {
    kind: 'exact',
    path: BRIDGE_CONFIG_PATH,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${ctx.webServer.port}${BRIDGE_PATH}` }))
    },
  }
  ctx.effect(() => ctx.webServer.register(configRoute), 'bridge-browser: /ext/bridge-config route')

  ctx.effect(() => {
    const tools = registerBrowserTools(ctx, server, {
      toolTimeoutMs: resolved.toolTimeoutMs,
      snapshotMaxChars: resolved.snapshotMaxChars,
      maxInteractiveItems: resolved.maxInteractiveItems,
      host: { clientCaps: () => latestCaps },
    })
    // The model only ever sees the debugging tools while the connected
    // extension allows them (its own setting, off by default), and only the
    // parameter shapes the connected extension implements. Until a hello
    // arrives the full surface is registered; an older extension narrows it.
    tools.setDebugToolsEnabled(server.clientDebugger())
    capabilitiesSync = (caps) => {
      tools.setDebugToolsEnabled(caps?.debugger === true)
      if (caps === undefined) return
      tools.setClientToolset(declaredToolset(caps))
      // The user may be looking at the dsh log rather than the extension UI, and
      // an extension old enough to need this has no way to report it itself.
      if (declaredToolset(caps) < BRIDGE_TOOLSET) {
        ctx.logger.warn(`browser bridge: the connected extension declares toolset ${declaredToolset(caps)} `
          + `(plugin speaks ${BRIDGE_TOOLSET}): selector targets and the DOM/rule tools stay hidden — `
          + 'reload the extension from chrome://extensions to get them back')
      }
    }
    return () => {
      capabilitiesSync = undefined
      tools.dispose()
    }
  }, 'bridge-browser: browser tools')

  // Optional system-prompt contribution: a one-line hint only — the model is
  // told to fetch snapshots on demand instead of hoarding page text.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser',
      order: 107,
      text: 'A browser bridge may be connected. To read or operate the user\'s active browser page, call browser_snapshot '
        + '(numbered items are the click/type targets; it also returns a screenshot of the same moment unless you pass visual:false), '
        + 'unless the current turn already includes a plugin-provided '
        + 'followed-page browser_snapshot. Reuse that injected snapshot and its indices directly. Never assume page content you have not snapshotted. '
        + 'When an investigation arrives with a web page link, do not open with the bridge: search the local codebase first for how that page and its operations work, '
        + 'so you have the operational and business context, and combine it with the background the task gives you to decide what actually needs verifying in the browser. '
        + 'An empty code search proves nothing: page errors often come from server-side configuration (rules, feature flags, database rows) rather than code, '
        + 'so follow up with browser_console / browser_network and read the page itself before concluding that the behaviour does not exist. '
        + 'Call browser_capture when the question is visual — layout, styling, a canvas or chart, or whether something rendered — and pass '
        + 'visual:false on browser_snapshot when you only need updated text. '
        + 'When the question is about a picture the page embeds (a chart, diagram, or screenshot), address it with browser_dom_query and then call '
        + 'browser_image on that element: it returns the picture itself at its original resolution and needs no screenshot, so it also works while DevTools '
        + 'is open. Use browser_capture when the question is about how the page looks as rendered. '
        + 'To answer "what does this page or section say", read the text once — browser_get_text, optionally with a selector, or with find + context to jump '
        + 'straight to a phrase — and slice it yourself; do not script several browser_eval rounds to hunt through the DOM. Reach for browser_capture when the '
        + 'question is about appearance or when the content is drawn into a canvas or image, and note that a capture needs that tab free of DevTools. '
        + 'If a call hangs or the page stops responding, a JavaScript dialog is usually holding the renderer: answer it with browser_dialog. '
        + 'When the page misbehaves, browser_console and browser_network read the tab\'s console and requests (Chrome builds), '
        + 'browser_network mock replaces a response, browser_eval runs page-context JavaScript, and browser_block / browser_headers '
        + 'block or rewrite matching requests in the controlled tab. '
        + 'When the user asks to bind this session to a specific open page (for example "bind to the page"), call browser_bind_interactive — '
        + 'it lists the pages, asks the user, and binds in one step. '
        + 'One session operates the browser at a time: if another session already holds the controlled tab, binding fails and names that session, and so does '
        + 'a first browser_navigate. Nothing runs in that case — ask the user to press Unbind in the dsh browser panel (or to keep working in the other '
        + 'session and bring its answer back here) instead of retrying the call. '
        + 'When browser tools cannot connect, or a browser tool seems to be missing, call browser_status first: it names the single next action. '
        + 'On a first install, or when browser_status reports refreshed extension files, call browser_setup to prepare the files and open the extensions page. '
        + 'When a browser tool reports that no page is bound, or that the controlled tab is gone, do not retry the same call: call browser_navigate with the '
        + 'target URL (it opens a new tab and binds this session to it), or browser_bind_interactive to let the user choose among the pages already open. '
        + 'A refused call is not a transient error — follow the route the refusal names instead of retrying variants of it. '
        + 'A refusal is a boundary, not a puzzle: never look for another transport to reach the same content (curl, a reader proxy, an unauthenticated '
        + 'export URL, or a different tool) — that circumvents the user\'s gate rather than solving the task. If two tools each name a route the other '
        + 'refuses, or a refusal names a route that cannot work for this content, stop and tell the user what contradicted and what you need, instead of '
        + 'probing the policy with trial calls. '
        + 'Only Google Docs (/document/d/…) and Sheets (/spreadsheets/d/…) links are exported: call google_drive_export for those instead of '
        + 'browser_navigate. Slides, Drive files, and every other link are ordinary pages — read them with the browser tools (browser_navigate to one, '
        + 'then browser_snapshot, browser_capture, or browser_dom_query), and never try to read them through HTML views or page tools when they are one '
        + 'of the two exported kinds. For spreadsheets: the tool downloads the workbook and asks which sheet to analyze; answer with a sheet name or "all". A browser action may wait for the user to confirm it in the assistant window; the call returns only after the decision. If an action seemingly changed nothing after confirmation, take a fresh browser_snapshot before concluding. Snapshot text is charged to the conversation context, so read economically: while a page is still loading use browser_wait instead of repeating browser_snapshot; use delta:true for consecutive reads of the same page, region to scope a read, and maxChars when only a bounded excerpt is needed.',
    }), 'bridge-browser: system prompt section')
  }

  ctx.logger.info(
    tokenRes.generated
      ? `browser bridge: new token generated and persisted at ${tokenRes.file} (chmod 0600); connect the extension and paste it in its settings`
      : `browser bridge: using token from ${tokenRes.file}`,
  )
  ctx.logger.info(`browser bridge: listening on ${BRIDGE_PATH}`)
}
