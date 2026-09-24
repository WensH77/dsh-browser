// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 8_000 }

function rect(): DOMRect {
  return {
    top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(rect)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

/** Actions settle on real timers; pump the fake clock while they run. */
async function settle<T>(pending: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(500)
  return pending
}

describe('selector-addressed actions', () => {
  it('clicks the element a selector names, without any snapshot baseline', async () => {
    document.body.innerHTML = '<div class="row"><i class="icon-specialist-email" role="button"></i></div>'
    const icon = document.querySelector('i')!
    icon.scrollIntoView = vi.fn()
    const clicked = vi.fn()
    icon.addEventListener('click', clicked)

    const result = await settle(runAction('browser_click', { selector: 'i.icon-specialist-email' }, {
      ids: new ElementIds(),
      budget: BUDGET,
    }))

    expect(clicked).toHaveBeenCalledTimes(1)
    expect(result.text).toContain('selector "i.icon-specialist-email"')
    expect(icon.scrollIntoView).toHaveBeenCalled()
  })

  it('clicks an SVG control, which has no HTMLElement.click', async () => {
    // Slides filmstrip thumbnails are <g> elements: `(el as HTMLElement).click()`
    // used to throw a TypeError instead of activating them.
    document.body.innerHTML = '<svg><g class="thumb"><text>9</text></g><g class="thumb"><text>10</text></g></svg>'
    const tenth = document.querySelectorAll('g')[1]!
    tenth.scrollIntoView = vi.fn()
    const clicked = vi.fn()
    tenth.addEventListener('click', clicked)

    const result = await settle(runAction('browser_click', { selector: 'g.thumb:nth-of-type(2)' }, {
      ids: new ElementIds(),
      budget: BUDGET,
    }))

    expect(clicked).toHaveBeenCalledTimes(1)
    expect(result.text).toContain('g.thumb:nth-of-type(2)')
  })

  it('prefers a visible match when the selector matches several elements', async () => {
    document.body.innerHTML = '<button class="go" style="display:none">hidden</button><button class="go">visible</button>'
    const [hiddenButton, visibleButton] = [...document.querySelectorAll('button')]
    hiddenButton!.scrollIntoView = vi.fn()
    visibleButton!.scrollIntoView = vi.fn()
    const clicked = vi.fn()
    hiddenButton!.addEventListener('click', clicked)
    visibleButton!.addEventListener('click', clicked)

    await settle(runAction('browser_click', { selector: 'button.go' }, { ids: new ElementIds(), budget: BUDGET }))

    expect(clicked).toHaveBeenCalledTimes(1)
    expect(visibleButton!.scrollIntoView).toHaveBeenCalled()
    expect(hiddenButton!.scrollIntoView).not.toHaveBeenCalled()
  })

  it('refuses to click an element the user cannot see', async () => {
    document.body.innerHTML = '<button class="gone" style="display:none">gone</button>'
    document.querySelector('button')!.scrollIntoView = vi.fn()

    await expect(runAction('browser_click', { selector: 'button.gone' }, { ids: new ElementIds(), budget: BUDGET }))
      .rejects.toThrow(/not visible/)
  })

  it('names a selector that matches nothing and a malformed one', async () => {
    document.body.innerHTML = '<main>empty</main>'

    await expect(runAction('browser_click', { selector: '#nope' }, { ids: new ElementIds(), budget: BUDGET }))
      .rejects.toThrow(/No element in this frame matches selector "#nope"/)
    await expect(runAction('browser_click', { selector: ':::' }, { ids: new ElementIds(), budget: BUDGET }))
      .rejects.toThrow(/not valid CSS/)
    await expect(runAction('browser_click', {}, { ids: new ElementIds(), budget: BUDGET }))
      .rejects.toThrow(/either index .* or selector/)
  })

  it('types into the field a selector names', async () => {
    document.body.innerHTML = '<form><input name="surname" type="text" value="Schmig"></form>'
    const field = document.querySelector('input')!

    const result = await settle(runAction('browser_type', {
      selector: 'input[name=surname]',
      text: 'Test',
      replace: true,
    }, { ids: new ElementIds(), budget: BUDGET }))

    expect(field.value).toBe('Test')
    expect(result.text).toContain('selector "input[name=surname]"')
  })
})
