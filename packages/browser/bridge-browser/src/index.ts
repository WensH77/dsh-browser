/**
 * `dsh-bridge-browser`: token-authenticated WebSocket bridge for
 * the browser extension plus the text-only `browser_*` tool set.
 *
 * The bridge mounts its own upgrade route (`/ext/bridge`) on the host
 * webserver, OUTSIDE the /api trust fence — so it brings its own bearer-token
 * authentication (first frame `hello` within HELLO_TIMEOUT_MS). It is a pure
 * tool channel: it carries browser tool frames plus the five bridge-internal
 * RPCs (gdrive move/folder reveal, the UI-language and tool-waiting reports,
 * and the update command) and no chat or gateway passthrough. Tools execute by dispatching `tool.call` frames to the
 * connected extension, which performs the action in the tab explicitly
 * controlled by the user.
 *
 * Opt-in by design: nothing is registered unless this plugin appears in the
 * composition. No dsh core code is touched.
 *
 * @module dsh-bridge-browser
 */

import { describeRetention, nodeRetentionIo, pruneExports } from './gdrive-retention.ts'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/** The one skill this package bundles, under `assets/<this name>/SKILL.md`. */
const BUNDLED_GUIDE_NAME = 'dsh-browser-bridge-guide'

/**
 * Precedence rank of a packaged skill provider.
 *
 * Deliberately the same 600 that `@deepseek-ai/dsh-skill` exports as
 * `BUNDLED_SKILL_RANK`: the package does not depend on that module, and the
 * value is registry policy rather than a wire contract.
 */
const BUNDLED_SKILL_RANK = 600

/** Provider name for the bundled guide, distinct from the filesystem's. */
const BUNDLED_GUIDE_PROVIDER = 'dsh-browser-bridge'

/**
 * The part of the skill registry this plugin uses, declared structurally.
 *
 * Deliberately not `import type { SkillRegistry } from '@deepseek-ai/dsh-skill'`:
 * the bridge plugin does not declare that package, and it must keep working in a
 * composition that mounts no skills service at all. The three members below are
 * the whole contract the provider needs — `registerProvider` for the
 * registration effect, and the provider's own `name`/`list`/`get`.
 */
interface SkillProviderControlLike {
  readonly signal: AbortSignal
  readonly invalidate: () => void
}

interface SkillCandidateLike {
  readonly name: string
  readonly description: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly provider: string
  readonly source: string
  readonly rank: number
  readonly resourceBase: { readonly kind: 'directory'; readonly path: string }
  readonly locator: string
}

interface SkillProviderLike {
  readonly name: string
  readonly list: (options: { cwd?: string | undefined; signal?: AbortSignal | undefined }) =>
    Promise<readonly SkillCandidateLike[]>
  readonly get: (candidate: SkillCandidateLike, options: { cwd?: string | undefined; signal?: AbortSignal | undefined }) =>
    Promise<Record<string, unknown> | undefined>
}

interface SkillsRegistryLike {
  registerProvider(create: (control: SkillProviderControlLike) => SkillProviderLike): () => void
}

/** Directory holding the packaged skill bundles; siblings of this module. */
function packagedAssetRoot(): string {
  return fileURLToPath(new URL('../assets/', import.meta.url))
}

/**
 * Read the `name` and `description` out of a SKILL.md's YAML frontmatter.
 *
 * Frontmatter-only parsing rather than a YAML dependency: these two scalar
 * fields are the whole contract (the registry names a skill from `name`, and the
 * catalog advertises the truncated `description`).
 *
 * @param markdown - the file contents.
 * @param path - the file path, for the error message.
 * @returns the two frontmatter fields.
 * @throws when either field is missing — a bundled skill with no name would be
 *   registered under a name no caller can address, and that must be loud.
 */
function parseSkillFrontmatter(markdown: string, path: string): { name: string; description: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
  const frontmatter = block?.[1]
  if (frontmatter === undefined) throw new Error(`bridge-browser: ${path} has no YAML frontmatter`)
  const name = /^name:[ \t]*(.+?)[ \t]*$/m.exec(frontmatter)?.[1] ?? ''
  const description = /^description:[ \t]*(.+?)[ \t]*$/m.exec(frontmatter)?.[1] ?? ''
  if (name === '' || description === '') {
    throw new Error(`bridge-browser: ${path} needs both a name and a description in its frontmatter`)
  }
  return { name, description: description.replace(/^['"]|['"]$/g, '') }
}

/**
 * Register the bundled bridge guide with whichever skills registry is mounted.
 *
 * Two distribution paths ship this skill on purpose: the repository installer
 * links `.dsh/skills/<name>` into the user skill root (so a session in any
 * workspace finds it), and this provider carries the same file inside the
 * package (so a composition that never ran the installer still has it). The
 * registry deduplicates by name and rank, so the two never appear as two
 * catalog entries.
 *
 * A missing skills service, or a missing asset, is reported and then ignored:
 * losing the guide costs advice, while failing here would cost the bridge.
 *
 * @param ctx - plugin context, read for the optional `skills` service.
 */
function registerBundledGuide(ctx: Context): void {
  const skills = lookupSkillsService(ctx)
  if (skills === undefined) {
    ctx.logger.info('browser bridge: no skills service mounted — the bundled guide skill is not registered')
    return
  }
  const assetRoot = packagedAssetRoot()
  const skillFile = join(assetRoot, BUNDLED_GUIDE_NAME, 'SKILL.md')
  let frontmatter: { name: string; description: string }
  try {
    frontmatter = parseSkillFrontmatter(readFileSync(skillFile, 'utf8'), skillFile)
  } catch (error: unknown) {
    ctx.logger.warn(`browser bridge: bundled guide skill unavailable — ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const candidate: SkillCandidateLike = {
    name: frontmatter.name,
    description: frontmatter.description,
    // Both surfaces: the model loads it as the recipe behind the prompt's
    // pointer, and a human may type `/<name>` to put it in the conversation.
    invocation: { modelInvocable: true, userInvocable: true },
    provider: BUNDLED_GUIDE_PROVIDER,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: join(assetRoot, BUNDLED_GUIDE_NAME) },
    locator: skillFile,
  }
  const skillLabel = candidate.name
  ctx.effect(() => skills.registerProvider(() => ({
    name: BUNDLED_GUIDE_PROVIDER,
    list: () => Promise.resolve([candidate]),
    // No abort signal on the read: this is one small file on the local disk, so
    // it settles long before a caller's cancellation, and passing a signal that
    // is no longer watched risks an unhandled rejection for no gain.
    get: async (loaded) => {
      const raw = await readFile(loaded.locator, 'utf8')
      const { rank: _rank, locator: _locator, ...summary } = loaded
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
      return { ...summary, content: body.trim() }
    },
  })), `bridge-browser: bundled guide skill (${skillLabel})`)
  ctx.logger.info(`browser bridge: bundled guide skill registered as "${skillLabel}"`)
}

/**
 * Find a mounted skills registry, tolerating its absence.
 *
 * `ctx.get` returns `undefined` for a service this composition does not mount,
 * and cordis throws for an undeclared service in some setups, so both outcomes
 * mean the same thing here: no registry, no bundled skill.
 *
 * @param ctx - plugin context.
 * @returns the registry slice, or undefined when nothing answers to `skills`.
 */
function lookupSkillsService(ctx: Context): SkillsRegistryLike | undefined {
  try {
    const service = ctx.get('skills') as Partial<SkillsRegistryLike> | undefined
    return typeof service?.registerProvider === 'function' ? service as SkillsRegistryLike : undefined
  } catch {
    return undefined
  }
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
  // 异步 disposer：HMR/卸载时先等桥接完全关闭（socket/泵/acceptor 静默）再继续。
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
      // Level first: the debugging surface is the intersection of "the user
      // allowed debugging" and "this build implements the tool", and a peer that
      // is below the level must never be handed a tool it would answer with
      // "Unknown action" — not even for the instant between these two calls.
      if (caps !== undefined) tools.setClientToolset(declaredToolset(caps))
      tools.setDebugToolsEnabled(caps?.debugger === true)
      if (caps === undefined) return
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

  // Register the bundled bridge guide as a skill, so the model can load the
  // tool-selection and troubleshooting recipe on demand instead of carrying it
  // in every turn. Optional lookup: a composition without the skills service
  // loses the skill, never the bridge.
  registerBundledGuide(ctx)

  // Optional system-prompt contribution: the behavioural invariants (do not
  // assert un-snapshotted page content, a refusal is a boundary, no retry of a
  // lost tab) plus a pointer to the guide, which holds the recipes.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser',
      order: 107,
      text: 'A browser bridge may be connected. To read or operate the user\'s active browser page, call browser_snapshot '
        + '(numbered items are the click/type targets; it also returns a screenshot of the same moment unless you pass visual:false), '
        + 'unless the current turn already includes a plugin-provided followed-page browser_snapshot. Reuse that injected snapshot and its indices '
        + 'directly instead of taking another one. Never assume page content you have not snapshotted. '
        + 'When an investigation arrives with a web page link, do not open with the bridge: search the local codebase first for how that page and its '
        + 'operations work, so you have the operational and business context, and combine it with the background the task gives you to decide what '
        + 'actually needs verifying in the browser. An empty code search proves nothing: page errors often come from server-side configuration '
        + '(rules, feature flags, database rows) rather than code, so follow up with browser_console / browser_network and read the page itself before '
        + 'concluding that the behaviour does not exist. To answer what a page or section says, read the text once and slice it yourself — do not '
        + 'script several browser_eval rounds to hunt through the DOM. When the question is about a picture the page embeds, address it with '
        + 'browser_dom_query and then browser_image, which returns the picture itself rather than a screenshot. '
        + 'A JavaScript dialog (alert / confirm / prompt) freezes the page it belongs to: page-facing tools are refused while one is open and the '
        + 'refusal quotes the dialog, so read it and answer with browser_dialog. '
        + 'To drive the page, troubleshoot it, or combine these tools, load the dsh-browser-bridge-guide skill; it carries the recipes — which tool '
        + 'reads text, how an embedded picture is fetched, when a capture is the right question, what a "clicked, but nothing changed" result means, '
        + 'how the tab\'s visible/focused state is reported, which link types browser_navigate opens as ordinary pages, how a Chrome confirmation '
        + 'relates to a call that seems to have changed nothing, and how to bind, install, and update the bridge. '
        + 'A refusal is a boundary, not a puzzle: never look for another transport to reach the same content (curl, a reader proxy, an unauthenticated '
        + 'export URL, or a different tool) — that circumvents the user\'s gate rather than solving the task. If two tools each name a route the other '
        + 'refuses, or a refusal names a route that cannot work for this content, stop and tell the user what contradicted and what you need, instead of '
        + 'probing the policy with trial calls. A refused call is not a transient error — follow the route the refusal names instead of retrying '
        + 'variants of it. '
        + 'Only /document/d/… and /spreadsheets/d/… links go to google_drive_export, and every other Google link — Slides included — is a page '
        + 'to open with browser_navigate, never through an HTML view or a page tool. '
        + 'One session operates the browser at a time: if another session already holds the controlled tab, binding fails and names that session, and so '
        + 'does a first browser_navigate. Nothing runs in that case — ask the user to press Unbind in the dsh browser panel (or to keep working in the '
        + 'other session and bring its answer back here) instead of retrying the call. When a browser tool reports that no page is bound, or that the '
        + 'controlled tab is gone, do not retry the same call: call browser_navigate with the target URL (it opens a new tab and binds this session to '
        + 'it), or browser_bind_interactive to let the user choose among the pages already open. '
        + 'When browser tools cannot connect, or a browser tool seems to be missing, call browser_status first: it names the single next action. Read '
        + 'economically: a snapshot is charged to the conversation context, so pass visual:false when only text changed, and use browser_wait, '
        + 'delta:true, region, or maxChars instead of taking the same snapshot again.'
    }), 'bridge-browser: system prompt section')
  }

  ctx.logger.info(
    tokenRes.generated
      ? `browser bridge: new token generated and persisted at ${tokenRes.file} (chmod 0600); connect the extension and paste it in its settings`
      : `browser bridge: using token from ${tokenRes.file}`,
  )
  ctx.logger.info(`browser bridge: listening on ${BRIDGE_PATH}`)
}
