/**
 * Read one page picture as an in-memory raster for the vision channel.
 *
 * `browser_image` reports *where* a picture lives; this module turns that into
 * bytes. It deliberately passes the original bytes through whenever they fit
 * the deployment's admission limits, because the attachment service normalizes
 * anything larger itself — re-encoding here would only lose detail twice.
 *
 * A picture that exceeds admission is rasterized and fitted here instead, so the
 * bridge never carries more than the deployment accepts. Cross-origin pictures
 * need no CORS header: extension fetches carry the extension's host permissions
 * (and its cookies, for a picture behind the page's own session).
 *
 * Fetching is limited to the public web. A page controls the URL in its own
 * markup, so without that limit it could point an `<img>` at a loopback or
 * private-network address and have the extension — which is outside the page's
 * origin and CORS — read it back with the user's cookies. Same-origin limits
 * would break the ordinary case of a picture on a CDN or a second document
 * host, so the bound is the address range, not the page's origin.
 *
 * @module
 */

import { base64ToBytes, bytesToBase64 } from '../shared/base64.ts'
import type { CaptureLimits, CapturedImage, CapturedImageMediaType } from 'dsh-bridge-browser/src/protocol.ts'
import type { PageImageSource } from '../content/actions.ts'
import {
  RasterError,
  decodeRaster,
  exceedsLimits,
  fitRasterWithinLimits,
  type RasterWording,
} from './bitmap.ts'

/** A picture failure the background projects onto a stable tool error code. */
export class PageImageError extends Error {
  readonly code: 'unsupported' | 'action-failed'

  constructor(code: 'unsupported' | 'action-failed', message: string) {
    super(message)
    this.code = code
    this.name = 'PageImageError'
  }
}

/** Media types the attachment service accepts without re-encoding. */
const ACCEPTED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Fallback admission limits when the host sends none (it normally sends theirs). */
const FALLBACK_LIMITS: CaptureLimits = { maxBytes: 20 * 1024 * 1024, maxPixels: 64_000_000, maxDimension: 8_192 }

/** How this module words a raster failure, so the shared mechanics stay neutral. */
const PICTURE_WORDING: RasterWording = {
  subject: 'picture',
  decodeHint: 'Use browser_capture to screenshot the page instead.',
  fitHint: 'Use browser_capture with a smaller region instead.',
}

/** Validate the location a content script reported for one picture. */
export function parsePageImageSource(value: unknown): PageImageSource | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { url?: unknown; dataUrl?: unknown; kind?: unknown }
  const kind = candidate.kind
  if (kind !== 'img' && kind !== 'canvas' && kind !== 'svg-image' && kind !== 'background') return undefined
  const url = typeof candidate.url === 'string' && candidate.url !== '' ? candidate.url : undefined
  const dataUrl = typeof candidate.dataUrl === 'string' && candidate.dataUrl.startsWith('data:') ? candidate.dataUrl : undefined
  if (url === undefined && dataUrl === undefined) return undefined
  return { kind, ...url === undefined ? {} : { url }, ...dataUrl === undefined ? {} : { dataUrl } }
}

/** Guess a media type from a URL when the response carries none. */
function mediaTypeFromUrl(url: string): string {  const path = url.split(/[?#]/)[0] ?? ''
  if (/\.png$/i.test(path)) return 'image/png'
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg'
  if (/\.webp$/i.test(path)) return 'image/webp'
  if (/\.gif$/i.test(path)) return 'image/gif'
  return ''
}

/**
 * Refuse a picture URL that resolves to a loopback, private, link-local, or
 * otherwise reserved host.
 *
 * The page chooses this URL, so without the check an `<img src="http://127.0.0.1:…">`
 * or `http://192.168.x.x/…` becomes a request the extension makes with its own
 * host permissions (no CORS, cookies included), and the answer comes back to
 * the model — a blind SSRF oracle at minimum, an authenticated read at worst.
 *
 * @param raw - the absolute http(s) URL the page reported.
 * @throws PageImageError when the host is not a public address.
 */
function assertPublicImageUrl(raw: string): void {
  let host: string
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    throw new PageImageError('action-failed', 'That picture URL could not be parsed.')
  }
  if (isRestrictedHost(host)) {
    throw new PageImageError(
      'action-failed',
      `That picture is served from a non-public address (${host}), which the extension will not fetch. `
      + 'Use browser_capture to screenshot it instead.',
    )
  }
}

/** Whether a hostname names something other than the public web. */
function isRestrictedHost(host: string): boolean {
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true
  if (host === 'metadata.google.internal') return true
  if (host.includes(':')) return true                                    // IPv6: any form is out of scope here
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false                   // a name, not a literal address
  const octets = host.split('.').map(Number)
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
  const [a = 0, b = 0] = octets
  return a === 0                                                            // this-network
    || a === 10                                                             // private
    || a === 127                                                            // loopback
    || (a === 169 && b === 254)                                             // link-local, incl. cloud metadata
    || (a === 172 && b >= 16 && b <= 31)                                    // private
    || (a === 192 && b === 168)                                             // private
    || (a === 192 && b === 0)                                               // IETF protocol assignments
    || (a === 100 && b >= 64 && b <= 127)                                   // carrier-grade NAT
    || (a === 198 && (b === 18 || b === 19))                                // benchmarking
    || a >= 224                                                             // multicast and reserved
}

/** Read the bytes a source points at, without re-encoding. */
async function readSourceBytes(source: PageImageSource): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const raw = source.dataUrl ?? source.url ?? ''
  const dataMatch = /^data:([^;,]*)(;base64)?,/i.exec(raw)
  if (dataMatch !== null) {
    const comma = raw.indexOf(',')
    if (dataMatch[2] !== ';base64') {
      throw new PageImageError('action-failed', 'That picture is a non-base64 data URL, so its bytes cannot be read.')
    }
    return {
      bytes: base64ToBytes(raw.slice(comma + 1)),
      mediaType: (dataMatch[1] ?? '').trim() || 'image/png',
    }
  }
  if (/^https?:/i.test(raw)) {
    assertPublicImageUrl(raw)
    let response: Response
    try {
      // `include` keeps a picture behind the page's own login readable; reading
      // it is exactly what the user sees on screen.
      response = await fetch(raw, { credentials: 'include' })
    } catch (error: unknown) {
      throw new PageImageError('action-failed', `Fetching the picture failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) {
      throw new PageImageError('action-failed', `Fetching the picture failed with HTTP ${response.status}. Use browser_capture to screenshot it instead.`)
    }
    const blob = await response.blob()
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mediaType: blob.type === '' ? mediaTypeFromUrl(raw) : blob.type,
    }
  }
  const scheme = /^([a-z0-9+.-]+):/i.exec(raw)?.[1] ?? 'unknown'
  throw new PageImageError(
    'action-failed',
    `This picture's source scheme (${scheme}:) cannot be read by the extension. Use browser_capture to screenshot it instead.`,
  )
}

/** Decode a picture's bytes, naming the failure when they are not a picture. */
async function decode(bytes: Uint8Array, mediaType: string): Promise<ImageBitmap> {
  return await asPictureError(() => decodeRaster(bytes, mediaType, PICTURE_WORDING))
}

/** Rasterize and shrink a picture into the deployment's admission limits. */
async function fitWithinLimits(bitmap: ImageBitmap, limits: CaptureLimits): Promise<CapturedImage> {
  return await asPictureError(() => fitRasterWithinLimits(bitmap, limits, PICTURE_WORDING))
}

/** Re-brand the shared raster failure as this module's stable tool error. */
async function asPictureError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error: unknown) {
    throw error instanceof RasterError ? new PageImageError('action-failed', error.message) : error
  }
}

/**
 * Turn one reported picture location into an in-memory raster.
 *
 * @param source - what the content script reported for the picture.
 * @param limits - the deployment's admission limits (host-supplied).
 * @returns the encoded image and its intrinsic metadata.
 * @throws PageImageError with an actionable message for every refusal.
 */
export async function fetchPageImage(
  source: PageImageSource,
  limits: CaptureLimits = FALLBACK_LIMITS,
): Promise<CapturedImage> {
  const { bytes, mediaType } = await readSourceBytes(source)
  const bitmap = await decode(bytes, mediaType)
  if (ACCEPTED_MEDIA_TYPES.has(mediaType) && !exceedsLimits(bitmap.width, bitmap.height, bytes.byteLength, limits)) {
    const image: CapturedImage = {
      dataBase64: bytesToBase64(bytes),
      mediaType: mediaType as CapturedImageMediaType,
      width: bitmap.width,
      height: bitmap.height,
      bytes: bytes.byteLength,
    }
    bitmap.close()
    return image
  }
  return await fitWithinLimits(bitmap, limits)
}

/** Factual envelope that travels beside one page picture. */
export function pageImageEnvelope(image: CapturedImage, source: PageImageSource): string {
  const alt = source.alt === undefined ? '' : `\nalt: ${source.alt}`
  const scaled = source.width === undefined || source.height === undefined
    || (source.width === image.width && source.height === image.height)
    ? ''
    : `\noriginal: ${source.width}x${source.height} px`
  return `<image>\nkind: ${source.kind}\nimage: ${image.mediaType} ${image.width}x${image.height} px, ${image.bytes} bytes${alt}${scaled}\n</image>`
}
