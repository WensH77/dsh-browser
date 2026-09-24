// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureTab, visionAvailable } from '../src/background/capture.ts'
import {
  holdDebuggerSession,
  releaseDebuggerSession,
  resetDebuggerSessionsForTest,
} from '../src/background/debugger-session.ts'

/** Small valid-looking payload; the decoder is stubbed, so only its length matters. */
const PNG_BASE64 = Buffer.from('png-bytes-here').toString('base64')

const LIMITS = { maxBytes: 4_000_000, maxPixels: 4_000_000, maxDimension: 4_096 }

/** A blob stand-in: jsdom's Blob has no `arrayBuffer()`. */
function fakeBlob(bytes: Uint8Array, type: string): Blob {
  return { size: bytes.length, type, arrayBuffer: async () => bytes } as unknown as Blob
}

/**
 * Stand in for the decoder and the re-encode canvas.
 *
 * `captureTab` reads the encoded header first and only decodes when the raster
 * has to shrink; the stubbed bitmap is what the assertions treat as "what came
 * back" when it does.
 */
function stubRaster(width: number, height: number): {
  canvases: Array<{ width: number; height: number }>
  convertToBlob: ReturnType<typeof vi.fn>
  decode: ReturnType<typeof vi.fn>
} {
  const canvases: Array<{ width: number; height: number }> = []
  const convertToBlob = vi.fn(async (options: { type?: string } = {}) =>
    fakeBlob(new Uint8Array(64), options.type ?? 'image/png'))
  const decode = vi.fn(async () => ({ width, height, close: vi.fn() }))
  vi.stubGlobal('createImageBitmap', decode)
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(readonly width: number, readonly height: number) { canvases.push({ width, height }) }
    getContext(): unknown { return { drawImage: vi.fn() } }
    convertToBlob(options?: { type?: string; quality?: number }): Promise<Blob> { return convertToBlob(options) }
  })
  return { canvases, convertToBlob, decode }
}

/** A PNG whose header declares these dimensions; nothing here decodes real pixels. */
function pngWithSize(width: number, height: number): string {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)                   // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // 'IHDR'
  view.setUint32(16, width)
  view.setUint32(20, height)
  return Buffer.from(bytes).toString('base64')
}

function mockDebugger(overrides: {
  metrics?: unknown
  shots?: Array<{ data?: string } | Error>
  attachError?: Error
  /** What `chrome.debugger.getTargets()` reports (foreign attachments). */
  targets?: unknown[]
} = {}) {
  const attach = vi.fn(async () => {
    if (overrides.attachError !== undefined) throw overrides.attachError
  })
  const detach = vi.fn(async () => undefined)
  const shots = [...(overrides.shots ?? [{ data: PNG_BASE64 }])]
  const sendCommand = vi.fn(async (_target: unknown, method: string) => {
    if (method === 'Page.getLayoutMetrics') {
      return overrides.metrics ?? {
        cssVisualViewport: { clientWidth: 1280, clientHeight: 800 },
        contentSize: { width: 1280, height: 4000 },
      }
    }
    // Domain enables answer with an empty result and must not consume a shot.
    if (method !== 'Page.captureScreenshot') return {}
    const shot = shots.shift()
    if (shot instanceof Error) throw shot
    return shot
  })
  const getTargets = vi.fn(async () => overrides.targets ?? [])
  vi.stubGlobal('chrome', { debugger: { attach, detach, sendCommand, getTargets } })
  return { attach, detach, sendCommand }
}

afterEach(() => {
  resetDebuggerSessionsForTest()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('captureTab', () => {
  it('reports no vision when the build has no debugger API', async () => {
    vi.stubGlobal('chrome', {})
    expect(visionAvailable()).toBe(false)
    await expect(captureTab(7, {})).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('captures the viewport at CSS-pixel scale and always detaches', async () => {
    const mock = mockDebugger()
    stubRaster(1280, 800)

    const image = await captureTab(7, { limits: LIMITS })

    expect(mock.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3')
    expect(mock.sendCommand).toHaveBeenNthCalledWith(1, { tabId: 7 }, 'Page.getLayoutMetrics')
    expect(mock.sendCommand).toHaveBeenNthCalledWith(2, { tabId: 7 }, 'Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 },
      captureBeyondViewport: false,
    })
    expect(image).toMatchObject({ mediaType: 'image/png', width: 1280, height: 800 })
    expect(image.bytes).toBeGreaterThan(0)
    expect(mock.detach).toHaveBeenCalledWith({ tabId: 7 })
  })

  it('captures the whole page beyond the viewport when asked', async () => {
    const mock = mockDebugger()
    stubRaster(1280, 4000)

    const image = await captureTab(7, { fullPage: true, limits: { ...LIMITS, maxPixels: 40_000_000 } })

    expect(mock.sendCommand).toHaveBeenNthCalledWith(2, { tabId: 7 }, 'Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 1280, height: 4000, scale: 1 },
      captureBeyondViewport: true,
    })
    expect(image).toMatchObject({ width: 1280, height: 4000 })
  })

  it('answers a full page that would arrive unreadable with the viewport instead', async () => {
    // 8192 CSS px tall at DPR 2 is a 16384 px raster: admission clamps it to 8192
    // and the delivery budget to 3916, which is 0.48x of the CSS height. That page
    // is legible as the viewport and useless as a thumbnail of everything.
    const mock = mockDebugger({
      metrics: {
        cssVisualViewport: { clientWidth: 1280, clientHeight: 800 },
        contentSize: { width: 2239, height: 8192 },
      },
      shots: [{ data: pngWithSize(4478, 16384) }, { data: pngWithSize(2560, 1600) }],
    })
    stubRaster(2560, 1600)
    const limits = { maxBytes: 20_971_520, maxPixels: 64_000_000, maxDimension: 8_192 }
    const deliver = { maxBytes: 4_194_304, maxPixels: 4_194_304, maxDimension: 8_192 }

    const image = await captureTab(7, { fullPage: true, limits, deliver })

    const bridgeCalls = mock.sendCommand.mock.calls as unknown as
      Array<[unknown, string, { captureBeyondViewport: boolean }]>
    const shots = bridgeCalls.filter((call) => call[1] === 'Page.captureScreenshot')
    expect(shots).toHaveLength(2)
    expect(shots.map((call) => call[2].captureBeyondViewport)).toEqual([true, false])
    expect(image).toMatchObject({ width: 2560, height: 1600 })
    expect(image.note).toContain('48% of its CSS size')
    expect(image.note).toContain('browser_get_text')
  })

  it('keeps the full page when it still arrives legibly', async () => {
    // 3000 CSS px tall at DPR 2: delivered at ~0.68x, above the 0.63x floor, so
    // the whole page is what the caller asked for and gets.
    const mock = mockDebugger({
      metrics: {
        cssVisualViewport: { clientWidth: 1280, clientHeight: 800 },
        contentSize: { width: 3038, height: 3000 },
      },
      shots: [{ data: pngWithSize(6076, 6000) }],
    })
    const limits = { maxBytes: 20_971_520, maxPixels: 64_000_000, maxDimension: 8_192 }
    const deliver = { maxBytes: 4_194_304, maxPixels: 4_194_304, maxDimension: 8_192 }

    const image = await captureTab(7, { fullPage: true, limits, deliver })

    expect(mock.sendCommand.mock.calls.filter((call) => call[1] === 'Page.captureScreenshot')).toHaveLength(1)
    expect(image).toMatchObject({ width: 6076, height: 6000 })
    expect(image.note).toBeUndefined()
  })

  it('passes the bytes through when the header already says they fit, without decoding', async () => {
    // A page that is long but still admissible needs no resizing, and the header
    // is enough to know it. Decoding the 41.6 MP full-page raster just to measure
    // it is what pushed this path into the tool timeout.
    mockDebugger({ shots: [{ data: pngWithSize(6076, 6850) }] })
    const raster = stubRaster(6076, 6850)

    const image = await captureTab(7, {
      fullPage: true,
      limits: { ...LIMITS, maxPixels: 64_000_000, maxDimension: 8_192 },
    })

    expect(raster.decode).not.toHaveBeenCalled()
    expect(image).toMatchObject({ mediaType: 'image/png', width: 6076, height: 6850 })
  })

  it('asks the browser to shrink a long page while decoding it', async () => {
    // The same article at DPR 2 comes back 2126x16384: 34.8 MP, 16384 px on a
    // side. Decoding that whole raster and then scaling it never returned.
    mockDebugger({ shots: [{ data: pngWithSize(2126, 16384) }] })
    const raster = stubRaster(532, 4096)

    const image = await captureTab(7, { fullPage: true, limits: LIMITS })

    expect(raster.decode).toHaveBeenCalledWith(expect.anything(), {
      resizeWidth: 532,
      resizeHeight: 4096,
      resizeQuality: 'high',
    })
    expect(raster.canvases).toEqual([{ width: 532, height: 4096 }])
    expect(image).toMatchObject({ width: 532, height: 4096 })
    expect(image.bytes).toBeLessThanOrEqual(LIMITS.maxBytes)
  })

  it('reports the decoded size when the header cannot be read', async () => {
    // Payloads the header parser does not know still get an honest answer, taken
    // from the bitmap: the size a capture was *requested* at is never reported.
    const mock = mockDebugger()
    const raster = stubRaster(3038, 23641)

    const image = await captureTab(7, { fullPage: true, limits: LIMITS })

    const screenshot = mock.sendCommand.mock.calls[1] as unknown as [unknown, string, { clip: { scale: number } }]
    expect(screenshot[2].clip.scale).toBe(1)
    expect(raster.decode).toHaveBeenCalledWith(expect.anything())
    expect(image.width).toBe(526)
    expect(image.height).toBe(4096)
    expect(raster.canvases).toEqual([{ width: 526, height: 4096 }])
  })

  it('fits the raster into the deployment pixel and dimension limits itself', async () => {
    const mock = mockDebugger()
    stubRaster(1280, 800)

    const image = await captureTab(7, { limits: { ...LIMITS, maxPixels: 1_280 * 800 / 4 } })

    // The capture is never asked to scale: the resize happens after decoding.
    expect(mock.sendCommand).toHaveBeenNthCalledWith(2, { tabId: 7 }, 'Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 },
      captureBeyondViewport: false,
    })
    expect(image).toMatchObject({ width: 640, height: 400 })
  })

  it('trades png for jpeg when the fitted bytes stay too large', async () => {
    const big = 'A'.repeat(4_000)
    mockDebugger({ shots: [{ data: big }] })
    const raster = stubRaster(1280, 800)
    raster.convertToBlob.mockImplementation(async (options: { type?: string } = {}) =>
      fakeBlob(new Uint8Array(options.type === 'image/jpeg' ? 100 : 5_000), options.type ?? 'image/png'))

    const image = await captureTab(7, { limits: { ...LIMITS, maxBytes: 1_000 } })

    expect(image.mediaType).toBe('image/jpeg')
    expect(image.bytes).toBeLessThanOrEqual(1_000)
  })

  it('reuses the session this extension already holds instead of blaming DevTools', async () => {
    // Chrome reports "Another debugger is already attached" only when *this*
    // extension owns the target, so the honest response is to reuse it.
    const mock = mockDebugger({ attachError: new Error('Another debugger is already attached to the tab with id: 7') })
    stubRaster(1280, 800)

    const image = await captureTab(7, { limits: LIMITS })

    expect(image.mediaType).toBe('image/png')
    expect(mock.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Page.getLayoutMetrics')
    expect(mock.detach).toHaveBeenCalledWith({ tabId: 7 })
  })

  it('captures over the console/network hold without a second attach', async () => {
    // The real-world failure: priming holds the tab, so a capture that attached
    // again was refused and the refusal read as if DevTools were open.
    const mock = mockDebugger()
    stubRaster(1280, 800)
    await holdDebuggerSession(7, { runtime: true, log: true, network: true })

    const image = await captureTab(7, { limits: LIMITS })

    expect(image.mediaType).toBe('image/png')
    expect(mock.attach).toHaveBeenCalledTimes(1)
    // The buffer session must survive the screenshot.
    expect(mock.detach).not.toHaveBeenCalled()
    await releaseDebuggerSession(7)
    expect(mock.detach).toHaveBeenCalledWith({ tabId: 7 })
  })

  it('names a foreign debugger when another client holds the tab', async () => {
    const mock = mockDebugger({
      attachError: new Error('Cannot attach to this target.'),
      targets: [{ id: 't1', tabId: 7, attached: true, type: 'page', title: 'x', url: 'https://app.example/' }],
    })

    await expect(captureTab(7, { limits: LIMITS })).rejects.toMatchObject({
      code: 'action-failed',
      reason: 'foreign-debugger',
      message: expect.stringContaining('DevTools'),
    })
    expect(mock.detach).not.toHaveBeenCalled()
  })

  it('keeps the protected-page copy when nothing else holds the tab', async () => {
    mockDebugger({ attachError: new Error('Cannot attach to this target.'), targets: [] })

    await expect(captureTab(7, { limits: LIMITS })).rejects.toMatchObject({
      code: 'unsupported',
      reason: 'restricted-page',
    })
  })
})
