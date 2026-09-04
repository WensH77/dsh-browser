/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * published Loader mounts the webserver, the minimal spine (sessions /
 * user-questions / agents / system-prompt / tools), and the bridge plugin
 * itself. A real WebSocket client authenticates over a real socket and
 * exercises the browser tool channel; disposal removes the tool
 * registrations (HMR safety). The test-only api-host shell exists solely to
 * exercise Loader injection — the 0.1.2 typertGateway/connection seams were
 * consumed only by the removed purge guard.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebSocket from 'ws'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import LlmService from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as BridgeBrowser from '../src/index.ts'
import { BRIDGE_PATH, type BridgeFrame } from '../src/protocol.ts'

const BRIDGE = '@yuxianglin/dsh-bridge-browser'
const TOKEN = 'abcdabcdabcdabcdabcdabcdabcdabcd'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  root = undefined
})

/**
 * Minimal structural implementation of the dsh 0.1.2 Host seams. Focused
 * Remote-adapter tests pin the argument and stream contracts separately; this
 * fixture verifies Loader injection, real sockets, and real Session storage.
 */
const ApiHost = {
  name: 'api-host',
  inject: ['sessions'],
  // The composition previously stubbed the 0.1.2 Host seams (typertGateway
  // wireStream/invoke + connection) for the purge guard and session listing;
  // both consumers were removed with the pure-tool refactor, so the host
  // fixture is now a no-op shell that only exercises Loader injection.
  apply(): void {},
}

/** Write a dist fixture and the composition cordis.yml, then boot it through the real Loader. */
async function loadComposition(): Promise<{ ctx: Context; configPath: string; port: number }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-bridge-browser-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-user-questions'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    "- name: 'test:api-host'",
    '  config:',
    `    cwd: '${root}'`,
    `- name: '${BRIDGE}'`,
    '  config:',
    `    token: '${TOKEN}'`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-user-questions', UserQuestionService],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRegistry],
    ['@deepseek-ai/dsh-llm', LlmService],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['test:api-host', ApiHost],
    [BRIDGE, BridgeBrowser],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  const web = context.get('webServer') as typeof WebServer.prototype
  return { ctx: context, configPath, port: web.port }
}

/** 扩展上下文 Origin（回环免 token 的必要条件）。 */
const EXT_ORIGIN = 'chrome-extension://test-extension-id'

function connect(port: number): Promise<{
  ws: WebSocket
  frames: BridgeFrame[]
  closed: Promise<{ code: number; reason: string }>
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_PATH}`, { headers: { origin: EXT_ORIGIN } })
    const frames: BridgeFrame[] = []
    ws.on('message', (data) => { frames.push(JSON.parse(data.toString()) as BridgeFrame) })
    ws.on('error', reject)
    ws.on('open', () => {
      resolve({
        ws,
        frames,
        closed: new Promise((doneResolve) => {
          ws.on('close', (code, reason) => { doneResolve({ code, reason: reason.toString() }) })
        }),
      })
    })
  })
}

function send(ws: WebSocket, frame: BridgeFrame): void {
  ws.send(JSON.stringify(frame))
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

describe('real Loader composition', () => {
  it('boots the pure tool bridge: tools registered, hello auth, internal RPCs only', { timeout: 60_000 }, async () => {
    const { ctx, port } = await loadComposition()

    // The bridge plugin mounted the browser tool set on the real registry.
    const tools = ctx.get('tools') as ToolRegistry
    expect(tools.get('browser_snapshot')).toBeDefined()

    const browserPrompt = (await ctx.systemPrompt.assemble()).sections
      .find((section) => section.name === 'tool:bridge-browser')?.text
    expect(browserPrompt).toContain('page content you have not snapshotted')
    expect(browserPrompt).toContain('Reuse that injected snapshot')
    expect(browserPrompt).not.toMatch(/\p{Script=Han}/u)

    // Zero-config discovery endpoint answers with the bridge WebSocket URL.
    const configResponse = await fetch(`http://127.0.0.1:${port}/ext/bridge-config`)
    expect(configResponse.status).toBe(200)
    const config = await configResponse.json() as { wsUrl?: unknown }
    expect(typeof config.wsUrl).toBe('string')
    expect(config.wsUrl).toBe(`ws://127.0.0.1:${port}/ext/bridge`)
    expect(tools.get('browser_click')).toBeDefined()
    expect(tools.get('browser_navigate')).toBeDefined()

    // Zero-config semantics: loopback connections need no token (the
    // non-loopback token gate is covered by server.spec overrides).
    const client = await connect(port)
    send(client.ws, { t: 'hello', token: '', caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    await Promise.race([
      waitFor(() => client.frames.some((f) => f.t === 'hello.ok')),
      client.closed.then(({ code, reason }) => {
        throw new Error(`bridge closed before hello.ok (${String(code)} ${reason}): ${JSON.stringify(client.frames)}`)
      }),
    ])
    expect(client.frames.find((f) => f.t === 'hello.ok')).toEqual({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })

    // The bridge is a pure tool channel: gateway methods are refused rather
    // than passed through to the Host adapter.
    send(client.ws, { t: 'rpc', id: 'c-1', method: 'session.list', payload: {} })
    await waitFor(() => client.frames.some((f) => f.t === 'rpc.result' && f.id === 'c-1'))
    const refused = client.frames.find((f): f is Extract<BridgeFrame, { t: 'rpc.result' }> => f.t === 'rpc.result' && f.id === 'c-1')!
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatchObject({ code: 'method-not-allowed' })

    client.ws.close()
  })

  it('unregisters the browser tools when the bridge fiber disposes (HMR safety)', { timeout: 60_000 }, async () => {
    const { ctx, configPath } = await loadComposition()
    const tools = ctx.get('tools') as ToolRegistry
    expect(tools.get('browser_snapshot')).toBeDefined()

    const bridgeEntry = [...ctx.loader.entries()].find((entry) => entry.options.name === BRIDGE)!
    await bridgeEntry.fiber!.dispose()
    expect(tools.get('browser_snapshot')).toBeUndefined()
    expect(tools.get('browser_click')).toBeUndefined()
    // Self-disposing an include-tree entry persists `disabled: true`; await
    // that debounced write so it cannot race the temp-dir removal.
    await expect.poll(async () => (await readFile(configPath, 'utf8')).includes('disabled: true')).toBe(true)
  })
})
