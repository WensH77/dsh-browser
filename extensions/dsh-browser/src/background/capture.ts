/**
 * Tab screenshots over `chrome.debugger` (CDP `Page.captureScreenshot`).
 *
 * Attach-per-capture: the debugger session lives only for the duration of one
 * capture, so the browser's debugging infobar is transient and no session is
 * left dangling across service-worker restarts. Captured bytes stay in memory
 * and travel to the host as base64 on the bridge; neither half writes a file.
 *
 * Chrome cannot attach while DevTools is open on the same tab, and the user can
 * dismiss the infobar, which detaches the session. Both are reported as stable
 * errors with actionable text.
 *
 * @module
 */

import type {
  CaptureLimits,
  CaptureRequest,
  CapturedImage,
  CapturedImageMediaType,
} from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { CaptureError, acquireDebuggerSession, cdpFailure, visionAvailable, type DebuggerLease } from './debugger-session.ts'

export { CaptureError, visionAvailable }

/** Default JPEG quality when the caller does not name one. */
const DEFAULT_JPEG_QUALITY = 80
/** Downscale attempts before the byte-limit ladder gives up. */
const MAX_SCALE_ATTEMPTS = 3
/** Scale multiplier per byte-limit attempt. */
const SCALE_STEP = 0.7
/** JPEG quality ladder applied when the encoded bytes still exceed the limit. */
const JPEG_LADDER = [80, 60, 40] as const
/** Fallbacks used when the host sends no storage limits. */
const FALLBACK_LIMITS: CaptureLimits = { maxBytes: 4_000_000, maxPixels: 4_000_000, maxDimension: 4096 }

interface LayoutMetrics {
  width: number
  height: number
}

/** Read the capture region in CSS pixels: the whole scrollable page, or the viewport. */
async function readRegion(lease: DebuggerLease, fullPage: boolean): Promise<LayoutMetrics> {
  const raw = await lease.sendCommand('Page.getLayoutMetrics') as {
    cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
    layoutViewport?: { clientWidth?: number; clientHeight?: number }
    contentSize?: { width?: number; height?: number }
  }
  const viewport = raw.cssVisualViewport ?? raw.layoutViewport
  const width = fullPage ? raw.contentSize?.width : viewport?.clientWidth
  const height = fullPage ? raw.contentSize?.height : viewport?.clientHeight
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
    throw new CaptureError('action-failed', 'The page did not report a capturable size.')
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
}

/** Largest scale that keeps the encoded raster inside the pixel and dimension limits. */
function scaleForLimits(width: number, height: number, limits: CaptureLimits): number {
  const pixelScale = Math.sqrt(limits.maxPixels / (width * height))
  const dimensionScale = limits.maxDimension / Math.max(width, height)
  return Math.min(1, pixelScale, dimensionScale)
}

function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding)
}

function assertLive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new CaptureError('action-failed', 'The screenshot was cancelled.')
}

/**
 * Capture one tab's page as an in-memory raster.
 *
 * @param tabId - the controlled tab.
 * @param request - model-facing capture options plus the host's storage limits.
 * @param signal - bridge lifetime; an aborted signal stops before the next CDP step.
 * @returns the encoded image and its intrinsic metadata.
 * @throws CaptureError with an actionable message for every platform refusal.
 */
export async function captureTab(
  tabId: number,
  request: CaptureRequest,
  signal?: AbortSignal,
): Promise<CapturedImage> {
  if (!visionAvailable()) {
    throw new CaptureError('unsupported', 'This browser build cannot capture screenshots: the extension has no chrome.debugger API (Firefox). Use browser_snapshot for page text instead.')
  }
  const limits = request.limits ?? FALLBACK_LIMITS
  const fullPage = request.fullPage === true
  assertLive(signal)
  // One shared session per tab: reuse the console/network hold instead of
  // attaching a second time (Chrome refuses that, and the refusal used to read
  // as if DevTools were open).
  const lease = await acquireDebuggerSession(tabId)
  try {
    const region = await readRegion(lease, fullPage)
    let scale = scaleForLimits(region.width, region.height, limits)
    const requestedFormat: CapturedImageMediaType = request.format === 'jpeg' ? 'image/jpeg' : 'image/png'
    const requestedQuality = request.quality ?? DEFAULT_JPEG_QUALITY
    let mediaType = requestedFormat
    let quality = requestedQuality
    let dataBase64 = ''
    let bytes = 0
    // Byte-limit ladder: shrink the raster first, then trade PNG for JPEG.
    for (let attempt = 0; attempt <= MAX_SCALE_ATTEMPTS + JPEG_LADDER.length; attempt += 1) {
      assertLive(signal)
      const shot = await lease.sendCommand('Page.captureScreenshot', {
        format: mediaType === 'image/jpeg' ? 'jpeg' : 'png',
        ...mediaType === 'image/jpeg' ? { quality } : {},
        clip: { x: 0, y: 0, width: region.width, height: region.height, scale },
        captureBeyondViewport: fullPage,
      }) as { data?: string }
      if (typeof shot.data !== 'string' || shot.data === '') {
        throw new CaptureError('action-failed', 'Chrome returned an empty screenshot.')
      }
      dataBase64 = shot.data
      bytes = decodedBytes(shot.data)
      if (bytes <= limits.maxBytes) break
      if (attempt < MAX_SCALE_ATTEMPTS - 1) {
        scale *= SCALE_STEP
        continue
      }
      if (mediaType === 'image/png') {
        mediaType = 'image/jpeg'
        quality = JPEG_LADDER[0]
        continue
      }
      const nextQuality = JPEG_LADDER.find((candidate) => candidate < quality)
      if (nextQuality === undefined) break
      quality = nextQuality
    }
    if (bytes > limits.maxBytes) {
      throw new CaptureError('action-failed', `The screenshot could not be encoded within ${limits.maxBytes} bytes; capture the viewport instead of the whole page (fullPage: false).`)
    }
    return {
      dataBase64,
      mediaType,
      width: Math.max(1, Math.round(region.width * scale)),
      height: Math.max(1, Math.round(region.height * scale)),
      bytes,
    }
  } catch (error: unknown) {
    if (error instanceof CaptureError) throw error
    throw cdpFailure(error)
  } finally {
    await lease.release()
  }
}
