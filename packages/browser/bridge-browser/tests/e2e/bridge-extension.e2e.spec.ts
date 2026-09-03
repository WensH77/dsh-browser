/**
 * Browser smoke: the built MV3 extension (pure-tool build) connects on load
 * through a real WebSocket to the pure-tool bridge carrier. The options page
 * points the extension at this test host, the extension connects eagerly, and
 * the host dispatches one real `browser_snapshot` tool call to the page the
 * user opened — proving the E2E loop (host → bridge → extension → content
 * script → page → snapshot text → host) without any chat surface.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext } from 'playwright-core'
import { BridgeServer } from '../../src/server.ts'

const TOKEN = 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0'
const EXTENSION_DIR = resolve(import.meta.dirname, '../../../../../extensions/dsh-browser/dist')
const PAGE_MARKER = 'e2e-page-marker-9182'

function chromiumExecutable(): string | undefined {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_PATH
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv
  const cacheRoot = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
  if (!existsSync(cacheRoot)) return undefined
  for (const dir of ['chromium-1217', 'chromium-1226', 'chromium-1181']) {
    for (const candidate of [
      join(cacheRoot, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(cacheRoot, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      join(cacheRoot, dir, 'chrome-linux', 'chrome'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

let executable: string | undefined
let browser: BrowserContext | undefined
let profile: string | undefined
let http: Server | undefined
let bridge: BridgeServer | undefined
let port: number | undefined

beforeAll(async () => {
  executable = chromiumExecutable()
  if (executable === undefined || !existsSync(join(EXTENSION_DIR, 'manifest.json'))) return

  bridge = new BridgeServer({
    token: TOKEN,
    toolTimeoutMs: 30_000,
    caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    injectBrowserSnapshot: () => {},
    purgeSession: async () => {},
  })
  http = createServer((req, res) => {
    if (req.url === '/ext/bridge-config') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${String(port)}/ext/bridge` }))
      return
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><body><main id="${PAGE_MARKER}">Pure-tool E2E page</main></body></html>`)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  http.on('upgrade', (req, socket, head) => { bridge?.handleUpgrade(req, socket, head) })
  await new Promise<void>((resolveListen) => { http?.listen(0, '127.0.0.1', resolveListen) })
  port = (http.address() as AddressInfo).port

  profile = await mkdtemp(join(tmpdir(), 'dsh-browser-extension-e2e-'))
  browser = await chromium.launchPersistentContext(profile, {
    executablePath: executable,
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ],
  })
})

afterAll(async () => {
  await browser?.close()
  await bridge?.close()
  if (http !== undefined) {
    await new Promise<void>((resolveClose) => { http?.close(() => { resolveClose() }) })
  }
  if (profile !== undefined) await rm(profile, { recursive: true, force: true })
})

describe('pure-tool extension ↔ bridge smoke', () => {
  it('connects eagerly, binds the open page, and answers a real browser_snapshot', { timeout: 90_000 }, async () => {
    if (executable === undefined || browser === undefined || port === undefined) {
      console.warn('SKIP: no usable Chromium or extension dist')
      return
    }

    // Open the target page so the agent has a real tab to bind on first call.
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })

    // Point the extension at this host through the options page.
    let worker = browser.serviceWorkers()[0]
    worker ??= await browser.waitForEvent('serviceworker', { timeout: 30_000 })
    const extensionId = new URL(worker.url()).host
    const options = await browser.newPage()
    await options.goto(`chrome-extension://${extensionId}/options/index.html`)
    await options.waitForSelector('form', { timeout: 15_000 })
    await options.fill('input[placeholder*="ws://127.0.0.1"]', `ws://127.0.0.1:${String(port)}`)
    await options.fill('input[type="password"]', TOKEN)
    await options.click('button[type="submit"]')
    await expect.poll(async () => (await options.textContent('body'))?.includes('已保存'), { timeout: 10_000 }).toBe(true)
    await options.close()

    // The saved connection restarts the bridge; the host then dispatches one
    // real browser_snapshot against the open page and receives its text.
    await expect.poll(async () => {
      const result = await bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 20_000).catch(() => null)
      return typeof result === 'object' && result !== null && typeof (result as { text?: unknown }).text === 'string'
        ? (result as { text: string }).text
        : ''
    }, { timeout: 60_000 }).toContain(PAGE_MARKER)

    await page.close()
  })
})
