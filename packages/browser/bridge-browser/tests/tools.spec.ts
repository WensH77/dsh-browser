import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeServer } from '../src/server.ts'
import {
  BIND_INTERACTIVE_TIMEOUT_MS,
  BROWSER_TOOL_NAMES,
  DEBUG_TOOL_NAMES,
  GOOGLE_DRIVE_TIMEOUT_MS,
  TOOLSET_TOOL_NAMES,
  registerBrowserTools,
} from '../src/tools.ts'
import { BRIDGE_TOOLSET, LEGACY_TOOLSET, TOOLSET_SELECTOR_TARGETS, TOOLSET_TEXT_FIND } from '../src/protocol.ts'

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
    expect(tools.names().sort()).toEqual([...alwaysOn, 'browser_bind_interactive', 'google_drive_export'].sort())
    for (const name of DEBUG_TOOL_NAMES) expect(registered.some((r) => r.name === name)).toBe(false)

    tools.setDebugToolsEnabled(true)
    expect(tools.names().sort()).toEqual([...BROWSER_TOOL_NAMES, 'browser_bind_interactive', 'google_drive_export'].sort())

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

    // Level 3: the page-picture tool appears with its own schema.
    tools.setClientToolset(BRIDGE_TOOLSET)
    expect(tools.names()).toContain('browser_image')
    const imageTool = registered.find((r) => r.name === 'browser_image')!.definition
    expect(Object.keys(params(imageTool))).toEqual(expect.arrayContaining(['selector', 'index', 'frame']))

    // Level 0 has neither selector targets nor text search.
    tools.setClientToolset(LEGACY_TOOLSET)
    expect(Object.keys(params(registered.find((r) => r.name === 'browser_get_text')!.definition))).not.toContain('find')
    expect(tools.names()).not.toContain('browser_dom_query')
    expect(Object.keys(params(registered.find((r) => r.name === 'browser_click')!.definition))).not.toContain('selector')
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
    }, exec.signal, 1_000, 'session-visual')
    expect(value.image).toBeDefined()
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
      expect(text).toContain('only exports Google Docs')
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
})
