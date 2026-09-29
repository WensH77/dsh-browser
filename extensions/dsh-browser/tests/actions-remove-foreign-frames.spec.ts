// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAction, resetDetachedFramesForTest } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 8_000 }

beforeEach(() => {
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
})

afterEach(() => {
  vi.restoreAllMocks()
  resetDetachedFramesForTest()
  document.body.replaceChildren()
})

function context(): { ids: ElementIds; budget: typeof BUDGET } {
  return { ids: new ElementIds(), budget: BUDGET }
}

describe('removing foreign frames', () => {
  it('removes another extension\'s frame and keeps the page\'s own frames', async () => {
    // Chrome refuses a debugger for the whole tab when its frame tree carries
    // another extension's page, so this is what makes the retry attach work.
    document.body.innerHTML = `
      <iframe id="own" src="https://app.example/embedded"></iframe>
      <iframe id="blank"></iframe>
      <iframe id="foreign" src="chrome-extension://abcdefghijklmnop/inject.html?page-text=private"></iframe>`

    const result = await runAction('browser_remove_foreign_frames', {}, context()) as {
      text: string
      foreignOrigins?: string[]
    }

    expect(document.querySelector('#foreign')).toBeNull()
    expect(document.querySelector('#own')).not.toBeNull()
    expect(document.querySelector('#blank')).not.toBeNull()
    expect(result.foreignOrigins).toEqual(['chrome-extension://abcdefghijklmnop'])
    expect(result.text).toContain('Took out 1 frame')
  })

  it('puts what it took out back exactly where it was', async () => {
    // The removal only has to last one attach: the other extension's UI is
    // missing for milliseconds, not until the next reload.
    document.body.innerHTML = `
      <div id="host"><span id="before"></span><iframe id="foreign" src="chrome-extension://abc/x.html"></iframe><span id="after"></span></div>`

    await runAction('browser_remove_foreign_frames', {}, context())
    expect(document.querySelector('#foreign')).toBeNull()

    const restored = await runAction('browser_restore_foreign_frames', {}, context()) as { text: string }

    const frame = document.querySelector('#foreign')
    expect(frame).not.toBeNull()
    expect(frame?.previousElementSibling?.id).toBe('before')
    expect(frame?.nextElementSibling?.id).toBe('after')
    expect(restored.text).toContain('Put back 1 frame')
  })

  it('still puts frames back after the content script is re-injected', async () => {
    // The background injects content.js into tabs it has no listener in, and
    // every injection replaces the previous listener — so the list of taken-out
    // elements has to live where both instances can reach it. Measured failure:
    // the frame stayed out because the instance that detached it was gone.
    document.body.innerHTML = '<iframe id="foreign" src="chrome-extension://abc/x.html"></iframe>'
    await runAction('browser_remove_foreign_frames', {}, context())

    vi.resetModules()
    const fresh = await import('../src/content/actions.ts')
    await fresh.runAction('browser_restore_foreign_frames', {}, context())

    expect(document.querySelector('#foreign')).not.toBeNull()
  })

  it('leaves a frame the other extension re-created in the meantime alone', async () => {
    // Inserting the old element as well would duplicate that extension's UI.
    document.body.innerHTML = '<iframe id="foreign" src="chrome-extension://abc/x.html"></iframe>'
    await runAction('browser_remove_foreign_frames', {}, context())
    const replacement = document.createElement('iframe')
    replacement.id = 'foreign'
    replacement.src = 'chrome-extension://abc/x.html'
    document.body.appendChild(replacement)

    await runAction('browser_restore_foreign_frames', {}, context())

    expect(document.querySelectorAll('iframe')).toHaveLength(1)
  })

  it('reports nothing removed for a page that carries only its own frames', async () => {
    document.body.innerHTML = `
      <iframe src="https://app.example/embedded"></iframe>
      <iframe></iframe>`

    const result = await runAction('browser_remove_foreign_frames', {}, context()) as {
      text: string
      foreignOrigins?: string[]
    }

    expect(result.foreignOrigins).toBeUndefined()
    expect(result.text).toContain('No frame belonging to another extension')
    expect(document.querySelectorAll('iframe')).toHaveLength(2)
  })

  it('never touches a frame the page itself embeds over http', async () => {
    // A cross-origin http iframe is ordinary: only the schemes Chrome refuses
    // a debugger on are removed.
    document.body.innerHTML = '<iframe src="http://other.example/widget"></iframe>'

    const result = await runAction('browser_remove_foreign_frames', {}, context()) as { foreignOrigins?: string[] }

    expect(result.foreignOrigins).toBeUndefined()
    expect(document.querySelector('iframe')).not.toBeNull()
  })

  it('removes a PDF plugin embed, which renders through Chrome\'s viewer extension', async () => {
    // The element names the document, not the viewer: leaving it in place would
    // keep the tab undebuggable while looking like nothing foreign is here.
    document.body.innerHTML = `
      <embed id="report" type="application/pdf" src="/reports/q3.pdf">
      <object id="image" type="image/svg+xml" data="/logo.svg"></object>`

    const result = await runAction('browser_remove_foreign_frames', {}, context()) as { foreignOrigins?: string[] }

    expect(document.querySelector('#report')).toBeNull()
    expect(document.querySelector('#image')).not.toBeNull()
    expect(result.foreignOrigins).toEqual(['pdf-embed:http://localhost:3000'])
  })

  it('takes out a PDF that does not declare its type either', async () => {
    // Chrome picks its viewer for a `.pdf` source with no `type` attribute, so
    // the frame is there while the element says nothing about it.
    document.body.innerHTML = '<embed id="report" src="/reports/q3.pdf">'

    const result = await runAction('browser_remove_foreign_frames', {}, context()) as { foreignOrigins?: string[] }

    expect(document.querySelector('#report')).toBeNull()
    expect(result.foreignOrigins).toEqual(['pdf-embed:http://localhost:3000'])
  })
})
