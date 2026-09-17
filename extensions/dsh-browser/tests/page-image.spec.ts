// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageImageError, fetchPageImage, pageImageEnvelope, parsePageImageSource } from '../src/background/page-image.ts'

const LIMITS = { maxBytes: 20 * 1024 * 1024, maxPixels: 64_000_000, maxDimension: 8_192 }
const PNG_BASE64 = Buffer.from('original-png-bytes').toString('base64')
const DATA_URL = `data:image/png;base64,${PNG_BASE64}`

/** Stub the raster APIs a service worker has but jsdom does not. */
/** jsdom's Blob has no arrayBuffer, so stand in with the worker-visible surface. */
function fakeBlob(appends: Buffer, type: string): Blob {
  return { size: appends.length, type, arrayBuffer: async () => appends } as unknown as Blob
}

function stubRaster(width: number, height: number): { drawImage: ReturnType<typeof vi.fn>; convertToBlob: ReturnType<typeof vi.fn> } {
  const drawImage = vi.fn()
  const convertToBlob = vi.fn(async (options: { type?: string } = {}) => fakeBlob(Buffer.from('fitted'), options.type ?? 'image/png'))
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width, height, close: vi.fn() })))
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(readonly width: number, readonly height: number) {}
    getContext(): unknown { return { drawImage } }
    convertToBlob(options?: { type?: string }): Promise<Blob> { return convertToBlob(options) }
  })
  return { drawImage, convertToBlob }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('parsePageImageSource', () => {
  it('accepts the two shapes the content script reports', () => {
    expect(parsePageImageSource({ kind: 'img', url: 'https://app.example/a.png' })).toMatchObject({ kind: 'img' })
    expect(parsePageImageSource({ kind: 'canvas', dataUrl: DATA_URL })).toMatchObject({ kind: 'canvas' })
  })

  it('refuses a missing, unknown, or source-less report', () => {
    expect(parsePageImageSource(undefined)).toBeUndefined()
    expect(parsePageImageSource({ kind: 'video', url: 'https://x/' })).toBeUndefined()
    expect(parsePageImageSource({ kind: 'img' })).toBeUndefined()
  })
})

describe('fetchPageImage', () => {
  it('passes the original bytes through when they already fit', async () => {
    stubRaster(1338, 1722)

    const image = await fetchPageImage({ kind: 'img', url: DATA_URL }, LIMITS)

    expect(image.mediaType).toBe('image/png')
    expect(image.width).toBe(1338)
    expect(image.height).toBe(1722)
    expect(Buffer.from(image.dataBase64, 'base64').toString()).toBe('original-png-bytes')
  })

  it('fetches an http picture with the extension\'s credentials', async () => {
    stubRaster(800, 600)
    const arrayBuffer = vi.fn(async () => Buffer.from('remote-bytes'))
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => ({ type: 'image/webp', arrayBuffer }) }))
    vi.stubGlobal('fetch', fetchMock)

    const image = await fetchPageImage({ kind: 'img', url: 'https://app.example/chart.webp' }, LIMITS)

    expect(fetchMock).toHaveBeenCalledWith('https://app.example/chart.webp', { credentials: 'include' })
    expect(image.mediaType).toBe('image/webp')
    expect(Buffer.from(image.dataBase64, 'base64').toString()).toBe('remote-bytes')
  })

  it('names an HTTP failure and points at the screenshot fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, blob: async () => new Blob([]) })))

    await expect(fetchPageImage({ kind: 'img', url: 'https://app.example/secret.png' }, LIMITS))
      .rejects.toMatchObject({ code: 'action-failed', message: expect.stringContaining('HTTP 403') })
    await expect(fetchPageImage({ kind: 'img', url: 'https://app.example/secret.png' }, LIMITS))
      .rejects.toMatchObject({ message: expect.stringContaining('browser_capture') })
  })

  it('refuses a source scheme the extension cannot read', async () => {
    await expect(fetchPageImage({ kind: 'img', url: 'blob:https://app.example/1234' }, LIMITS))
      .rejects.toBeInstanceOf(PageImageError)
    await expect(fetchPageImage({ kind: 'img', url: 'blob:https://app.example/1234' }, LIMITS))
      .rejects.toMatchObject({ message: expect.stringContaining('blob:') })
  })

  it('fits a picture that exceeds the admission limits', async () => {
    const raster = stubRaster(6000, 4000)

    const image = await fetchPageImage({ kind: 'img', url: DATA_URL }, { maxBytes: 20 * 1024 * 1024, maxPixels: 4_194_304, maxDimension: 8_192 })

    expect(raster.drawImage).toHaveBeenCalled()
    // 24 MP scaled to the 4.19 MP cap keeps the aspect ratio.
    expect(image.width).toBe(2508)
    expect(image.height).toBe(1672)
    expect(image.mediaType).toBe('image/png')
  })

  it('trades png for jpeg when the fitted picture stays too large', async () => {
    const raster = stubRaster(6000, 4000)
    raster.convertToBlob.mockImplementation(async (options: { type?: string } = {}) =>
      fakeBlob(Buffer.alloc(options.type === 'image/jpeg' ? 100 : 5000), options.type ?? 'image/png'))

    const image = await fetchPageImage({ kind: 'img', url: DATA_URL }, { maxBytes: 1_000, maxPixels: 4_194_304, maxDimension: 8_192 })

    expect(image.mediaType).toBe('image/jpeg')
    expect(image.bytes).toBeLessThanOrEqual(1_000)
  })

  it('names an undecodable picture', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('not an image') }))

    await expect(fetchPageImage({ kind: 'img', url: DATA_URL }, LIMITS))
      .rejects.toMatchObject({ message: expect.stringContaining('could not be decoded') })
  })
})

describe('fetchPageImage host bounds', () => {
  // The page chooses the URL, so a private/loopback target would turn the
  // extension (outside the page's origin, CORS-exempt, cookies included) into
  // an internal-network reader for whatever the page points at.
  const restricted = [
    'http://127.0.0.1:8080/admin',
    'http://localhost:3000/secret.png',
    'http://192.168.1.1/admin.png',
    'http://10.0.0.5/internal.png',
    'http://172.16.4.4/x.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/x.png',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://printer.local/x.png',
    'http://router.internal/x.png',
    'http://0.0.0.0/x.png',
    'http://100.64.0.1/x.png',
    'http://240.0.0.1/x.png',
  ]

  it('refuses a picture served from a non-public address, before any fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    for (const url of restricted) {
      await expect(fetchPageImage({ kind: 'img', url }, LIMITS))
        .rejects.toMatchObject({ code: 'action-failed', message: expect.stringContaining('non-public address') })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still fetches an ordinary public picture, including cross-origin', async () => {
    stubRaster(800, 600)
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => ({ type: 'image/png', arrayBuffer: async () => Buffer.from('remote') }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchPageImage({ kind: 'img', url: 'https://cdn.other.example/a.png' }, LIMITS)

    expect(fetchMock).toHaveBeenCalledWith('https://cdn.other.example/a.png', { credentials: 'include' })
  })
})

describe('pageImageEnvelope', () => {
  it('reports kind, size, alt and a downscale', () => {
    const text = pageImageEnvelope(
      { dataBase64: 'x', mediaType: 'image/png', width: 640, height: 480, bytes: 12 },
      { kind: 'img', url: 'https://app.example/a.png', width: 1280, height: 960, alt: 'member ranking' },
    )

    expect(text).toContain('kind: img')
    expect(text).toContain('image/png 640x480 px, 12 bytes')
    expect(text).toContain('alt: member ranking')
    expect(text).toContain('original: 1280x960 px')
  })

  it('stays quiet about an original that was not resized', () => {
    const text = pageImageEnvelope(
      { dataBase64: 'x', mediaType: 'image/png', width: 800, height: 600, bytes: 12 },
      { kind: 'canvas', dataUrl: 'data:image/png;base64,x', width: 800, height: 600 },
    )

    expect(text).not.toContain('original:')
  })
})
