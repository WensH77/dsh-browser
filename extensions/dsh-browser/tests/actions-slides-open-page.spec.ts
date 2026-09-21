// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

const budget = { maxItems: 20, maxForms: 10, maxChars: 8_000 }
const context = (): { ids: ElementIds; budget: typeof budget } => ({ ids: new ElementIds(), budget })

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
  window.location.hash = ''
})

const slideId = (page: number): string => `g1a2b3c4d5e6_0_${page}`

/**
 * A deck of `pages` slides with the two Slides surfaces this action uses: the
 * grid-view toggle (`aria-pressed`) and one rendered slide group per page,
 * `filmstrip-slide-<0-based index>-<slideId>`. `press` decides what a press on a
 * thumbnail does — the real editor selects it and only moves the deck when the
 * grid closes again.
 */
function slidesFixture(options: {
  pages: number
  current: number
  press?: 'open' | 'neighbour' | 'ignore'
}): void {
  const { pages, current, press = 'open' } = options
  window.location.hash = `#slide=id.${slideId(current)}`

  const toggle = document.createElement('div')
  toggle.id = 'grid-view-toggle'
  toggle.setAttribute('aria-pressed', 'false')
  let selected: string | null = null
  toggle.addEventListener('mouseup', () => {
    const open = toggle.getAttribute('aria-pressed') === 'true'
    if (open) {
      toggle.setAttribute('aria-pressed', 'false')
      if (selected !== null) window.location.hash = `#slide=id.${selected}`
      return
    }
    toggle.setAttribute('aria-pressed', 'true')
  })
  document.body.append(toggle)

  for (let page = 1; page <= pages; page++) {
    const thumbnail = document.createElement('div')
    thumbnail.className = 'punch-filmstrip-thumbnail'
    thumbnail.scrollIntoView = vi.fn()
    const group = document.createElement('div')
    group.id = `filmstrip-slide-${page - 1}-${slideId(page)}`
    thumbnail.append(group)
    thumbnail.addEventListener('mouseup', () => {
      if (press === 'open') selected = slideId(page)
      // The filmstrip's coordinate-resolved press lands on the neighbour.
      else if (press === 'neighbour') selected = slideId(Math.min(page + 1, pages))
    })
    document.body.append(thumbnail)
  }
}

describe('browser_slides_open_page', () => {
  it('opens the wanted page through the grid view', async () => {
    slidesFixture({ pages: 32, current: 1 })

    const answer = await runAction('browser_slides_open_page', { page: 30 }, context())

    expect(answer.text).toContain('Opened slide 30 from grid view')
    expect(window.location.hash).toBe(`#slide=id.${slideId(30)}`)
    expect(document.querySelector('#grid-view-toggle')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('does nothing when the deck is already on the page', async () => {
    slidesFixture({ pages: 32, current: 7 })

    const answer = await runAction('browser_slides_open_page', { page: 7 }, context())

    expect(answer.text).toBe('Already on slide 7.')
    expect(document.querySelector('#grid-view-toggle')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('falls back to loading the slide by hash when a press changes nothing', async () => {
    slidesFixture({ pages: 32, current: 1, press: 'ignore' })

    const answer = await runAction('browser_slides_open_page', { page: 30 }, context())

    expect(answer.text).toContain('loaded by hash')
    expect(answer.text).toContain('the deck is on slide 30')
    expect(window.location.hash).toBe(`#slide=id.${slideId(30)}`)
  })

  it('reports a deck that moved to the wrong page instead of calling it a failure', async () => {
    slidesFixture({ pages: 32, current: 1, press: 'neighbour' })

    const answer = await runAction('browser_slides_open_page', { page: 30 }, context())

    expect(answer.text).toContain('not 30')
    expect(answer.text).toContain(slideId(30))
    expect(window.location.hash).not.toBe(`#slide=id.${slideId(30)}`)
  })

  it('fails loudly when the page is not a Slides editor', async () => {
    await expect(runAction('browser_slides_open_page', { page: 2 }, context()))
      .rejects.toThrow(/Google Slides editor/)
  })

  it('rejects a page number that is not a positive whole number', async () => {
    slidesFixture({ pages: 4, current: 1 })

    await expect(runAction('browser_slides_open_page', { page: 0 }, context()))
      .rejects.toThrow(/positive whole number/)
  })

  it('fails when the page never enters the rendered window', async () => {
    slidesFixture({ pages: 10, current: 1 })

    await expect(runAction('browser_slides_open_page', { page: 30 }, context()))
      .rejects.toThrow(/Could not reach slide 30/)
  })
})
