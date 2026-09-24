// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import type { ElementIds } from '../src/content/ids.ts'

const budget = { maxItems: 20, maxForms: 10, maxChars: 8_000 }
const context = (el: Element): { ids: ElementIds; budget: typeof budget } =>
  ({ ids: { elementByIndex: vi.fn(() => el) } as unknown as ElementIds, budget })

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

/**
 * `browser_click_pointer` exists for pages that bind controls to the *press*
 * sequence rather than to `click` — measured against Google Slides, where a
 * plain click reports success and changes nothing. These assertions pin the two
 * properties that make it work there: the mouse pair is present, and every event
 * carries a point inside the element's own rect (without one the hit test fails).
 */
describe('browser_click_pointer', () => {
  it('sends the full press sequence, not a lone click', async () => {
    const button = document.createElement('button')
    button.textContent = 'slide 10'
    button.scrollIntoView = vi.fn()
    const seen: string[] = []
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      button.addEventListener(type, () => seen.push(type))
    }
    vi.spyOn(button, 'click')

    const answer = await runAction('browser_click_pointer', { index: 1 }, context(button))

    expect(answer.text).toContain('Clicked')
    expect(seen).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    // `el.click()` was the plain path and is deliberately not used here.
    expect(button.click).not.toHaveBeenCalled()
  })

  it('puts every event inside the element, which is what the hit test needs', async () => {
    const button = document.createElement('button')
    button.scrollIntoView = vi.fn()
    Object.defineProperty(button, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 40, top: 60, width: 100, height: 20 }),
    })
    const points: Array<{ type: string; x: number; y: number }> = []
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      button.addEventListener(type, (event) => {
        const e = event as MouseEvent
        points.push({ type, x: e.clientX, y: e.clientY })
      })
    }

    await runAction('browser_click_pointer', { index: 1 }, context(button))

    expect(points.map((point) => point.type))
      .toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    for (const point of points) {
      // The centre of the rect above: a point outside it fails the hit test and
      // the page ignores the press even though the events were dispatched.
      expect([point.x, point.y], point.type).toEqual([90, 70])
    }
  })

  it('re-aims at the element when the page is still moving it', async () => {
    // The click scrolls the target into view first, and in a virtualized list
    // (the Slides filmstrip and grid view) that scroll keeps moving the element.
    // Measuring once in the same task aims the press at where it used to be.
    const button = document.createElement('button')
    button.scrollIntoView = vi.fn()
    const rects = [
      { left: 0, top: 0, width: 10, height: 10 },
      { left: 0, top: 100, width: 10, height: 10 },
      { left: 0, top: 100, width: 10, height: 10 },
    ]
    let measured = 0
    Object.defineProperty(button, 'getBoundingClientRect', {
      configurable: true,
      value: () => rects[Math.min(measured++, rects.length - 1)],
    })
    const points: Array<[number, number]> = []
    button.addEventListener('click', (event) => {
      const e = event as MouseEvent
      points.push([e.clientX, e.clientY])
    })

    await runAction('browser_click_pointer', { index: 1 }, context(button))

    expect(points).toEqual([[5, 105]])
  })

  it('still presses in a hidden tab, where no frame ever arrives', async () => {
    // A background tab gets no requestAnimationFrame callbacks at all. Waiting
    // on one alone never resolves, so the press is never dispatched and the tool
    // call dies at its own timeout — measured on a real background Slides tab.
    const button = document.createElement('button')
    button.scrollIntoView = vi.fn()
    const raf = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const seen: string[] = []
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      button.addEventListener(type, () => seen.push(type))
    }

    await runAction('browser_click_pointer', { index: 1 }, context(button))

    expect(seen).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    expect(raf).not.toHaveBeenCalled()
  })

  it('leaves browser_click alone, so the common path cannot double-fire', async () => {
    const button = document.createElement('button')
    button.scrollIntoView = vi.fn()
    const click = vi.spyOn(button, 'click')

    await runAction('browser_click', { index: 1 }, context(button))

    expect(click).toHaveBeenCalled()
  })
})
