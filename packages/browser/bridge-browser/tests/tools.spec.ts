import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeServer } from '../src/server.ts'
import {
  BIND_INTERACTIVE_TIMEOUT_MS,
  BROWSER_TOOL_NAMES,
  DEBUG_TOOL_NAMES,
  GOOGLE_DRIVE_TIMEOUT_MS,
  HOST_TOOL_NAMES,
  MAX_WAIT_MS,
  TOOLSET_TOOL_NAMES,
  clampWaitMs,
  registerBrowserTools,
} from '../src/tools.ts'
import type { SyncResult } from '../src/extension-assets.ts'
import type { BridgeCaps } from '../src/protocol.ts'
import {
  BRIDGE_PROTO,
  BRIDGE_TOOLSET, LEGACY_TOOLSET, TOOLSET_PAGE_IMAGE, TOOLSET_POINTER_CLICK, TOOLSET_SELECTOR_TARGETS,
  TOOLSET_TEXT_FIND,
} from '../src/protocol.ts'

describe('clampWaitMs', () => {
  it('bounds an explicit wait so it cannot outlive the tool call', () => {
    // The page sleeps for whatever it is handed and cannot be interrupted, so
    // an unbounded value would keep a timer alive long after the host gave up.
    expect(clampWaitMs(1_500)).toBe(1_500)
    expect(clampWaitMs(MAX_WAIT_MS)).toBe(MAX_WAIT_MS)
    expect(clampWaitMs(MAX_WAIT_MS + 1)).toBe(MAX_WAIT_MS)
    expect(clampWaitMs(31_536_000_000)).toBe(MAX_WAIT_MS)
  })

  it('treats a missing or unusable delay as no extra wait', () => {
    expect(clampWaitMs(undefined)).toBe(0)
    expect(clampWaitMs(null)).toBe(0)
    expect(clampWaitMs('5000')).toBe(0)
    expect(clampWaitMs(-1)).toBe(0)
    expect(clampWaitMs(0)).toBe(0)
    expect(clampWaitMs(Number.NaN)).toBe(0)
    expect(clampWaitMs(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('floors a fractional delay rather than passing it on', () => {
    expect(clampWaitMs(1_234.9)).toBe(1_234)
  })
})

describe('registerBrowserTools', () => {
  function makeHarness(services: Record<string, unknown> = {}, debuggerAllowed = false) {
    const registered: { name: string; definition: Record<string, unknown> }[] = []
    const ctx = {
      tools: {
        register: vi.fn((definition: { name: string }) => {
          const entry = { name: definition.name, definition: definition as Record<string, unknown> }
          registered.push(entry)
          return () => {
            const at = registered.indexOf(entry)
            if (at !== -1) registered.splice(at, 1)
          }
        }),
      },
      get: (name: string) => services[name],
    } as unknown as Context
    const requestTool = vi.fn(async (_name: string, _args: Record<string, unknown>, _signal: AbortSignal, _timeoutMs?: number): Promise<unknown> => {
      return { text: 'ok' }
    })
    const bridge = { requestTool, clientDebugger: () => debuggerAllowed } as unknown as BridgeServer
    return { ctx, bridge, requestTool, registered }
  }

  /** Image-capable route plus a durable-store stub, the two services a visual tool needs. */
  function visualServices(): Record<string, unknown> {
    return {
      llm: {
        resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text', 'image'] })),
      },
      attachments: {
        imageLimits: {
          maxImageBytes: 4_000_000,
          maxMessageImageBytes: 4_000_000,
          maxImagePixels: 4_000_000,
          maxImageDimension: 4_096,
          mediaTypes: ['image/png', 'image/jpeg'],
        },
        normalizationPolicy: { maxPixels: 4_194_304, maxBytes: 4_194_304, maxDimension: 8_192 },
        saveImage: vi.fn(async () => ({
          attachmentId: 'att-1',
          mediaType: 'image/png',
          bytes: 12,
          width: 800,
          height: 600,
          name: 'page-capture.png',
        })),
      },
    }
  }

  /** One route-bearing execution context for image-gate coverage. */
  const routedExec = (): { signal: AbortSignal; agent: unknown } => ({
    signal: new AbortController().signal,
    agent: {
      id: 'session-visual',
      session: { requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }) },
      options: { provider: 'test-provider', model: 'test-model' },
    },
  })

  /** Debugging tools are opt-in per connection; most tests want the whole surface. */
  function enableDebug<T extends { setDebugToolsEnabled(enabled: boolean): void }>(tools: T): T {
    tools.setDebugToolsEnabled(true)
    return tools
  }

  const CAPTURED = {
    dataBase64: Buffer.from('fake-png-bytes').toString('base64'),
    mediaType: 'image/png',
    width: 800,
    height: 600,
    bytes: 12,
  }

  it('registers the always-on tool set and exposes debugging tools only on request', () => {
    const { ctx, bridge, registered } = makeHarness()
    const tools = registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })

    const alwaysOn = [...BROWSER_TOOL_NAMES].filter((name) => !DEBUG_TOOL_NAMES.includes(name))
    expect(tools.names().sort()).toEqual([...alwaysOn, ...HOST_TOOL_NAMES, 'browser_bind_interactive', 'google_drive_export'].sort())
    for (const name of DEBUG_TOOL_NAMES) expect(registered.some((r) => r.name === name)).toBe(false)

    tools.setDebugToolsEnabled(true)
    expect(tools.names().sort()).toEqual([...BROWSER_TOOL_NAMES, ...HOST_TOOL_NAMES, 'browser_bind_interactive', 'google_drive_export'].sort())

    tools.setDebugToolsEnabled(false)
    for (const name of DEBUG_TOOL_NAMES) expect(registered.some((r) => r.name === name)).toBe(false)

    tools.dispose()
    expect(registered).toHaveLength(0)
  })

  it('narrows the surface to what a legacy extension implements', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    const tools = registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })

    // Before a hello the full surface is registered: nothing is connected, so
    // no call can run anyway.
    for (const name of TOOLSET_TOOL_NAMES) expect(tools.names()).toContain(name)
    const params = (definition: Record<string, unknown>): Record<string, unknown> =>
      (definition.parameters as { properties: Record<string, unknown> }).properties
    const fullClick = registered.find((r) => r.name === 'browser_click')!.definition
    expect(Object.keys(params(fullClick))).toContain('selector')

    tools.setClientToolset(LEGACY_TOOLSET)
    for (const name of TOOLSET_TOOL_NAMES) {
      expect(tools.names()).not.toContain(name)
      expect(registered.some((r) => r.name === name)).toBe(false)
    }
    const legacyClick = registered.find((r) => r.name === 'browser_click')!.definition
    expect(Object.keys(params(legacyClick))).not.toContain('selector')
    expect(String(legacyClick.description)).toContain('pass index from browser_snapshot')
    const legacyType = registered.find((r) => r.name === 'browser_type')!.definition
    expect(Object.keys(params(legacyType))).not.toContain('selector')

    // A selector the model read from the newer schema is refused locally with
    // the same instruction instead of being sent to a build that cannot parse it.
    const exec = { signal: new AbortController().signal }
    const refused = await (legacyClick.execute as (args: unknown, e: typeof exec) => Promise<unknown>)({ selector: '#save' }, exec)
    expect(requestTool).not.toHaveBeenCalled()
    expect(String((refused as { text: string }).text)).toContain('predates selector targets')

    // Back to a declared toolset: the full surface and schema return.
    tools.setClientToolset(BRIDGE_TOOLSET)
    for (const name of TOOLSET_TOOL_NAMES) expect(tools.names()).toContain(name)
    const restored = registered.find((r) => r.name === 'browser_click')!.definition
    expect(Object.keys(params(restored))).toContain('selector')
    expect(String(restored.description)).not.toContain('pass index from browser_snapshot')
    await (restored.execute as (args: unknown, e: typeof exec) => Promise<unknown>)({ selector: '#save' }, exec)
    expect(requestTool).toHaveBeenCalledWith('browser_click', { selector: '#save' }, exec.signal, 1_000)
  })

  it('gates the page-text search on the level that implements it', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    const tools = registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const params = (definition: Record<string, unknown>): Record<string, unknown> =>
      (definition.parameters as { properties: Record<string, unknown> }).properties
    const exec = { signal: new AbortController().signal }

    // Current level: find/context are declared and forwarded.
    expect(Object.keys(params(registered.find((r) => r.name === 'browser_get_text')!.definition))).toContain('find')
    await (registered.find((r) => r.name === 'browser_get_text')!.definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)(
      { find: '10 of 142', context: 400 },
      exec,
    )
    expect(requestTool).toHaveBeenCalledWith('browser_get_text', { find: '10 of 142', context: 400 }, exec.signal, 1_000)

    // Level 1 resolves selectors but cannot search text: the schema drops the
    // parameter, and a find from a stale schema is refused with a next step.
    tools.setClientToolset(TOOLSET_SELECTOR_TARGETS)
    const level1 = registered.find((r) => r.name === 'browser_get_text')!.definition
    expect(Object.keys(params(level1))).not.toContain('find')
    expect(tools.names()).toContain('browser_dom_query')
    expect(Object.keys(params(registered.find((r) => r.name === 'browser_click')!.definition))).toContain('selector')
    requestTool.mockClear()
    const refused = await (level1.execute as (a: unknown, e: typeof exec) => Promise<unknown>)({ find: 'x' }, exec)
    expect(requestTool).not.toHaveBeenCalled()
    expect(String((refused as { text: string }).text)).toContain('cannot search page text')
    // A plain read still works at that level.
    await (level1.execute as (a: unknown, e: typeof exec) => Promise<unknown>)({}, exec)
    expect(requestTool).toHaveBeenCalledWith('browser_get_text', {}, exec.signal, 1_000)

    // Level 2 (find, no page picture): the new tool is absent.
    tools.setClientToolset(TOOLSET_TEXT_FIND)
    expect(tools.names()).not.toContain('browser_image')
    expect(tools.names()).toContain('browser_dom_query')

    // Level 3: the page-picture tool appears with its own schema, and the
    // pointer click stays hidden — its action is a wire case this level lacks.
    tools.setClientToolset(TOOLSET_PAGE_IMAGE)
    expect(tools.names()).toContain('browser_image')
    expect(tools.names()).not.toContain('browser_click_pointer')
    const imageTool = registered.find((r) => r.name === 'browser_image')!.definition
    expect(Object.keys(params(imageTool))).toEqual(expect.arrayContaining(['selector', 'index', 'frame']))

    // Level 4 adds the pointer click, with the same targets as browser_click,
    // but not the Slides page jump: that wire case arrives a level later.
    tools.setClientToolset(TOOLSET_POINTER_CLICK)
    expect(tools.names()).toContain('browser_click_pointer')
    expect(tools.names()).not.toContain('browser_slides_open_page')
    const pointerTool = registered.find((r) => r.name === 'browser_click_pointer')!.definition
    expect(Object.keys(params(pointerTool))).toEqual(expect.arrayContaining(['index', 'selector']))

    // Level 5 adds the Slides page jump, which takes a page number and nothing
    // else — the tool resolves the slide itself.
    tools.setClientToolset(BRIDGE_TOOLSET)
    expect(tools.names()).toContain('browser_slides_open_page')
    const slidesTool = registered.find((r) => r.name === 'browser_slides_open_page')!.definition
    expect(Object.keys(params(slidesTool))).toEqual(['page'])

    // Level 0 has neither selector targets nor text search.
    tools.setClientToolset(LEGACY_TOOLSET)
    expect(Object.keys(params(registered.find((r) => r.name === 'browser_get_text')!.definition))).not.toContain('find')
    expect(tools.names()).not.toContain('browser_dom_query')
    expect(Object.keys(params(registered.find((r) => r.name === 'browser_click')!.definition))).not.toContain('selector')
  })

  it('tells the capture the size the model will actually receive', async () => {
    // The extension needs the delivery budget to tell a legible full page from a
    // thumbnail of everything; it is optional, and a service without it changes
    // nothing about the call.
    const services = visualServices()
    const { ctx, bridge, requestTool, registered } = makeHarness(services, true)
    enableDebug(registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 }))
    const tool = registered.find((r) => r.name === 'browser_capture')!
    const exec = routedExec()
    const argsOfLatestCaptureCall = (): Record<string, unknown> => {
      const calls = requestTool.mock.calls.filter((call) => call[0] === 'browser_capture')
      return calls[calls.length - 1]?.[1] as Record<string, unknown>
    }

    requestTool.mockResolvedValueOnce({ text: 'capture envelope', image: CAPTURED })
    await (tool.definition.execute as (a: unknown, e: unknown) => Promise<unknown>)({}, exec)
    expect(argsOfLatestCaptureCall().deliver).toEqual({ maxBytes: 4_194_304, maxPixels: 4_194_304, maxDimension: 8_192 })

    delete (services.attachments as { normalizationPolicy?: unknown }).normalizationPolicy
    requestTool.mockResolvedValueOnce({ text: 'capture envelope', image: CAPTURED })
    await (tool.definition.execute as (a: unknown, e: unknown) => Promise<unknown>)({}, exec)
    expect(argsOfLatestCaptureCall()).not.toHaveProperty('deliver')
  })

  it('executes browser_click with mapped args', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    enableDebug(registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 }))
    const tool = registered.find((r) => r.name === 'browser_click')!
    const exec = { signal: new AbortController().signal }
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ index: 3, frame: 7 }, exec)
    expect(requestTool).toHaveBeenCalledWith('browser_click', { index: 3, frame: 7 }, exec.signal, 1_000)
    expect(result).toEqual({ text: 'ok' })
  })

  it('associates browser calls with the owning Agent session', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_click')!
    const exec = {
      signal: new AbortController().signal,
      agent: { id: 'session-browser' },
    }

    await (tool.definition.execute as (args: unknown, e: typeof exec) => Promise<unknown>)({ index: 3 }, exec)

    expect(requestTool).toHaveBeenCalledWith(
      'browser_click',
      { index: 3 },
      exec.signal,
      1_000,
      'session-browser',
    )
  })

  it('normalizes snapshot args (delta/region omitted when absent)', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_snapshot')!
    const exec = { signal: new AbortController().signal }
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ delta: true }, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', { delta: true, visual: false }, exec.signal, 1_000)
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', { visual: false }, exec.signal, 1_000)
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ delta: true, region: 'main' }, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', { delta: true, region: 'main', visual: false }, exec.signal, 1_000)
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ visual: false }, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', { visual: false }, exec.signal, 1_000)
  })

  it('asks for a same-moment screenshot and attaches it when the route accepts images', async () => {
    const services = visualServices()
    const { ctx, bridge, requestTool, registered } = makeHarness(services, true)
    requestTool.mockResolvedValueOnce({ text: 'snapshot text', image: CAPTURED })
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_snapshot')!
    const exec = routedExec()
    const value = await (tool.definition.execute as (a: unknown, e: unknown) => Promise<{ text: string; image?: { attachmentId: string } }>)({}, exec)

    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', {
      visual: true,
      limits: { maxBytes: 4_000_000, maxPixels: 4_000_000, maxDimension: 4_096 },
      deliver: { maxBytes: 4_194_304, maxPixels: 4_194_304, maxDimension: 8_192 },
    }, exec.signal, 1_000, 'session-visual')
    expect(value.text).toBe('snapshot text')
    expect(value.image).toMatchObject({ attachmentId: 'att-1', mediaType: 'image/png', bytes: 12, width: 800, height: 600 })
    const saved = (services.attachments as { saveImage: { mock: { calls: unknown[][] } } }).saveImage.mock.calls[0]![0] as { mediaType: string; data: Uint8Array }
    expect(saved.mediaType).toBe('image/png')
    expect(Buffer.from(saved.data).toString()).toBe('fake-png-bytes')

    const output = tool.definition.output as { render: (args: unknown, value: unknown) => unknown[] }
    const blocks = output.render({}, value)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ type: 'text' })
    expect(blocks[1]).toMatchObject({ type: 'image', attachment: { attachmentId: 'att-1' } })
  })

  it('degrades to text-only when the model does not declare image input', async () => {
    const services = visualServices()
    ;(services.llm as { resolveModelInfo: () => Promise<{ inputModalities: string[] }> }).resolveModelInfo = vi.fn(async () => ({ inputModalities: ['text'] }))
    const { ctx, bridge, requestTool, registered } = makeHarness(services, true)
    requestTool.mockResolvedValueOnce({ text: 'snapshot text' })
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_snapshot')!
    const value = await (tool.definition.execute as (a: unknown, e: unknown) => Promise<{ text: string; image?: unknown }>)({}, routedExec())

    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', { visual: false }, expect.anything(), 1_000, 'session-visual')
    expect(value.image).toBeUndefined()
    expect(value.text).toContain('screenshot unavailable')
  })

  it('reads a page picture without the debugging capability', async () => {
    // The picture travels over the page's own session, so an extension with
    // debugging switched off (clientDebugger false) must still serve it.
    const { ctx, bridge, registered } = makeHarness(visualServices(), false)
    const tools = registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const requestTool = (bridge as unknown as { requestTool: ReturnType<typeof vi.fn> }).requestTool
    requestTool.mockResolvedValue({ text: '<image>kind: img</image>', image: CAPTURED })
    const tool = registered.find((r) => r.name === 'browser_image')!

    const result = await (tool.definition.execute as (a: unknown, e: unknown) => Promise<unknown>)(
      { selector: 'img' },
      routedExec(),
    )

    expect(requestTool).toHaveBeenCalledWith('browser_image', expect.objectContaining({ selector: 'img' }), expect.anything(), 1_000, 'session-visual')
    expect(result).toMatchObject({ image: expect.objectContaining({ attachmentId: 'att-1' }) })
    expect(tools.names()).toContain('browser_image')
    tools.dispose()
  })

  it('refuses browser_capture without an image-capable route and never dispatches', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness(visualServices(), true)
    enableDebug(registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 }))
    const tool = registered.find((r) => r.name === 'browser_capture')!
    const value = await (tool.definition.execute as (a: unknown, e: unknown) => Promise<{ text: string }>)({}, { signal: new AbortController().signal })

    expect(value.text).toContain('does not declare image input')
    expect(requestTool).not.toHaveBeenCalled()
  })

  it('maps browser_capture args and attaches the captured image', async () => {
    const services = visualServices()
    const { ctx, bridge, requestTool, registered } = makeHarness(services, true)
    requestTool.mockResolvedValueOnce({ text: 'capture envelope', image: CAPTURED })
    enableDebug(registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 }))
    const tool = registered.find((r) => r.name === 'browser_capture')!
    const exec = routedExec()
    const value = await (tool.definition.execute as (a: unknown, e: unknown) => Promise<{ text: string; image?: unknown }>)({ fullPage: true, format: 'jpeg', quality: 70 }, exec)

    expect(requestTool).toHaveBeenLastCalledWith('browser_capture', {
      fullPage: true,
      format: 'jpeg',
      quality: 70,
      limits: { maxBytes: 4_000_000, maxPixels: 4_000_000, maxDimension: 4_096 },
      deliver: { maxBytes: 4_194_304, maxPixels: 4_194_304, maxDimension: 8_192 },
    }, exec.signal, 1_000, 'session-visual')
    expect(value.image).toBeDefined()
  })

  it('says when normalization shrank the image the model received', async () => {
    // A full-page capture reports the raster it produced; the store hands the
    // model a smaller one. Reporting only the first put "6076x6850" beside a
    // 1928x2174 picture, which is how a legibility call gets made on wrong data.
    const services = visualServices()
    ;(services.attachments as { saveImage: { mockResolvedValue: (value: unknown) => void } }).saveImage
      .mockResolvedValue({ attachmentId: 'att-1', mediaType: 'image/jpeg', bytes: 900, width: 1928, height: 2174 })
    const { ctx, bridge, requestTool, registered } = makeHarness(services, true)
    enableDebug(registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 }))
    requestTool.mockResolvedValueOnce({
      text: '<capture>\nimage: image/jpeg 6076x6850 px, 778135 bytes\n</capture>',
      image: { dataBase64: Buffer.from('jpeg-bytes').toString('base64'), mediaType: 'image/jpeg', width: 6076, height: 6850, bytes: 778_135 },
    })
    const tool = registered.find((r) => r.name === 'browser_capture')!

    const value = await (tool.definition.execute as (a: unknown, e: unknown) => Promise<{ text: string }>)({ fullPage: true }, routedExec())

    expect(value.text).toContain('6076x6850')
    expect(value.text).toContain('normalized to 1928x2174 px')
  })

  it('routes only Docs and Sheets links to the export bridge', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'google_drive_export')!.definition
    const run = async (url: string): Promise<string> => {
      const value = await (tool.execute as (a: unknown, e: unknown) => Promise<{ text: string }>)({ url }, { signal: new AbortController().signal, agent: { id: 's' } })
      return value.text
    }

    for (const url of [
      'https://docs.google.com/presentation/d/DECK/edit',
      'https://drive.google.com/file/d/FILE/view',
      'https://example.com/document/d/x',
      'not a url',
    ]) {
      const text = await run(url)
      // One wording for one fact: this text and the extension's own hint are
      // the same constant, so assert the content the model actually needs.
      expect(text).toContain('only handles Google Docs')
      expect(text).toContain('browser_navigate')
    }
    expect(requestTool).not.toHaveBeenCalled()
  })

  it('executes every remaining tool with mapped args', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const byName = new Map(registered.map((r) => [r.name, r.definition]))
    const exec = { signal: new AbortController().signal }
    const run = async (name: string, args: unknown): Promise<void> => {
      await (byName.get(name)!.execute as (a: unknown, e: { signal: AbortSignal }) => Promise<unknown>)(args, exec)
    }

    await run('browser_type', { index: 2, text: 'hello' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_type', { index: 2, text: 'hello' }, exec.signal, 1_000)
    await run('browser_type', { index: 2, text: 'hello', replace: true })
    expect(requestTool).toHaveBeenLastCalledWith('browser_type', { index: 2, text: 'hello', replace: true }, exec.signal, 1_000)
    await run('browser_type', { index: 2, frame: 4, text: 'inside frame' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_type', { index: 2, frame: 4, text: 'inside frame' }, exec.signal, 1_000)

    await run('browser_press', { key: 'Enter' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_press', { key: 'Enter' }, exec.signal, 1_000)

    await run('browser_scroll', { direction: 'down', amount: 200 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { direction: 'down', amount: 200 }, exec.signal, 1_000)
    await run('browser_scroll', { direction: 'top' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { direction: 'top' }, exec.signal, 1_000)
    await run('browser_scroll', { direction: 'down', frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { direction: 'down', frame: 4 }, exec.signal, 1_000)

    await run('browser_navigate', { url: 'https://example.com' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_navigate', { url: 'https://example.com' }, exec.signal, 1_000)

    for (const name of ['browser_back', 'browser_forward', 'browser_reload'] as const) {
      await run(name, {})
      expect(requestTool).toHaveBeenLastCalledWith(name, {}, exec.signal, 1_000)
    }

    await run('browser_dom_query', { selector: 'i.icon-mail', fields: ['href', 'value'], limit: 5, frame: 2 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_dom_query', {
      selector: 'i.icon-mail',
      fields: ['href', 'value'],
      limit: 5,
      frame: 2,
    }, exec.signal, 1_000)
    await run('browser_dom_query', { selector: '#main' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_dom_query', { selector: '#main' }, exec.signal, 1_000)

    await run('browser_get_text', { selector: '#main' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', { selector: '#main' }, exec.signal, 1_000)
    await run('browser_get_text', { selector: '#form', maxChars: 3_000 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', { selector: '#form', maxChars: 3_000 }, exec.signal, 1_000)
    await run('browser_get_text', {})
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', {}, exec.signal, 1_000)
    await run('browser_get_text', { selector: 'main', frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', { selector: 'main', frame: 4 }, exec.signal, 1_000)

    await run('browser_wait', { ms: 100 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', { ms: 100 }, exec.signal, 1_000)
    await run('browser_wait', {})
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', {}, exec.signal, 1_000)
    await run('browser_wait', { frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', { frame: 4 }, exec.signal, 1_000)
  })

  it('normalizes every DSH parameter map to JSON Schema before registration', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    for (const { definition } of registered) {
      const params = definition.parameters as { type?: unknown; properties?: unknown }
      expect(params.type).toBe('object')
      expect(params.properties).toBeDefined()
    }
    const click = registered.find(({ name }) => name === 'browser_click')!.definition.parameters as {
      properties: Record<string, unknown>
      required?: string[]
    }
    // `index` stays available but is no longer required: a CSS selector can
    // address the same element, which is how icon-only controls get clicked.
    expect(click.properties.index).toBeDefined()
    expect(click.properties.selector).toBeDefined()
    const typing = registered.find(({ name }) => name === 'browser_type')!.definition.parameters as {
      properties: Record<string, unknown>
      required?: string[]
    }
    expect(typing.properties.selector).toBeDefined()
    expect(typing.required).toContain('text')
    expect(typing.required ?? []).not.toContain('index')
  })

  it('declares cooperative timeoutMs on every tool', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    for (const { name, definition } of registered) {
      expect(definition.timeoutMs).toBe(name === 'browser_bind_interactive' ? BIND_INTERACTIVE_TIMEOUT_MS : name === 'google_drive_export' ? GOOGLE_DRIVE_TIMEOUT_MS : 5_000)
    }
  })

  it('keeps model-facing tool schemas in English', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const han = /\p{Script=Han}/u
    for (const { definition } of registered) {
      expect(String(definition.description)).not.toMatch(han)
      expect(JSON.stringify(definition.parameters)).not.toMatch(han)
    }
  })

  it('keeps model-facing tool descriptions concise', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const descriptionChars = registered.reduce((sum, { definition }) => sum + String(definition.description).length, 0)
    // The surface grew from 13 to 19 tools, so the budget is per tool: no
    // single description may bloat the always-sent schema payload.
    expect(descriptionChars / registered.length).toBeLessThan(200)
  })

  it('exposes optional frame routing on frame-local tools only', () => {
    const { ctx, bridge, registered } = makeHarness()
    enableDebug(registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 }))
    const byName = new Map(registered.map((entry) => [entry.name, entry.definition]))
    for (const name of ['browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_get_text', 'browser_dom_query', 'browser_wait']) {
      const params = byName.get(name)!.parameters as { properties: { frame?: { type?: unknown } } }
      expect(params.properties.frame?.type).toBe('number')
    }
    for (const name of ['browser_snapshot', 'browser_capture', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload']) {
      const params = byName.get(name)!.parameters as { properties: { frame?: unknown } }
      expect(params.properties.frame).toBeUndefined()
    }
  })

  it('falls back to a no-text payload when the extension returns non-text', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    requestTool.mockResolvedValueOnce(null)
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_wait')!
    const exec = { signal: new AbortController().signal }
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, exec)
    expect(result).toEqual({ text: expect.stringContaining('no text') })
  })

  it('renders the canonical result as one text block', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_click')!
    const output = tool.definition.output as { render: (args: unknown, value: unknown) => unknown }
    expect(output.render({}, { text: 'hello' })).toEqual([{ type: 'text', text: 'hello' }])
  })

  describe('browser_status / browser_setup', () => {
    const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'
    const BUDGETS = { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 }
    const CURRENT: SyncResult = { status: 'up-to-date', target: '/tmp/mirror', source: '/tmp/dist', files: 12 }
    const REFRESHED: SyncResult = { status: 'synced', target: '/tmp/mirror', source: '/tmp/dist', files: 12 }
    const UNAVAILABLE: SyncResult = { status: 'unavailable', target: '/tmp/mirror', files: 0, reason: 'no bundled extension with a manifest.json' }
    const FAILED: SyncResult = { status: 'failed', target: '/tmp/mirror', files: 0, reason: 'EACCES: permission denied' }
    const CAPS: BridgeCaps = {
      proto: BRIDGE_PROTO,
      toolset: BRIDGE_TOOLSET,
      extensionId: EXT_ID,
      extensionVersion: '0.1.7',
      snapshotMaxChars: 32_000,
      maxInteractiveItems: 60,
    }

    /**
     * Both host tools read live server accessors and three injected seams; this
     * harness gives every one of them a value the test can name, so no test
     * touches the real mirror directory or launches a browser.
     */
    function makeHostHarness(options: {
      connected?: boolean
      version?: string | undefined
      caps?: BridgeCaps | undefined
      sync?: SyncResult
      syncThrows?: boolean
      opened?: boolean
      copied?: boolean
      debuggerAllowed?: boolean
    } = {}) {
      const { ctx, registered } = makeHarness({}, options.debuggerAllowed ?? false)
      const syncExtension = vi.fn(async (): Promise<SyncResult> => {
        if (options.syncThrows === true) throw new Error('mirror exploded')
        return options.sync ?? CURRENT
      })
      const openExtensionsPage = vi.fn(async () => options.opened ?? true)
      const copyToClipboard = vi.fn(async () => options.copied ?? true)
      const bridge = {
        requestTool: vi.fn(async () => ({ text: 'ok' })),
        clientDebugger: () => options.debuggerAllowed ?? false,
        hasConnection: () => options.connected ?? false,
        clientExtensionVersion: () => options.version,
      } as unknown as BridgeServer
      const tools = registerBrowserTools(ctx, bridge, {
        ...BUDGETS,
        host: {
          clientCaps: () => options.caps,
          syncExtension,
          openExtensionsPage,
          copyToClipboard,
        },
      })
      return { ctx, registered, tools, syncExtension, openExtensionsPage, copyToClipboard }
    }

    /** Run one host tool and return its text. */
    async function runText(registered: { name: string; definition: Record<string, unknown> }[], name: string): Promise<string> {
      const tool = registered.find((entry) => entry.name === name)
      if (tool === undefined) throw new Error(`${name} is not registered`)
      const value = await (tool.definition.execute as (a: unknown, e: unknown) => Promise<{ text: string }>)(
        {},
        { signal: new AbortController().signal },
      )
      return value.text
    }

    const lastLine = (text: string): string => text.split('\n').at(-1)!

    /** The one mirror line, so a test can pin it character for character. */
    const mirrorLineOf = (text: string): string =>
      text.split('\n').find((line) => line.startsWith('extension files:'))!

    it('reports the plugin side and the mirror with nothing connected', async () => {
      const h = makeHostHarness()
      const text = await runText(h.registered, 'browser_status')

      expect(text).toContain(`plugin: proto ${BRIDGE_PROTO}, toolset ${BRIDGE_TOOLSET}`)
      expect(text).toContain('extension: not connected')
      expect(text).toContain('extension files: up-to-date at /tmp/mirror')
      // No id/version line without a connection: there is nothing to report.
      expect(text).not.toContain('extension version:')
      expect(lastLine(text)).toBe('next: run browser_setup to open chrome://extensions and load the extension')
      // "One next action" is a property of the text, not of the writer.
      expect(text.match(/^next: /gm)).toHaveLength(1)
    })

    it('reports the connected extension id, version and both declared levels', async () => {
      const h = makeHostHarness({ connected: true, version: '0.1.7', caps: CAPS })
      const text = await runText(h.registered, 'browser_status')

      expect(text).toContain('extension: connected')
      expect(text).toContain(`extension id: ${EXT_ID}`)
      expect(text).toContain('extension version: 0.1.7')
      expect(text).toContain(`extension declares: proto ${BRIDGE_PROTO}, toolset ${BRIDGE_TOOLSET}`)
      expect(text).toContain('version skew: consistent')
      expect(lastLine(text)).toBe('next: none — the bridge is ready')
      expect(text.match(/^next: /gm)).toHaveLength(1)
    })

    it('calls a connected build that reports no version "unknown (older build)"', async () => {
      // `clientExtensionVersion()` answers undefined both for "nothing is
      // connected" and for a build that predates the field; hasConnection() is
      // what tells the two apart, and the wording must not claim a mismatch.
      const h = makeHostHarness({ connected: true, version: undefined, caps: { ...CAPS, extensionVersion: undefined } })
      const text = await runText(h.registered, 'browser_status')

      expect(text).toContain('extension: connected')
      expect(text).toContain('extension version: unknown (older build)')
      expect(text).toContain('version skew: consistent')
      expect(text).not.toContain('extension version: undefined')
    })

    it('names a reload for an older extension and a dsh restart for a newer one', async () => {
      const older = makeHostHarness({
        connected: true,
        version: '0.1.0',
        caps: { ...CAPS, toolset: TOOLSET_SELECTOR_TARGETS },
      })
      const olderText = await runText(older.registered, 'browser_status')
      expect(olderText).toContain('version skew: reload the extension')
      expect(olderText).toContain(`it declares proto ${BRIDGE_PROTO} / toolset ${TOOLSET_SELECTOR_TARGETS}`)
      expect(lastLine(olderText)).toBe('next: reload the extension from chrome://extensions')

      // The other direction is fatal (the host refuses the handshake), so it
      // must never be reported with the reload wording.
      const newer = makeHostHarness({
        connected: true,
        version: '0.2.0',
        caps: { ...CAPS, proto: BRIDGE_PROTO + 1 },
      })
      const newerText = await runText(newer.registered, 'browser_status')
      expect(newerText).toContain(`version skew: restart dsh — the extension speaks proto ${BRIDGE_PROTO + 1}`)
      expect(newerText).not.toContain('reload the extension —')
      expect(lastLine(newerText)).toBe('next: restart dsh so it loads the newer plugin build')
    })

    it('asks for a reload when the mirror was just refreshed under a running extension', async () => {
      const h = makeHostHarness({ connected: true, version: '0.1.7', caps: CAPS, sync: REFRESHED })
      const text = await runText(h.registered, 'browser_status')

      expect(text).toContain('extension files: refreshed just now (12 files) at /tmp/mirror')
      expect(lastLine(text)).toBe('next: reload the extension from chrome://extensions so the refreshed files load')
    })

    it('never throws and states the reason for every mirror outcome', async () => {
      for (const sync of [CURRENT, REFRESHED, UNAVAILABLE, FAILED]) {
        for (const connected of [false, true]) {
          const h = makeHostHarness({ connected, version: '0.1.7', caps: CAPS, sync })
          const text = await runText(h.registered, 'browser_status')
          expect(text).toContain('browser bridge status')
          expect(text.match(/^next: /gm)).toHaveLength(1)
        }
      }
      const unavailable = await runText(makeHostHarness({ sync: UNAVAILABLE }).registered, 'browser_status')
      expect(unavailable).toContain('extension files: not bundled with this plugin — no bundled extension with a manifest.json')
      expect(lastLine(unavailable)).toBe('next: install the extension from a checkout — this plugin ships no extension build')

      const failed = await runText(makeHostHarness({ sync: FAILED }).registered, 'browser_status')
      expect(failed).toContain('extension files: refresh failed — EACCES: permission denied')
      expect(lastLine(failed)).toBe('next: run browser_setup to retry refreshing the extension files')

      // Same mirror failure while connected: the failure line may not sit above
      // `next: none` — a retry exists and is the action to name.
      const failedOnline = await runText(
        makeHostHarness({ connected: true, version: '0.1.7', caps: CAPS, sync: FAILED }).registered,
        'browser_status',
      )
      expect(failedOnline).toContain('extension: connected')
      expect(failedOnline).toContain('version skew: consistent')
      expect(lastLine(failedOnline)).toBe('next: run browser_setup to retry refreshing the extension files')

      // The bigger action still wins: restarting dsh re-syncs the mirror too, so
      // a failed pass must not push the restart out of the next line.
      const failedNewer = await runText(
        makeHostHarness({
          connected: true,
          version: '0.2.0',
          caps: { ...CAPS, proto: BRIDGE_PROTO + 1 },
          sync: FAILED,
        }).registered,
        'browser_status',
      )
      expect(lastLine(failedNewer)).toBe('next: restart dsh so it loads the newer plugin build')

      // A throwing seam is the worst case this tool exists for: it must still
      // answer, with the fault as the reason.
      const thrown = await runText(makeHostHarness({ syncThrows: true }).registered, 'browser_status')
      expect(thrown).toContain('refresh failed — mirror exploded')
      expect(thrown).toContain('browser bridge status')
    })

    it('refreshes files, opens the extensions page and copies the load path', async () => {
      const h = makeHostHarness({ sync: REFRESHED, opened: true, copied: true })
      const text = await runText(h.registered, 'browser_setup')

      expect(text).toContain('extension files: refreshed just now (12 files) at /tmp/mirror')
      expect(text).toContain('chrome://extensions: opened in the browser')
      expect(text).toContain('clipboard: the load path is on the clipboard (/tmp/mirror)')
      expect(lastLine(text)).toBe('next: reload the extension on chrome://extensions so the refreshed files load')
      expect(h.syncExtension).toHaveBeenCalledTimes(1)
      expect(h.openExtensionsPage).toHaveBeenCalledTimes(1)
      expect(h.copyToClipboard).toHaveBeenCalledWith('/tmp/mirror')
    })

    it('is idempotent: a second run writes nothing and only describes the manual step', async () => {
      const refreshed = makeHostHarness({ sync: REFRESHED })
      await runText(refreshed.registered, 'browser_setup')
      const current = makeHostHarness({ sync: CURRENT })
      const second = await runText(current.registered, 'browser_setup')

      expect(second).toContain('extension files: up-to-date at /tmp/mirror')
      expect(second).not.toContain('refreshed')
      expect(lastLine(second)).toBe('next: on chrome://extensions, load or reload the extension — the files are current')
    })

    it('skips the clipboard silently and survives an opener that fails', async () => {
      const h = makeHostHarness({ sync: CURRENT, opened: false, copied: false })
      const text = await runText(h.registered, 'browser_setup')

      expect(text).not.toContain('clipboard:')
      expect(text).toContain('chrome://extensions: could not be opened automatically — open it in the browser')
      expect(text).toContain('/tmp/mirror')
    })

    it('reports, rather than throws, when the mirror cannot run at all', async () => {
      const failed = await runText(makeHostHarness({ syncThrows: true }).registered, 'browser_setup')
      expect(failed).toContain('extension files: refresh failed — mirror exploded')
      expect(lastLine(failed)).toBe('next: fix the reported cause, then call browser_setup again')

      const missing = await runText(makeHostHarness({ sync: UNAVAILABLE }).registered, 'browser_setup')
      expect(lastLine(missing)).toBe('next: install from a checkout that has the extension build, then call browser_setup again')
    })

    it('omits the path instead of printing empty parentheses when no directory is known', async () => {
      // An empty target is a legal pass result (the resolver faulted, so no
      // directory was ever named); "(target )" and "clipboard … ()" would read
      // as truncated text, and there is no path to copy either.
      const NOWHERE: SyncResult = { status: 'failed', target: '', files: 0, reason: 'resolver exploded' }
      const h = makeHostHarness({ sync: NOWHERE, opened: true, copied: true })

      const statusText = await runText(h.registered, 'browser_status')
      expect(statusText).toContain('extension files: refresh failed — resolver exploded')
      expect(statusText).not.toContain('()')
      expect(statusText).not.toMatch(/\(target\s*\)/)
      expect(lastLine(statusText)).toBe('next: run browser_setup to retry refreshing the extension files')

      const setupText = await runText(h.registered, 'browser_setup')
      expect(setupText).toContain('extension files: refresh failed — resolver exploded')
      expect(setupText).not.toContain('()')
      expect(setupText).not.toContain('clipboard:')
      expect(h.copyToClipboard).not.toHaveBeenCalled()

      // The same rule for a non-failed pass that names no directory.
      const unknownDir = makeHostHarness({ sync: { status: 'up-to-date', target: '', files: 0 } })
      const currentText = await runText(unknownDir.registered, 'browser_status')
      expect(currentText).toContain('extension files: up-to-date\n')
      expect(currentText).not.toContain('up-to-date at')
    })

    it('shows the reason of a successful pass that skipped source entries', async () => {
      // A synced/up-to-date pass reports a reason when the source held entries
      // it did not mirror (this wording is what `skippedNote` emits). Both tools
      // must surface it: the log does not, so dropping it here leaves "part of
      // the build was skipped" invisible.
      const SINGLE = 'skipped 1 non-regular entry in the extension source: sneaky.js'
      const PLURAL = 'skipped 2 non-regular entries in the extension source: fifo, sneaky.js'
      const cases: Array<{ sync: SyncResult; line: string }> = [
        {
          sync: { status: 'up-to-date', target: '/tmp/mirror', source: '/tmp/dist', files: 12, reason: SINGLE },
          line: `extension files: up-to-date at /tmp/mirror — ${SINGLE}`,
        },
        {
          sync: { status: 'synced', target: '/tmp/mirror', source: '/tmp/dist', files: 12, reason: PLURAL },
          line: `extension files: refreshed just now (12 files) at /tmp/mirror — ${PLURAL}`,
        },
      ]
      for (const { sync, line } of cases) {
        const h = makeHostHarness({ sync })
        expect(mirrorLineOf(await runText(h.registered, 'browser_status'))).toBe(line)
        expect(mirrorLineOf(await runText(h.registered, 'browser_setup'))).toBe(line)
      }
    })

    it('leaves a successful pass without a reason character-for-character unchanged', async () => {
      // The note is appended only when there is one: an empty or absent reason
      // must not grow a separator, an empty pair of parens, or trailing space.
      const current = await runText(makeHostHarness({ sync: CURRENT }).registered, 'browser_status')
      expect(mirrorLineOf(current)).toBe('extension files: up-to-date at /tmp/mirror')

      const refreshed = await runText(makeHostHarness({ sync: REFRESHED }).registered, 'browser_setup')
      expect(mirrorLineOf(refreshed)).toBe('extension files: refreshed just now (12 files) at /tmp/mirror')

      const blankReason = await runText(
        makeHostHarness({ sync: { status: 'up-to-date', target: '/tmp/mirror', files: 12, reason: '' } }).registered,
        'browser_status',
      )
      expect(mirrorLineOf(blankReason)).toBe('extension files: up-to-date at /tmp/mirror')
    })

    it('answers without throwing when both the mirror seam and the path resolver fail', async () => {
      // `safeSync`'s catch must not call anything that can throw: a resolver
      // fault there turns the one tool that reports failures into the failure.
      vi.resetModules()
      vi.doMock('@deepseek-ai/dsh-home-paths', () => ({
        dshHomePath: () => {
          throw new Error('injected: dshHomePath exploded')
        },
      }))
      try {
        // Armed on purpose: a regression to `installedExtensionDir()` inside the
        // catch would hit this mock and fail the test instead of passing quietly.
        const homePaths = await import('@deepseek-ai/dsh-home-paths')
        expect(() => homePaths.dshHomePath('browser-extension')).toThrow(/dshHomePath exploded/)

        const fresh = await import('../src/tools.ts')
        const registered: { name: string; definition: Record<string, unknown> }[] = []
        const ctx = {
          tools: {
            register: (definition: { name: string }) => {
              registered.push({ name: definition.name, definition: definition as Record<string, unknown> })
              return () => {}
            },
          },
          get: () => undefined,
        } as unknown as Context
        const bridge = {
          requestTool: vi.fn(),
          clientDebugger: () => false,
          hasConnection: () => false,
          clientExtensionVersion: () => undefined,
        } as unknown as BridgeServer
        fresh.registerBrowserTools(ctx, bridge, {
          ...BUDGETS,
          host: {
            syncExtension: async () => { throw new Error('injected: mirror seam exploded') },
          },
        })

        const statusText = await runText(registered, 'browser_status')
        expect(statusText).toContain('extension files: refresh failed — injected: mirror seam exploded')
        expect(statusText).not.toContain('()')
        expect(lastLine(statusText)).toBe('next: run browser_setup to retry refreshing the extension files')

        const setupText = await runText(registered, 'browser_setup')
        expect(setupText).toContain('extension files: refresh failed — injected: mirror seam exploded')
        expect(setupText).not.toContain('()')
        expect(lastLine(setupText)).toBe('next: fix the reported cause, then call browser_setup again')
      } finally {
        vi.doUnmock('@deepseek-ai/dsh-home-paths')
        vi.resetModules()
      }
    })

    it('keeps both host tools when debugging is off and the toolset is down-levelled', async () => {
      const h = makeHostHarness()
      expect(h.tools.names()).toContain('browser_status')
      expect(h.tools.names()).toContain('browser_setup')
      // Neither name belongs to a gated group: this is the reason the tools
      // below cannot be pruned, not an accident of the registration order.
      for (const name of HOST_TOOL_NAMES) {
        expect(DEBUG_TOOL_NAMES).not.toContain(name)
        expect(TOOLSET_TOOL_NAMES).not.toContain(name)
        expect(BROWSER_TOOL_NAMES).not.toContain(name)
      }

      h.tools.setDebugToolsEnabled(true)
      h.tools.setDebugToolsEnabled(false)
      h.tools.setClientToolset(LEGACY_TOOLSET)
      expect(h.registered.some((r) => r.name === 'browser_status')).toBe(true)
      expect(h.registered.some((r) => r.name === 'browser_setup')).toBe(true)
      // A down-levelled surface still answers: the status text stays complete.
      const text = await runText(h.registered, 'browser_status')
      expect(text).toContain(`plugin: proto ${BRIDGE_PROTO}, toolset ${BRIDGE_TOOLSET}`)

      h.tools.setClientToolset(BRIDGE_TOOLSET)
      expect(h.registered.some((r) => r.name === 'browser_status')).toBe(true)
      expect(h.registered.some((r) => r.name === 'browser_setup')).toBe(true)

      h.tools.dispose()
      expect(h.registered.some((r) => HOST_TOOL_NAMES.includes(r.name as typeof HOST_TOOL_NAMES[number]))).toBe(false)
    })
  })
})
