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
  PAGE_CHOICE_WINDOW_MS,
  SILENT_CALL_NUDGE_MS,
  TOOLSET_TOOL_NAMES,
  clampWaitMs,
  pageToolTimeoutMs,
  registerBrowserTools,
} from '../src/tools.ts'
import { BridgeToolError } from '../src/server.ts'
import type { SyncResult } from '../src/extension-assets.ts'
import type { BridgeCaps } from '../src/protocol.ts'
import {
  BRIDGE_PROTO,
  BRIDGE_TOOLSET, LEGACY_TOOLSET, TOOLSET_PAGE_IMAGE, TOOLSET_POINTER_CLICK, TOOLSET_SELECTOR_TARGETS,
  TOOLSET_SELECT_OPTION,
  TOOLSET_SLIDES_OPEN_PAGE,
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
  function makeHarness(
    services: Record<string, unknown> = {},
    debuggerAllowed = false,
    uiLanguage?: 'en' | 'zh',
    waitingReported = false,
  ) {
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
    // `clientUiLanguage` is the connected extension's report; undefined models a
    // build too old to send one, which is what keeps the prompts in English.
    // `clientReportsWaiting` is the other report: false is a build that cannot
    // say when it is waiting for the user, so the question falls back to timing
    // the call's silence.
    const bridge = {
      requestTool,
      clientDebugger: () => debuggerAllowed,
      clientUiLanguage: () => uiLanguage,
      clientReportsWaiting: () => waitingReported,
    } as unknown as BridgeServer
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

  it('keeps the read descriptions free of feed-only fields and Chinese copy', () => {
    // The extension's operation feed marks a read that found nothing. That mark
    // is a panel concern: if it ever reaches the model, it does so as a new
    // schema field or as Chinese wording in a description that is otherwise
    // English, so both are asserted here rather than trusted.
    const { ctx, bridge, registered } = makeHarness()
    const tools = registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })

    for (const name of ['browser_get_text', 'browser_dom_query'] as const) {
      const definition = registered.find((entry) => entry.name === name)?.definition
      expect(definition, name).toBeDefined()
      const surface = JSON.stringify(definition)
      expect(surface, name).not.toContain('noMatch')
      expect(surface, name).not.toMatch(/[\u4e00-\u9fff]/)
    }

    tools.dispose()
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

  it('gates browser_debug on both the debugging capability and its own level', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    const tools = registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const params = (definition: Record<string, unknown>): Record<string, unknown> =>
      (definition.parameters as { properties: Record<string, unknown> }).properties
    const exec = { signal: new AbortController().signal }

    // Debugging off: the tool does not exist, whatever the level says.
    expect(tools.names()).not.toContain('browser_debug')

    tools.setDebugToolsEnabled(true)
    expect(tools.names()).toContain('browser_debug')
    const debug = (): Record<string, unknown> => registered.find((r) => r.name === 'browser_debug')!.definition
    expect(Object.keys(params(debug()))).toEqual(expect.arrayContaining([
      'action', 'kind', 'url', 'urlRegex', 'lineNumber', 'condition', 'id', 'all', 'cursor', 'timeoutMs', 'frameIndex', 'expression',
    ]))
    expect(String(debug().description)).toContain('breakpoint')

    await (debug().execute as (a: unknown, e: typeof exec) => Promise<unknown>)({ action: 'resume' }, exec)
    expect(requestTool).toHaveBeenCalledWith('browser_debug', { action: 'resume' }, exec.signal, 1_000)

    // A build below the level that ships the wire case must not be offered it:
    // it would answer "Unknown action", which the model cannot anticipate.
    tools.setClientToolset(TOOLSET_SELECT_OPTION)
    expect(tools.names()).not.toContain('browser_debug')
    // The other debugging tools are level-independent and stay.
    expect(tools.names()).toContain('browser_eval')

    tools.setClientToolset(BRIDGE_TOOLSET)
    expect(tools.names()).toContain('browser_debug')
    tools.setDebugToolsEnabled(false)
    expect(tools.names()).not.toContain('browser_debug')

    // The real-world order: an older extension connects first, then the user
    // turns debugging on. The level gate has to survive that ordering too.
    tools.setClientToolset(TOOLSET_SELECT_OPTION)
    tools.setDebugToolsEnabled(true)
    expect(tools.names()).not.toContain('browser_debug')
    expect(tools.names()).toContain('browser_eval')
  })

  it('gates the native-select arguments at TOOLSET_SELECT_OPTION', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    const tools = registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const params = (definition: Record<string, unknown>): Record<string, unknown> =>
      (definition.parameters as { properties: Record<string, unknown> }).properties
    const exec = { signal: new AbortController().signal }
    const click = (): Record<string, unknown> => registered.find((r) => r.name === 'browser_click')!.definition
    const domQuery = (): Record<string, unknown> => registered.find((r) => r.name === 'browser_dom_query')!.definition
    const run = async (definition: Record<string, unknown>, args: unknown): Promise<unknown> =>
      await (definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)(args, exec)

    // Current level: `option` is declared and forwarded, and the dom-query field
    // that feeds it is advertised.
    expect(Object.keys(params(click()))).toContain('option')
    expect(String((params(domQuery()).fields as { description: string }).description)).toContain('options')
    await run(click(), { index: 3, option: 'Phone' })
    expect(requestTool).toHaveBeenCalledWith('browser_click', { index: 3, option: 'Phone' }, exec.signal, 1_000)

    // Level 5 predates it: the schema drops the parameter, and an option from a
    // schema the model read before the swap is refused as a next step instead of
    // reaching a build that ignores it and reports a click that changed nothing.
    tools.setClientToolset(TOOLSET_SLIDES_OPEN_PAGE)
    expect(Object.keys(params(click()))).not.toContain('option')
    requestTool.mockClear()
    const refused = await run(click(), { index: 3, option: 'Phone' })
    expect(requestTool).not.toHaveBeenCalled()
    expect(String((refused as { text: string }).text)).toContain('predates native select support')
    const refusedQuery = await run(domQuery(), { selector: 'select', fields: ['options'] })
    expect(requestTool).not.toHaveBeenCalled()
    expect(String((refusedQuery as { text: string }).text)).toContain('predates native select support')

    // Everything else on those two tools still runs at that level.
    await run(click(), { index: 3 })
    expect(requestTool).toHaveBeenCalledWith('browser_click', { index: 3 }, exec.signal, 1_000)
    requestTool.mockClear()
    await run(domQuery(), { selector: 'select', fields: ['value'] })
    expect(requestTool).toHaveBeenCalledWith('browser_dom_query', { selector: 'select', fields: ['value'] }, exec.signal, 1_000)
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

  it('names the extension setting, not the model route, when debugging is what blocks the screenshot', async () => {
    // Measured complaint: with "Allow browser debugging" switched off, the model
    // was told the *route* cannot take images — wrong, and it named no action.
    const { ctx, bridge, requestTool, registered } = makeHarness(visualServices(), false)
    requestTool.mockResolvedValueOnce({ text: 'snapshot text' })
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_snapshot')!
    const value = await (tool.definition.execute as (a: unknown, e: unknown) => Promise<{ text: string }>)({}, routedExec())

    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', { visual: false }, expect.anything(), 1_000, 'session-visual')
    expect(value.text).toContain('Allow browser debugging')
    expect(value.text).not.toContain('does not declare image input')
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

  /**
   * One refused page call, and whatever the page choice made of it.
   *
   * `listText` is what `browser_list_tabs` answers, `ask` is the user's answer
   * to the page question, `uiLanguage` is what the extension reported over
   * `bridge.uiLanguage`, and everything the host sends to the extension lands
   * in `seen` in order.
   */
  function pageChoiceHarness(
    listText: string,
    askResponse: (request: unknown) => Promise<unknown>,
    uiLanguage?: 'en' | 'zh',
  ) {
    const ask = vi.fn(askResponse)
    const seen: string[] = []
    const { ctx, bridge, requestTool, registered } = makeHarness({ userQuestions: { ask } }, false, uiLanguage)
    const dispatchCount = (): number => seen.filter((entry) => entry === 'browser_dom_query').length
    requestTool.mockImplementation(async (name: string) => {
      seen.push(name)
      if (name === 'browser_list_tabs') return { text: listText }
      if (name === 'browser_bind_tab') return { text: 'Bound session to tab 7: Orders' }
      // The shape the extension reported: a session whose active tab is a page
      // no other extension may touch, refused once per call.
      if (dispatchCount() === 1) {
        throw new BridgeToolError('action-failed', 'chrome://newtab/ cannot be operated.', true)
      }
      return { text: 'two rows' }
    })
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const exec = { signal: new AbortController().signal, agent: { id: 'session-a' } }
    const run = async (): Promise<unknown> => {
      const definition = registered.find((entry) => entry.name === 'browser_dom_query')!.definition
      return await (definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)({ selector: '#row' }, exec)
    }
    return { ask, seen, requestTool, exec, run }
  }

  it('resolves a missing page inside the call the extension refused', async () => {
    const { ask, seen, requestTool, exec, run } = pageChoiceHarness(
      'ID=7 | Orders | https://app.example/orders',
      async () => ({ answers: [] }),
    )

    const result = await run()

    // The same call finishes, on the page that was open — no failed call and no
    // second tool call to bind. The line in front names that page, because its
    // own text ("two rows") never says which page answered.
    expect(String((result as { text: string }).text)).toBe(
      'Bound this session to tab 7 — https://app.example/orders (chosen by the user, not by the bridge).\ntwo rows',
    )
    expect(seen).toEqual(['browser_dom_query', 'browser_list_tabs', 'browser_bind_tab', 'browser_dom_query'])
    expect(requestTool).toHaveBeenLastCalledWith('browser_dom_query', { selector: '#row' }, exec.signal, 5_000, 'session-a')
    // One open page is not a choice: a question with a single option would wait
    // for a click that decides nothing.
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks which page to use when the session really has a choice', async () => {
    const { ask, seen, requestTool, exec, run } = pageChoiceHarness(
      'ID=7 | Orders | https://app.example/orders\nID=9 | Mail | https://mail.example/',
      async () => ({ answers: [{ id: 'bind-page', selected: ['7 — Orders'] }] }),
    )

    const result = await run()

    // The question's answer is the page: `7 — Orders` binds tab 7, and the
    // retried call says so in front of its own text.
    expect(String((result as { text: string }).text)).toBe(
      'Bound this session to tab 7 — https://app.example/orders (chosen by the user, not by the bridge).\ntwo rows',
    )
    expect(ask).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['browser_dom_query', 'browser_list_tabs', 'browser_bind_tab', 'browser_dom_query'])
    expect(requestTool).toHaveBeenCalledWith('browser_bind_tab', { tabId: 7 }, exec.signal, 5_000, 'session-a')
  })

  it('words the page question in the language the extension reported', async () => {
    const english = pageChoiceHarness(
      'ID=7 | Orders | https://app.example/orders\nID=9 | Mail | https://mail.example/',
      async () => ({ answers: [{ id: 'bind-page', selected: ['7 — Orders'] }] }),
      'en',
    )
    await english.run()
    const englishQuestion = (english.ask.mock.calls[0]?.[0] as { questions: Array<{ question: string }> }).questions[0]
    expect(englishQuestion?.question).toBe('Which open page should this session operate?')

    const chinese = pageChoiceHarness(
      'ID=7 | Orders | https://app.example/orders\nID=9 | Mail | https://mail.example/',
      async () => ({ answers: [{ id: 'bind-page', selected: ['7 — Orders'] }] }),
      'zh',
    )
    await chinese.run()
    const chineseQuestion = (chinese.ask.mock.calls[0]?.[0] as { questions: Array<{ question: string }> }).questions[0]
    expect(chineseQuestion?.question).toMatch(/\p{Script=Han}/u)
  })

  it('keeps the page question in English when the extension never reported a language', async () => {
    // An extension older than `bridge.uiLanguage` sends nothing. The question
    // must still be asked — in English — rather than failing the call.
    const { ask, run } = pageChoiceHarness(
      'ID=7 | Orders | https://app.example/orders\nID=9 | Mail | https://mail.example/',
      async () => ({ answers: [{ id: 'bind-page', selected: ['7 — Orders'] }] }),
    )

    const result = await run()

    expect(String((result as { text: string }).text)).toBe(
      'Bound this session to tab 7 — https://app.example/orders (chosen by the user, not by the bridge).\ntwo rows',
    )
    expect((ask.mock.calls[0]?.[0] as { questions: Array<{ question: string }> }).questions[0]?.question)
      .toBe('Which open page should this session operate?')
  })

  it('leaves a refusal a page choice cannot fix to the model', async () => {
    // Another session owns the browser: a bind here would fail too, and its
    // answer ("ask the user to press Unbind") is the one the model needs.
    const seen: string[] = []
    const ask = vi.fn(async () => ({ answers: [] }))
    const { ctx, bridge, requestTool, registered } = makeHarness({ userQuestions: { ask } })
    requestTool.mockImplementation(async (name: string) => {
      seen.push(name)
      throw new BridgeToolError('action-failed', 'The controlled tab is already bound to session other.', false)
    })
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const exec = { signal: new AbortController().signal, agent: { id: 'session-a' } }
    const definition = registered.find((entry) => entry.name === 'browser_dom_query')!.definition
    const run = (): Promise<unknown> =>
      (definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)({ selector: '#row' }, exec)

    await expect(run()).rejects.toThrow('already bound to session other')
    expect(seen).toEqual(['browser_dom_query'])
    expect(ask).not.toHaveBeenCalled()
  })

  it('keeps the extension\'s refusal when no page could be chosen', async () => {
    const { ask, seen, run } = pageChoiceHarness(
      'No bindable web tabs are open (open a page first).',
      async () => ({ answers: [] }),
    )

    // Nothing was bound, so the failure the extension gave stands — its text
    // already names both ways out for the model.
    await expect(run()).rejects.toThrow('chrome://newtab/ cannot be operated')
    expect(seen).toEqual(['browser_dom_query', 'browser_list_tabs'])
    expect(ask).not.toHaveBeenCalled()
  })

  it('keeps the extension\'s refusal when the user declines the page', async () => {
    const { ask, seen, run } = pageChoiceHarness(
      'ID=7 | Orders | https://app.example/orders\nID=9 | Mail | https://mail.example/',
      async () => ({ answers: [{ id: 'bind-page', selected: [] }] }),
    )

    const failure = await run().then(() => 'bound', (error: unknown) => String((error as Error).message))

    // Nothing was bound, so the refusal stands exactly as the extension wrote
    // it, and no line claims a page this session never got.
    expect(failure).toBe('chrome://newtab/ cannot be operated.')
    expect(seen).toEqual(['browser_dom_query', 'browser_list_tabs'])
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('retries a refused page call once, never in a loop', async () => {
    const seen: string[] = []
    const { ctx, bridge, requestTool, registered } = makeHarness({
      userQuestions: { ask: vi.fn(async () => ({ answers: [] })) },
    })
    requestTool.mockImplementation(async (name: string) => {
      seen.push(name)
      if (name === 'browser_list_tabs') return { text: 'ID=7 | Orders | https://app.example/orders' }
      if (name === 'browser_bind_tab') return { text: 'Bound session to tab 7: Orders' }
      // Every dispatch is refused, including the retry: the second one settles
      // the call rather than starting another page choice.
      throw new BridgeToolError('action-failed', 'chrome://newtab/ cannot be operated.', true)
    })
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const exec = { signal: new AbortController().signal, agent: { id: 'session-a' } }
    const definition = registered.find((entry) => entry.name === 'browser_dom_query')!.definition

    await expect((definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)({ selector: '#row' }, exec))
      .rejects.toThrow('chrome://newtab/ cannot be operated')
    expect(seen).toEqual(['browser_dom_query', 'browser_list_tabs', 'browser_bind_tab', 'browser_dom_query'])
  })

  it('stops waiting for a page choice when its window closes', async () => {
    // A user who is away must not leave the call holding the tool slot: the
    // question is withdrawn and the extension's own refusal is the answer.
    vi.useFakeTimers()
    try {
      const { seen, run } = pageChoiceHarness(
        'ID=7 | Orders | https://app.example/orders\nID=9 | Mail | https://mail.example/',
        async (request: unknown) => await new Promise((_resolve, reject) => {
          const signal = (request as { signal?: AbortSignal }).signal
          signal?.addEventListener('abort', () => reject(new Error('the question was withdrawn')), { once: true })
        }),
      )
      const outcome = run().then(() => 'answered', (error: unknown) => String((error as Error).message))

      await vi.advanceTimersByTimeAsync(PAGE_CHOICE_WINDOW_MS)

      expect(await outcome).toContain('chrome://newtab/ cannot be operated')
      expect(seen).toEqual(['browser_dom_query', 'browser_list_tabs'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not offer a page choice to a call that carries no session', async () => {
    const seen: string[] = []
    const { ctx, bridge, requestTool, registered } = makeHarness()
    requestTool.mockImplementation(async (name: string) => {
      seen.push(name)
      throw new BridgeToolError('action-failed', 'chrome://newtab/ cannot be operated.', true)
    })
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const exec = { signal: new AbortController().signal }
    const definition = registered.find((entry) => entry.name === 'browser_dom_query')!.definition

    // Binding needs a session to bind; without one there is nothing to do but
    // report what the extension said.
    await expect((definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)({ selector: '#row' }, exec))
      .rejects.toThrow('chrome://newtab/ cannot be operated')
    expect(seen).toEqual(['browser_dom_query'])
  })

  it('raises one page choice when a step calls two page tools at once', async () => {
    // A model may batch page calls. Each is refused for the same missing page,
    // so without sharing the choice there would be two identical dialogs and two
    // binds, the last one winning for both retries.
    const ask = vi.fn(async () => ({ answers: [{ id: 'bind-page', selected: ['7 — Orders'] }] }))
    const seen: string[] = []
    const { ctx, bridge, requestTool, registered } = makeHarness({ userQuestions: { ask } })
    requestTool.mockImplementation(async (name: string) => {
      seen.push(name)
      if (name === 'browser_list_tabs') return { text: 'ID=7 | Orders | https://app.example/orders\nID=9 | Mail | https://mail.example/' }
      if (name === 'browser_bind_tab') return { text: 'Bound session to tab 7: Orders' }
      // Each tool's own first dispatch is refused; every retry succeeds.
      if (seen.filter((entry) => entry === name).length === 1) {
        throw new BridgeToolError('action-failed', 'chrome://newtab/ cannot be operated.', true)
      }
      return { text: `${name} ran` }
    })
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const exec = { signal: new AbortController().signal, agent: { id: 'session-a' } }
    const run = async (name: string): Promise<unknown> => {
      const definition = registered.find((entry) => entry.name === name)!.definition
      return await (definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)({ selector: '#row' }, exec)
    }

    const [first, second] = await Promise.all([run('browser_dom_query'), run('browser_get_text')])

    // Both retries carry the same page: they shared one choice, so they name
    // the same tab and URL.
    expect(String((first as { text: string }).text)).toBe(
      'Bound this session to tab 7 — https://app.example/orders (chosen by the user, not by the bridge).\nbrowser_dom_query ran',
    )
    expect(String((second as { text: string }).text)).toBe(
      'Bound this session to tab 7 — https://app.example/orders (chosen by the user, not by the bridge).\nbrowser_get_text ran',
    )
    expect(ask).toHaveBeenCalledTimes(1)
    expect(seen.filter((entry) => entry === 'browser_list_tabs')).toHaveLength(1)
    expect(seen.filter((entry) => entry === 'browser_bind_tab')).toHaveLength(1)
  })

  it('names the page the user really picked, not the one the model assumed', async () => {
    // The reported failure: the model assumed one page, the user picked another,
    // and the page it then operated answered with nothing — so nothing told it
    // that it was on the wrong page.
    const { run } = pageChoiceHarness(
      'ID=7 | Orders | https://app.example/orders\nID=15 | Dashboard | https://app.example/dashboard',
      async () => ({ answers: [{ id: 'bind-page', selected: ['15 — Dashboard'] }] }),
    )

    const result = await run()

    expect(String((result as { text: string }).text)).toBe(
      'Bound this session to tab 15 — https://app.example/dashboard (chosen by the user, not by the bridge).\ntwo rows',
    )
  })

  it('leaves a call that never asked for a page byte for byte as it was', async () => {
    // A page choice is the only reason a line appears. A call that succeeds on
    // its first dispatch gets the extension's text untouched, so this test fails
    // the moment the line is added unconditionally.
    const { ctx, bridge, requestTool, registered } = makeHarness()
    requestTool.mockResolvedValue({ text: 'two rows' })
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const exec = { signal: new AbortController().signal, agent: { id: 'session-a' } }
    const definition = registered.find((entry) => entry.name === 'browser_dom_query')!.definition

    const result = await (definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)({ selector: '#row' }, exec)

    expect(result).toEqual({ text: 'two rows' })
  })

  it('keeps the payload shape when the retried call also carries an image', async () => {
    // The visual tools read the image off the same object as the text, so the
    // line is written into `text` rather than replacing the payload.
    const ask = vi.fn(async () => ({ answers: [{ id: 'bind-page', selected: ['9 — Mail'] }] }))
    const { ctx, bridge, requestTool, registered } = makeHarness({ ...visualServices(), userQuestions: { ask } }, true)
    let dispatches = 0
    requestTool.mockImplementation(async (name: string) => {
      if (name === 'browser_list_tabs') return { text: 'ID=7 | Orders | https://app.example/orders\nID=9 | Mail | https://mail.example/' }
      if (name === 'browser_bind_tab') return { text: 'Bound session to tab 9: Mail' }
      dispatches += 1
      if (dispatches === 1) throw new BridgeToolError('action-failed', 'chrome://newtab/ cannot be operated.', true)
      return { text: 'snapshot text', image: CAPTURED }
    })
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const definition = registered.find((entry) => entry.name === 'browser_snapshot')!.definition

    const value = await (definition.execute as (a: unknown, e: unknown) => Promise<{ text: string; image?: { attachmentId: string } }>)({}, routedExec())

    expect(value.text).toBe(
      'Bound this session to tab 9 — https://mail.example/ (chosen by the user, not by the bridge).\nsnapshot text',
    )
    expect(value.image?.attachmentId).toBe('att-1')
  })

  it('names the tab and its URL when the model asks for the page choice by name', async () => {
    const ask = vi.fn(async () => ({ answers: [{ id: 'bind-page', selected: ['9 — Mail'] }] }))
    const { ctx, bridge, requestTool, registered } = makeHarness({ userQuestions: { ask } })
    requestTool.mockImplementation(async (name: string) => {
      if (name === 'browser_list_tabs') return { text: 'ID=7 | Orders | https://app.example/orders\nID=9 | Mail | https://mail.example/' }
      if (name === 'browser_bind_tab') return { text: 'Bound session to tab 9: Mail' }
      return { text: 'ok' }
    })
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const exec = { signal: new AbortController().signal, agent: { id: 'session-a' } }
    const definition = registered.find((entry) => entry.name === 'browser_bind_interactive')!.definition

    const result = await (definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)({}, exec)

    // The extension's own bind answer names the tab and its title but not its
    // URL, so the line carries both.
    expect(String((result as { text: string }).text)).toBe(
      'Bound this session to tab 9 — https://mail.example/ (chosen by the user, not by the bridge).\nBound session to tab 9: Mail',
    )
  })

  it('does not repeat the URL when the bind answer already carries it', async () => {
    const ask = vi.fn(async () => ({ answers: [{ id: 'bind-page', selected: ['9 — Mail'] }] }))
    const { ctx, bridge, requestTool, registered } = makeHarness({ userQuestions: { ask } })
    requestTool.mockImplementation(async (name: string) => {
      if (name === 'browser_list_tabs') return { text: 'ID=9 | Mail | https://mail.example/' }
      if (name === 'browser_bind_tab') return { text: 'Bound session to tab 9: https://mail.example/' }
      return { text: 'ok' }
    })
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const exec = { signal: new AbortController().signal, agent: { id: 'session-a' } }
    const definition = registered.find((entry) => entry.name === 'browser_bind_interactive')!.definition

    const result = await (definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)({}, exec)

    expect(String((result as { text: string }).text)).toBe('Bound session to tab 9: https://mail.example/')
  })

  it('budgets one page call as the bounded parts it is made of', () => {
    // Pinned so the formula is not quietly rewritten: the four bridge waits the
    // sequence can spend (the refused dispatch, the listing, the bind, the
    // retry) plus the user's own window. Declaring less lets the timeout policy
    // answer the model while the question is still on screen.
    expect(pageToolTimeoutMs(5_000)).toBe(4 * 5_000 + PAGE_CHOICE_WINDOW_MS)
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
      // A page tool may spend its time on a page choice before it runs at all,
      // so its limit covers that window plus the bridge waits around it.
      const expected = name === 'browser_bind_interactive' ? BIND_INTERACTIVE_TIMEOUT_MS
        : name === 'google_drive_export' ? GOOGLE_DRIVE_TIMEOUT_MS
          : (HOST_TOOL_NAMES as readonly string[]).includes(name) ? 5_000
            : pageToolTimeoutMs(5_000)
      expect(definition.timeoutMs, name).toBe(expected)
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
    // single description may bloat the always-sent schema payload. Raised from
    // 200 to 210 when `browser_status` took on the debugging-capability line and
    // the extension's debug log — that is the copy a model reads to tell a user
    // why a screenshot has no image, so it is not padding. The live value rides
    // in the failure message: a wording pass that cannot see the headroom either
    // overruns it or raises it blindly.
    //
    // Measured 2026-10-14: that assertion covers the 22 tools which register without the
    // debugging switch. With it on, the surface is 28 tools and averages 253.25 — the
    // debugging half documents a bigger contract (browser_debug 531, browser_dialog 519,
    // browser_network 435, browser_capture 424 at the time), so it gets its own ceiling
    // rather than being averaged in with the rest and hidden from this test, which is what
    // had been happening: a wording pass could not see either number.
    const average = descriptionChars / registered.length
    expect(average, `average model-facing description length: ${average.toFixed(2)} over ${registered.length} tools`).toBeLessThan(210)

    const debugHarness = makeHarness({}, true)
    const debugTools = registerBrowserTools(debugHarness.ctx, debugHarness.bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    debugTools.setDebugToolsEnabled(true)
    const fullChars = debugHarness.registered.reduce((sum, { definition }) => sum + String(definition.description).length, 0)
    const fullAverage = fullChars / debugHarness.registered.length
    expect(
      fullAverage,
      `average length with debugging on: ${fullAverage.toFixed(2)} over ${debugHarness.registered.length} tools`,
    ).toBeLessThan(265)
  })

  it('asks the human about a call that has gone quiet, and keeps waiting', async () => {
    // Fallback shape: this connection cannot report a wait (an extension older
    // than `bridge.toolWaiting`), so the question is timed from the dispatch and
    // a silent call is the only thing the host can go on.
    vi.useFakeTimers()
    try {
      const ask = vi.fn(async () => ({ answers: [] }))
      const { ctx, bridge, requestTool, registered } = makeHarness({ userQuestions: { ask } })
      requestTool.mockImplementation(async () => await new Promise((resolve) => {
        setTimeout(() => resolve({ text: 'clicked' }), 30_000)
      }))
      registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
      const definition = registered.find((entry) => entry.name === 'browser_click')!.definition
      const exec = { signal: new AbortController().signal, agent: { id: 'session-a' } }
      const pending = (definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)({ index: 3 }, exec)

      await vi.advanceTimersByTimeAsync(SILENT_CALL_NUDGE_MS)

      expect(ask).toHaveBeenCalledTimes(1)
      expect(String((ask.mock.calls[0]?.[0] as { questions: Array<{ question: string }> }).questions[0]?.question))
        .toContain('browser_click')
      // The question does not decide anything: the call runs on to its own answer.
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await pending).toMatchObject({ text: 'clicked' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('never asks about a slow action on a connection that reports waits', async () => {
    // The complaint this shape exists for: a whole-page text search over a
    // 700k-character page took 51 seconds on this machine, nothing was waiting
    // for the user, and the time-based question asked anyway. A reporting
    // extension says "not waiting", so silence stops being evidence.
    vi.useFakeTimers()
    try {
      const ask = vi.fn(async () => ({ answers: [] }))
      const { ctx, bridge, requestTool, registered } = makeHarness({ userQuestions: { ask } }, false, undefined, true)
      requestTool.mockImplementation(async () => await new Promise((resolve) => {
        setTimeout(() => resolve({ text: 'searched' }), 120_000)
      }))
      registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
      const definition = registered.find((entry) => entry.name === 'browser_get_text')!.definition
      const exec = { signal: new AbortController().signal, agent: { id: 'session-a' } }
      const pending = (definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)({ find: 'Compliance Questionnaire' }, exec)

      // Well past the threshold, and past it again: no report, no question.
      await vi.advanceTimersByTimeAsync(SILENT_CALL_NUDGE_MS * 3)
      expect(ask).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(60_000)
      expect(await pending).toMatchObject({ text: 'searched' })
      expect(ask).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks 20 seconds into a reported wait, not 20 seconds into the call', async () => {
    vi.useFakeTimers()
    try {
      const ask = vi.fn(async () => ({ answers: [] }))
      const { ctx, bridge, requestTool, registered } = makeHarness({ userQuestions: { ask } }, false, undefined, true)
      const report: { waiting?: (waiting: boolean) => void } = {}
      requestTool.mockImplementation(async (
        _name: string,
        _args: Record<string, unknown>,
        _signal: AbortSignal,
        _timeoutMs?: number,
        _sessionId?: string,
        onWaiting?: (waiting: boolean) => void,
      ) => {
        report.waiting = onWaiting
        return await new Promise((resolve) => {
          setTimeout(() => resolve({ text: 'clicked' }), 120_000)
        })
      })
      registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
      const definition = registered.find((entry) => entry.name === 'browser_click')!.definition
      const exec = { signal: new AbortController().signal, agent: { id: 'session-a' } }
      const pending = (definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)({ index: 3 }, exec)

      // Ten slow seconds with no card up: nothing to ask about.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ask).not.toHaveBeenCalled()

      // The card goes up now; the question is timed from the card.
      report.waiting?.(true)
      await vi.advanceTimersByTimeAsync(SILENT_CALL_NUDGE_MS - 1)
      expect(ask).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(ask).toHaveBeenCalledTimes(1)
      expect(String((ask.mock.calls[0]?.[0] as { questions: Array<{ question: string }> }).questions[0]?.question))
        .toContain('browser_click')

      // The call still runs to its own answer: the question decides nothing.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(await pending).toMatchObject({ text: 'clicked' })
      expect(ask).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the question when the wait ends first, and asks at most once per call', async () => {
    vi.useFakeTimers()
    try {
      const ask = vi.fn(async () => ({ answers: [] }))
      const { ctx, bridge, requestTool, registered } = makeHarness({ userQuestions: { ask } }, false, undefined, true)
      const report: { waiting?: (waiting: boolean) => void } = {}
      requestTool.mockImplementation(async (
        _name: string,
        _args: Record<string, unknown>,
        _signal: AbortSignal,
        _timeoutMs?: number,
        _sessionId?: string,
        onWaiting?: (waiting: boolean) => void,
      ) => {
        report.waiting = onWaiting
        return await new Promise((resolve) => {
          setTimeout(() => resolve({ text: 'clicked' }), 120_000)
        })
      })
      registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
      const definition = registered.find((entry) => entry.name === 'browser_click')!.definition
      const exec = { signal: new AbortController().signal, agent: { id: 'session-a' } }
      const pending = (definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)({ index: 3 }, exec)

      // Answered five seconds in: the user was there, so nothing is asked.
      report.waiting?.(true)
      await vi.advanceTimersByTimeAsync(5_000)
      report.waiting?.(false)
      await vi.advanceTimersByTimeAsync(SILENT_CALL_NUDGE_MS)
      expect(ask).not.toHaveBeenCalled()

      // A second card for the same call: the question is asked once, from the
      // first wait that outlives the threshold, not once per card.
      report.waiting?.(true)
      await vi.advanceTimersByTimeAsync(SILENT_CALL_NUDGE_MS)
      expect(ask).toHaveBeenCalledTimes(1)
      report.waiting?.(false)
      report.waiting?.(true)
      await vi.advanceTimersByTimeAsync(SILENT_CALL_NUDGE_MS)
      expect(ask).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(120_000)
      expect(await pending).toMatchObject({ text: 'clicked' })
    } finally {
      vi.useRealTimers()
    }
  })

  /** Run one silent call to its nudge and return the ask request it produced. */
  async function nudgeRequest(uiLanguage?: 'en' | 'zh'): Promise<unknown> {
    const ask = vi.fn(async () => ({ answers: [] }))
    const { ctx, bridge, requestTool, registered } = makeHarness({ userQuestions: { ask } }, false, uiLanguage)
    requestTool.mockImplementation(async () => await new Promise((resolve) => {
      setTimeout(() => resolve({ text: 'clicked' }), 30_000)
    }))
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const definition = registered.find((entry) => entry.name === 'browser_click')!.definition
    const exec = { signal: new AbortController().signal, agent: { id: 'session-a' } }
    const pending = (definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)({ index: 3 }, exec)
    await vi.advanceTimersByTimeAsync(SILENT_CALL_NUDGE_MS)
    // Let the call settle so its timer cannot outlive the test.
    await vi.advanceTimersByTimeAsync(30_000)
    await pending
    return ask.mock.calls[0]?.[0]
  }

  it('words the nudge and its answers in the language the extension reported', async () => {
    vi.useFakeTimers()
    try {
      const chinese = (await nudgeRequest('zh') as {
        questions: Array<{ question: string; options: Array<{ label: string }> }>
      }).questions[0]!

      expect(chinese.question).toContain('browser_click')
      expect(chinese.question).toMatch(/\p{Script=Han}/u)
      expect(chinese.options.map((option) => option.label)).toEqual(['没有——没有东西在等', '有——我正在处理'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('words the nudge in English when the extension reported nothing usable', async () => {
    // No report (an extension older than the method) and a report the host
    // refused both leave the language unknown, and English is the fallback.
    vi.useFakeTimers()
    try {
      const english = (await nudgeRequest() as {
        questions: Array<{ question: string; options: Array<{ label: string }> }>
      }).questions[0]!

      expect(english.question).toContain('browser_click')
      expect(english.question).not.toMatch(/\p{Script=Han}/u)
      expect(english.options.map((option) => option.label))
        .toEqual(['No — nothing is waiting', 'Yes — I am answering it'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a call that answers quickly, and a tool that asks by design, alone', async () => {
    const ask = vi.fn(async () => ({ answers: [] }))
    const { ctx, bridge, registered } = makeHarness({ userQuestions: { ask } })
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const exec = { signal: new AbortController().signal }
    const run = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const definition = registered.find((entry) => entry.name === name)!.definition
      return await (definition.execute as (a: unknown, e: typeof exec) => Promise<unknown>)(args, exec)
    }

    await run('browser_click', { index: 3 })
    expect(ask).not.toHaveBeenCalled()

    // `browser_bind_interactive` asks its own question and can legitimately take minutes.
    await run('browser_bind_interactive', {})
    expect(ask).not.toHaveBeenCalled()
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
      /** What the extension answers for the `browser_debug_log` readout. */
      debugLog?: string
    } = {}) {
      const { ctx, registered } = makeHarness({}, options.debuggerAllowed ?? false)
      const syncExtension = vi.fn(async (): Promise<SyncResult> => {
        if (options.syncThrows === true) throw new Error('mirror exploded')
        return options.sync ?? CURRENT
      })
      const openExtensionsPage = vi.fn(async () => options.opened ?? true)
      const copyToClipboard = vi.fn(async () => options.copied ?? true)
      const requestTool = vi.fn(async (name: string) => name === 'browser_debug_log'
        ? { text: options.debugLog ?? '' }
        : { text: 'ok' })
      const bridge = {
        requestTool,
        clientDebugger: () => options.debuggerAllowed ?? false,
        clientReportsWaiting: () => options.waitingReported ?? false,
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
      return { ctx, registered, tools, syncExtension, openExtensionsPage, copyToClipboard, requestTool }
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

      // And the same for a mirror the plugin cannot see at all: a connected
      // extension makes every tool answer, so `none — the bridge is ready` under
      // the "not bundled" line reported a healthy bridge while the files Chrome
      // loads could no longer be refreshed from this process at all (measured:
      // the running plugin's repository had been removed and status still said
      // next: none).
      const unavailableOnline = await runText(
        makeHostHarness({ connected: true, version: '0.1.7', caps: CAPS, sync: UNAVAILABLE }).registered,
        'browser_status',
      )
      expect(unavailableOnline).toContain('extension: connected')
      expect(unavailableOnline).toContain('extension files: not bundled with this plugin')
      expect(lastLine(unavailableOnline)).toBe(
        'next: restart dsh from the repository, or build the extension there — this plugin can see no extension build to mirror',
      )
      expect(lastLine(unavailableOnline)).not.toContain('none')

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

    it('states whether the extension allows debugging, and the fix when it does not', async () => {
      // The switch being off used to be invisible: screenshots just arrived
      // without an image, and nothing in status explained why.
      const allowed = await runText(
        makeHostHarness({ connected: true, version: '0.1.7', caps: { ...CAPS, debugger: true } }).registered,
        'browser_status',
      )
      expect(allowed).toContain('debugging: allowed by the extension (screenshots, console, network, evaluation, JavaScript breakpoints)')

      const off = await runText(
        makeHostHarness({ connected: true, version: '0.1.7', caps: { ...CAPS, debugger: false } }).registered,
        'browser_status',
      )
      expect(off).toContain('debugging: off')
      expect(off).toContain('Allow browser debugging')
      expect(off).toContain('enterprise policy')

      // A build that predates the field must not be read as "off by choice".
      const unknown = await runText(
        makeHostHarness({ connected: true, version: '0.1.7', caps: { ...CAPS, debugger: undefined } }).registered,
        'browser_status',
      )
      expect(unknown).toContain('unknown (older build), so debugging is off')

      // Nothing is claimed while nothing is connected: the line is about the
      // extension's own setting, which an absent extension has not reported.
      const offline = await runText(makeHostHarness({ sync: CURRENT }).registered, 'browser_status')
      expect(offline).not.toContain('debugging:')
    })

    it('appends the extension debug log when the extension allows debugging', async () => {
      // The report that started this: "screenshots fail", "eval does not work",
      // "the debug banner appeared and vanished after a few seconds" — from a
      // machine we cannot attach to. Chrome's detach reason and the worker's own
      // start line are the answer, so status carries them.
      const h = makeHostHarness({
        connected: true,
        version: '0.1.7',
        caps: { ...CAPS, debugger: true },
        debugLog: '2026-09-29T00:00:01.000Z attach tab 7 attached (CDP 1.3)\n'
          + '2026-09-29T00:00:09.000Z detach tab 7 detached by Chrome: canceled_by_user',
      })
      const text = await runText(h.registered, 'browser_status')

      expect(h.requestTool).toHaveBeenCalledWith('browser_debug_log', {}, expect.anything(), expect.any(Number))
      expect(text).toContain('debug log (extension, newest last):')
      expect(text).toContain('detach tab 7 detached by Chrome: canceled_by_user')
      // The log is an appendix: the health lines still come first.
      expect(text.indexOf('version skew:')).toBeLessThan(text.indexOf('debug log (extension'))

      // Debugging off means no debugging sessions, so there is nothing to read
      // and nothing is asked of the extension.
      const off = makeHostHarness({
        connected: true,
        version: '0.1.7',
        caps: { ...CAPS, debugger: false },
        debugLog: 'must not appear',
      })
      const offText = await runText(off.registered, 'browser_status')
      expect(offText).not.toContain('debug log (extension')
      expect(offText).not.toContain('must not appear')
      expect(off.requestTool).not.toHaveBeenCalled()

      // A build that predates the readout answers an error: status still answers.
      const failing = makeHostHarness({ connected: true, version: '0.1.7', caps: { ...CAPS, debugger: true } })
      failing.requestTool.mockRejectedValueOnce(new Error('Unknown action: browser_debug_log'))
      const failingText = await runText(failing.registered, 'browser_status')
      expect(failingText).toContain('browser bridge status')
      expect(failingText).not.toContain('debug log (extension')
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
          clientReportsWaiting: () => false,
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

    it('prints an update command for this install without running or touching anything', async () => {
      const h = makeHostHarness()
      const text = await runText(h.registered, 'browser_update')

      // This spec runs from a checkout, so that is the command the user gets;
      // the four mode/platform combinations are pinned in update-source.spec.ts.
      expect(text).toContain('install: checkout at ')
      expect(text).toContain('  ./scripts/install.sh')
      expect(text).toContain('does not run it')
      expect(text).toContain('restart dsh')
      expect(text).toContain('chrome://extensions')
      // The whole point of the tool: it answers and stops. None of the seams
      // that would write the mirror, open a browser, or touch the clipboard may
      // be reached from it — that is what keeps the update the user's action.
      expect(h.syncExtension).not.toHaveBeenCalled()
      expect(h.openExtensionsPage).not.toHaveBeenCalled()
      expect(h.copyToClipboard).not.toHaveBeenCalled()
    })
  })
})
