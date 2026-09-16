// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureTab, visionAvailable } from '../src/background/capture.ts'
import {
  holdDebuggerSession,
  releaseDebuggerSession,
  resetDebuggerSessionsForTest,
} from '../src/background/debugger-session.ts'

/** Small valid-looking payload; the module only counts base64 length, never decodes. */
const PNG_BASE64 = Buffer.from('png-bytes-here').toString('base64')

const LIMITS = { maxBytes: 4_000_000, maxPixels: 4_000_000, maxDimension: 4_096 }

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

    const image = await captureTab(7, { fullPage: true, limits: { ...LIMITS, maxPixels: 40_000_000 } })

    expect(mock.sendCommand).toHaveBeenNthCalledWith(2, { tabId: 7 }, 'Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 1280, height: 4000, scale: 1 },
      captureBeyondViewport: true,
    })
    expect(image).toMatchObject({ width: 1280, height: 4000 })
  })

  it('downscales to honour the deployment pixel and dimension limits', async () => {
    const mock = mockDebugger()

    const image = await captureTab(7, { limits: { ...LIMITS, maxPixels: 1_280 * 800 / 4 } })

    expect(mock.sendCommand).toHaveBeenNthCalledWith(2, { tabId: 7 }, 'Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.5 },
      captureBeyondViewport: false,
    })
    expect(image).toMatchObject({ width: 640, height: 400 })
  })

  it('trades png for jpeg when the encoded bytes stay too large', async () => {
    const big = 'A'.repeat(4_000)
    const mock = mockDebugger({ shots: [{ data: big }, { data: big }, { data: big }, { data: PNG_BASE64 }] })

    const image = await captureTab(7, { limits: { ...LIMITS, maxBytes: 100 } })

    expect(image.mediaType).toBe('image/jpeg')
    const jpegCall = mock.sendCommand.mock.calls[4] as unknown as
      [unknown, string, { format: string; quality: number; captureBeyondViewport: boolean; clip: { scale: number; width: number } }]
    expect(jpegCall[1]).toBe('Page.captureScreenshot')
    const params = jpegCall[2]
    expect(params.format).toBe('jpeg')
    expect(params.quality).toBe(80)
    expect(params.captureBeyondViewport).toBe(false)
    expect(params.clip.width).toBe(1280)
    expect(params.clip.scale).toBeCloseTo(0.49, 6)
  })

  it('reuses the session this extension already holds instead of blaming DevTools', async () => {
    // Chrome reports "Another debugger is already attached" only when *this*
    // extension owns the target, so the honest response is to reuse it.
    const mock = mockDebugger({ attachError: new Error('Another debugger is already attached to the tab with id: 7') })

    const image = await captureTab(7, { limits: LIMITS })

    expect(image.mediaType).toBe('image/png')
    expect(mock.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Page.getLayoutMetrics')
    expect(mock.detach).toHaveBeenCalledWith({ tabId: 7 })
  })

  it('captures over the console/network hold without a second attach', async () => {
    // The real-world failure: priming holds the tab, so a capture that attached
    // again was refused and the refusal read as if DevTools were open.
    const mock = mockDebugger()
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
