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
 * @module
 */

import type { CaptureLimits, CapturedImage, CapturedImageMediaType } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { PageImageSource } from '../content/actions.ts'

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

/** JPEG quality ladder for a picture too large to pass through. */
const QUALITY_LADDER = [80, 60, 40] as const

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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk))
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
  return bytes
}

/** Guess a media type from a URL when the response carries none. */
function mediaTypeFromUrl(url: string): string {
  const path = url.split(/[?#]/)[0] ?? ''
  if (/\.png$/i.test(path)) return 'image/png'
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg'
  if (/\.webp$/i.test(path)) return 'image/webp'
  if (/\.gif$/i.test(path)) return 'image/gif'
  return ''
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

/** Decode a raster, naming the failure when the bytes are not a picture. */
async function decode(bytes: Uint8Array, mediaType: string): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(new Blob([bytes as BlobPart], { type: mediaType }))
  } catch {
    throw new PageImageError(
      'action-failed',
      `The picture (${mediaType === '' ? 'unknown type' : mediaType}) could not be decoded into a raster. Use browser_capture to screenshot the page instead.`,
    )
  }
}

/** Whether the picture must be resized before the deployment will accept it. */
function exceedsLimits(width: number, height: number, bytes: number, limits: CaptureLimits): boolean {
  return bytes > limits.maxBytes
    || width * height > limits.maxPixels
    || Math.max(width, height) > limits.maxDimension
}

/** Rasterize and shrink a picture into the deployment's admission limits. */
async function fitWithinLimits(bitmap: ImageBitmap, limits: CaptureLimits): Promise<CapturedImage> {
  const pixelScale = Math.sqrt(limits.maxPixels / (bitmap.width * bitmap.height))
  const dimensionScale = limits.maxDimension / Math.max(bitmap.width, bitmap.height)
  const scale = Math.min(1, pixelScale, dimensionScale)
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new PageImageError('action-failed', 'This browser build cannot rasterize a picture (no 2D canvas in the service worker).')
  }
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  let mediaType: CapturedImageMediaType = 'image/png'
  let blob = await canvas.convertToBlob({ type: 'image/png' })
  if (blob.size > limits.maxBytes) {
    mediaType = 'image/jpeg'
    for (const quality of QUALITY_LADDER) {
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
      if (blob.size <= limits.maxBytes) break
    }
  }
  if (blob.size > limits.maxBytes) {
    throw new PageImageError(
      'action-failed',
      `The picture could not be fitted into ${limits.maxBytes} bytes. Use browser_capture with a smaller region instead.`,
    )
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return { dataBase64: bytesToBase64(bytes), mediaType, width, height, bytes: bytes.byteLength }
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
