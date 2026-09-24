/**
 * Shared raster plumbing for the two vision sources: `browser_capture` (a
 * screenshot) and `browser_image` (a picture the page embeds).
 *
 * Both must hand the deployment an image inside its admission limits, and both
 * must describe what they actually produced. The second part is not cosmetic:
 * the screenshot path used to *compute* the size it asked CDP for and report
 * that, while Chrome returns the page at native size — so the metadata claimed
 * 8.7 MP while the bytes were tens of MP, and the attachment store refused them
 * with a limit error nobody could explain from the reported numbers. Everything
 * here reports measured dimensions.
 *
 * @module
 */

import type { CaptureLimits, CapturedImage, CapturedImageMediaType } from 'dsh-bridge-browser/src/protocol.ts'
import { bytesToBase64 } from '../shared/base64.ts'

/** JPEG quality ladder applied when a raster still exceeds the byte limit. */
export const QUALITY_LADDER = [80, 60, 40] as const

/** Wording one caller uses for its own kind of raster. */
export interface RasterWording {
  /** What the raster is, for messages: `picture`, `screenshot`. */
  subject: string
  /** Sentence appended when the bytes are not decodable. */
  decodeHint: string
  /** Sentence appended when the raster cannot be fitted into the byte limit. */
  fitHint: string
}

/** A raster that could not be decoded or fitted; callers re-brand it. */
export class RasterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RasterError'
  }
}

/** Whether the raster must be resized before the deployment will accept it. */
export function exceedsLimits(width: number, height: number, bytes: number, limits: CaptureLimits): boolean {
  return bytes > limits.maxBytes
    || width * height > limits.maxPixels
    || Math.max(width, height) > limits.maxDimension
}

/** The largest raster that fits the limits while keeping the source's aspect ratio. */
export function fittedSize(width: number, height: number, limits: CaptureLimits): { width: number; height: number } {
  const scale = Math.min(
    1,
    Math.sqrt(limits.maxPixels / (width * height)),
    limits.maxDimension / Math.max(width, height),
  )
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

function readUint32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) * 0x1000000)
    + (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0))
}

/** PNG stores its dimensions in the IHDR chunk right after the signature. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (signature.some((byte, at) => bytes[at] !== byte)) return undefined
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return undefined
  return { width: readUint32(bytes, 16), height: readUint32(bytes, 20) }
}

/** JPEG stores its dimensions in the first start-of-frame segment. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1
      continue
    }
    const marker = bytes[at + 1] ?? 0
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2
      continue
    }
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)
    if (length < 2) return undefined
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    if (isStartOfFrame) {
      return {
        height: ((bytes[at + 5] ?? 0) << 8) | (bytes[at + 6] ?? 0),
        width: ((bytes[at + 7] ?? 0) << 8) | (bytes[at + 8] ?? 0),
      }
    }
    at += 2 + length
  }
  return undefined
}

/**
 * Read a raster's dimensions from its own header, without decoding pixels.
 *
 * This is what keeps a very long page bounded: the header says how big a capture
 * is, so the caller can decide whether it fits — and how far to shrink it —
 * before any bitmap exists. Decoding first would materialize the whole page
 * raster just to measure it (~290 MB for a 72 MP capture, which is how a
 * full-page capture of a long article ended up at the tool's timeout).
 *
 * @param bytes - complete encoded image bytes.
 * @param mediaType - declared media type; only PNG and JPEG are parsed.
 * @returns the encoded dimensions, or undefined when they cannot be read.
 */
export function readEncodedSize(bytes: Uint8Array, mediaType: string): { width: number; height: number } | undefined {
  if (mediaType === 'image/png') return pngSize(bytes)
  if (mediaType === 'image/jpeg') return jpegSize(bytes)
  return undefined
}

/**
 * Decode encoded raster bytes.
 *
 * The dimensions this returns are the *measured* ones — the whole point of
 * decoding here rather than trusting the size a capture was requested at. When
 * the caller already knows the encoded size (from {@link readEncodedSize}) and
 * needs a smaller raster, `resize` asks the browser to scale while decoding, so
 * the full-size bitmap never exists.
 *
 * @param bytes - complete encoded image bytes.
 * @param mediaType - declared media type, used only for the message.
 * @param wording - caller-specific message wording.
 * @param resize - optional exact dimensions to decode to.
 * @returns the decoded raster, owned by the caller (close it).
 * @throws RasterError when the bytes are not a decodable image.
 */
export async function decodeRaster(
  bytes: Uint8Array,
  mediaType: string,
  wording: RasterWording,
  resize?: { width: number; height: number },
): Promise<ImageBitmap> {
  try {
    const blob = new Blob([bytes as BlobPart], { type: mediaType })
    return await (resize === undefined
      ? createImageBitmap(blob)
      : createImageBitmap(blob, { resizeWidth: resize.width, resizeHeight: resize.height, resizeQuality: 'high' }))
  } catch {
    const type = mediaType === '' ? 'unknown type' : mediaType
    throw new RasterError(`The ${wording.subject} (${type}) could not be decoded into a raster. ${wording.decodeHint}`)
  }
}

/**
 * Shrink and re-encode one decoded raster into the deployment's admission
 * limits, reporting the dimensions it actually produced.
 *
 * @param bitmap - a decoded raster; closed by this call.
 * @param limits - the deployment's admission limits (host-supplied).
 * @param wording - caller-specific message wording.
 * @returns the encoded image and its measured metadata.
 * @throws RasterError when no canvas is available or the byte limit cannot be met.
 */
export async function fitRasterWithinLimits(
  bitmap: ImageBitmap,
  limits: CaptureLimits,
  wording: RasterWording,
): Promise<CapturedImage> {
  const pixelScale = Math.sqrt(limits.maxPixels / (bitmap.width * bitmap.height))
  const dimensionScale = limits.maxDimension / Math.max(bitmap.width, bitmap.height)
  const scale = Math.min(1, pixelScale, dimensionScale)
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (context === null) {
    bitmap.close()
    throw new RasterError(`This browser build cannot rasterize a ${wording.subject} (no 2D canvas in the service worker).`)
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
    throw new RasterError(`The ${wording.subject} could not be fitted into ${limits.maxBytes} bytes. ${wording.fitHint}`)
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return { dataBase64: bytesToBase64(bytes), mediaType, width, height, bytes: bytes.byteLength }
}
