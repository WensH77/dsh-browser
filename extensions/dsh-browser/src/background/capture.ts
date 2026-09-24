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

import { base64ToBytes } from '../shared/base64.ts'
import type {
  CaptureLimits,
  CaptureRequest,
  CapturedImage,
  CapturedImageMediaType,
} from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { CaptureError, acquireDebuggerSession, cdpFailure, visionAvailable, type DebuggerLease } from './debugger-session.ts'
import {
  RasterError,
  decodeRaster,
  exceedsLimits,
  fitRasterWithinLimits,
  fittedSize,
  readEncodedSize,
  type RasterWording,
} from './bitmap.ts'

export { CaptureError, visionAvailable }

/** Default JPEG quality when the caller does not name one. */
const DEFAULT_JPEG_QUALITY = 80
/**
 * Smallest delivered-pixels-per-CSS-pixel a full-page capture may have and still
 * be worth sending. Below this the text is not readable and the viewport is a
 * better answer; the number comes from measured captures (0.63x is borderline on
 * a 3425 CSS-px-tall article, 0.48x on an 8192 CSS-px-tall one is not readable).
 */
const LEGIBLE_MIN_SCALE = 0.63
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

function assertLive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new CaptureError('action-failed', 'The screenshot was cancelled.')
}

/**
 * Capture one tab's page as an in-memory raster.
 *
 * The capture is always taken at native scale (`clip.scale: 1`) and fitted here,
 * because asking CDP itself to scale a full-page clip is not reliable: with
 * `captureBeyondViewport` the returned raster is the page at page size, so the
 * metadata this function used to compute (`region * scale`) described an image
 * that was never produced. A caller could then see "8.7 MP" beside a store
 * refusal for exceeding a 64 MP limit. Everything below reports measured
 * dimensions, taken from the decoded bitmap.
 *
 * @param tabId - the controlled tab.
 * @param request - model-facing capture options plus the host's storage limits.
 * @param signal - bridge lifetime; an aborted signal stops before the next CDP step.
 * @returns the encoded image and its measured metadata.
 * @throws CaptureError with an actionable message for every platform refusal.
 */
export async function captureTab(
  tabId: number,
  request: CaptureRequest,
  signal?: AbortSignal,
): Promise<CapturedImage> {
  if (!visionAvailable()) {
    throw new CaptureError('unsupported', 'This extension cannot capture screenshots because the chrome.debugger API is unavailable. Reload the extension from chrome://extensions; if missing capabilities persist, use browser_snapshot for page text instead.')
  }
  const limits = request.limits ?? FALLBACK_LIMITS
  const fullPage = request.fullPage === true
  const requested: CapturedImageMediaType = request.format === 'jpeg' ? 'image/jpeg' : 'image/png'
  const quality = request.quality ?? DEFAULT_JPEG_QUALITY
  assertLive(signal)
  // One shared session per tab: reuse the console/network hold instead of
  // attaching a second time (Chrome refuses that, and the refusal used to read
  // as if DevTools were open).
  const lease = await acquireDebuggerSession(tabId)
  try {
    const region = await readRegion(lease, fullPage)
    const shot = await shoot(lease, region, fullPage, requested, quality)
    assertLive(signal)
    const encoded = readEncodedSize(shot.bytes, requested)
    // A full page that would reach the model at a fraction of its CSS size cannot
    // be read: answering with the viewport is more useful than a legible-looking
    // thumbnail of everything. The scale is only knowable from the encoded size,
    // which is why the raster is taken before the decision.
    if (fullPage && encoded !== undefined && request.deliver !== undefined) {
      const scale = deliveredScale(encoded, region, limits, request.deliver)
      if (scale < LEGIBLE_MIN_SCALE) {
        const viewport = await readRegion(lease, false)
        const viewportShot = await shoot(lease, viewport, false, requested, quality)
        const image = await encodeWithinLimits(viewportShot, requested, limits)
        return {
          ...image,
          note: `the whole page would have arrived at ${Math.round(scale * 100)}% of its CSS size, too small to read, `
            + 'so this is the viewport instead; use browser_get_text for the whole page',
        }
      }
    }
    return await encodeWithinLimits(shot, requested, limits)
  } catch (error: unknown) {
    if (error instanceof CaptureError) throw error
    throw cdpFailure(error)
  } finally {
    await lease.release()
  }
}

/** One captured raster: its bytes, and the base64 the wire carries. */
interface Capture {
  dataBase64: string
  bytes: Uint8Array
}

/** Take one screenshot at native scale; scaling is done after decoding, never here. */
async function shoot(
  lease: DebuggerLease,
  region: LayoutMetrics,
  fullPage: boolean,
  mediaType: CapturedImageMediaType,
  quality: number,
): Promise<Capture> {
  const shot = await lease.sendCommand('Page.captureScreenshot', {
    format: mediaType === 'image/jpeg' ? 'jpeg' : 'png',
    ...mediaType === 'image/jpeg' ? { quality } : {},
    clip: { x: 0, y: 0, width: region.width, height: region.height, scale: 1 },
    captureBeyondViewport: fullPage,
  }) as { data?: string }
  if (typeof shot.data !== 'string' || shot.data === '') {
    throw new CaptureError('action-failed', 'Chrome returned an empty screenshot.')
  }
  return { dataBase64: shot.data, bytes: base64ToBytes(shot.data) }
}

/**
 * Encode one capture inside the deployment's admission limits.
 *
 * The encoded size is read from the image header first, so an admissible capture
 * passes through without ever being decoded — decoding a 42 MP full-page raster
 * just to measure it is what put this path at the tool timeout. A capture that
 * does not fit is decoded straight to the size that does.
 */
async function encodeWithinLimits(
  capture: Capture,
  mediaType: CapturedImageMediaType,
  limits: CaptureLimits,
): Promise<CapturedImage> {
  const encoded = readEncodedSize(capture.bytes, mediaType)
  if (encoded !== undefined) {
    if (!exceedsLimits(encoded.width, encoded.height, capture.bytes.byteLength, limits)) {
      return {
        dataBase64: capture.dataBase64,
        mediaType,
        width: encoded.width,
        height: encoded.height,
        bytes: capture.bytes.byteLength,
      }
    }
    // Decode straight to the size that fits, then re-encode: the captured bytes
    // describe the full raster, so they cannot travel as the smaller claim.
    const target = fittedSize(encoded.width, encoded.height, limits)
    const shrunk = await asCaptureError(() => decodeRaster(capture.bytes, mediaType, SCREENSHOT_WORDING, target))
    return await asCaptureError(() => fitRasterWithinLimits(shrunk, limits, SCREENSHOT_WORDING))
  }
  const bitmap = await asCaptureError(() => decodeRaster(capture.bytes, mediaType, SCREENSHOT_WORDING))
  if (!exceedsLimits(bitmap.width, bitmap.height, capture.bytes.byteLength, limits)) {
    const image: CapturedImage = {
      dataBase64: capture.dataBase64,
      mediaType,
      width: bitmap.width,
      height: bitmap.height,
      bytes: capture.bytes.byteLength,
    }
    bitmap.close()
    return image
  }
  return await asCaptureError(() => fitRasterWithinLimits(bitmap, limits, SCREENSHOT_WORDING))
}

/**
 * Delivered pixels per CSS pixel for one full-page raster.
 *
 * Admission runs first, then the deployment's normalization — measured on real
 * captures: a 3425 CSS-px-tall article arrives at 0.63x (14 px body text becomes
 * about 9 px, borderline), a 8192 CSS-px-tall one at 0.48x (unreadable).
 */
function deliveredScale(
  encoded: { width: number; height: number },
  region: LayoutMetrics,
  limits: CaptureLimits,
  deliver: CaptureLimits,
): number {
  const admitted = fittedSize(encoded.width, encoded.height, limits)
  const delivered = fittedSize(admitted.width, admitted.height, deliver)
  return delivered.height / region.height
}

/** How this module words a raster failure, so the shared mechanics stay neutral. */
const SCREENSHOT_WORDING: RasterWording = {
  subject: 'screenshot',
  decodeHint: 'Take the screenshot again.',
  fitHint: 'Capture the viewport instead of the whole page (fullPage: false).',
}

/** Re-brand the shared raster failure as this module's stable tool error. */
async function asCaptureError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error: unknown) {
    throw error instanceof RasterError ? new CaptureError('action-failed', error.message) : error
  }
}
