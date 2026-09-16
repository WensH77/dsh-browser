// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

const budget = { maxItems: 20, maxForms: 10, maxChars: 8_000 }
const context = (): { ids: ElementIds; budget: typeof budget } => ({ ids: new ElementIds(), budget })

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('browser_image', () => {
  it('reports where an <img> keeps its bytes', async () => {
    document.body.innerHTML = '<main><img src="/charts/ranking.png" alt="member ranking"></main>'

    const answer = await runAction('browser_image', { selector: 'img' }, context())

    expect(answer.imageSource).toMatchObject({
      kind: 'img',
      url: 'http://localhost:3000/charts/ranking.png',
      alt: 'member ranking',
    })
    // The location travels structurally; the model's text carries no URL/bytes.
    expect(answer.text).toBe('image source: img')
  })

  it('keeps an inline data URL as the source', async () => {
    document.body.innerHTML = '<img alt="chart" src="data:image/png;base64,AAAA">'

    const answer = await runAction('browser_image', { selector: 'img' }, context())

    expect(answer.imageSource).toMatchObject({ kind: 'img', url: 'data:image/png;base64,AAAA', alt: 'chart' })
  })

  it('rasterizes a canvas the page painted itself', async () => {
    document.body.innerHTML = '<canvas width="300" height="150"></canvas>'
    const canvas = document.querySelector('canvas')!
    vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/png;base64,BBBB')

    const answer = await runAction('browser_image', { selector: 'canvas' }, context())

    expect(answer.imageSource).toMatchObject({ kind: 'canvas', dataUrl: 'data:image/png;base64,BBBB', width: 300, height: 150 })
  })

  it('names a canvas that cannot be exported instead of returning a blank picture', async () => {
    document.body.innerHTML = '<canvas width="10" height="10"></canvas>'
    vi.spyOn(document.querySelector('canvas')!, 'toDataURL').mockImplementation(() => {
      throw new Error('SecurityError: tainted canvas')
    })

    await expect(runAction('browser_image', { selector: 'canvas' }, context()))
      .rejects.toThrow(/tainted by cross-origin content/)
  })

  it('finds a CSS background picture', async () => {
    document.body.innerHTML = '<div class="hero"></div>'
    vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue({
      backgroundImage: 'url("/img/hero@2x.png")',
    } as unknown as CSSStyleDeclaration)

    const answer = await runAction('browser_image', { selector: 'div.hero' }, context())

    expect(answer.imageSource).toMatchObject({ kind: 'background', url: 'http://localhost:3000/img/hero@2x.png' })
  })

  it('explains that a non-picture target cannot be returned as an image', async () => {
    document.body.innerHTML = '<main><p id="note">text only</p></main>'

    await expect(runAction('browser_image', { selector: '#note' }, context()))
      .rejects.toThrow(/is not a picture/)
    await expect(runAction('browser_image', { selector: 'p' }, context()))
      .rejects.toThrow(/browser_capture for a screenshot/)
  })
})
