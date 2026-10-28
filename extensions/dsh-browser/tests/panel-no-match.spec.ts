/**
 * The panel side of the "found nothing" mark.
 *
 * A read that succeeded and found nothing must be visible in the feed without
 * ever looking like a failure, and the rule that decides is a pure function so
 * it can be tested without rendering React.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/panel/App.tsx'
import { noMatchLabel } from '../src/panel/no-match-chip.ts'

describe('panel copy for the no-match chip', () => {
  it('carries every key in both languages', () => {
    // Same guard as the Update button's copy: a key present on one side only
    // renders as `undefined` in the other language.
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(zh.opNoMatch).toBeTruthy()
    expect(en.opNoMatch).toBeTruthy()
    expect(zh.opNoMatch).not.toBe(en.opNoMatch)
  })
})

describe('noMatchLabel', () => {
  it('names the chip on a successful read that found nothing', () => {
    expect(noMatchLabel({ state: 'done', noMatch: true }, en)).toBe('No match')
    expect(noMatchLabel({ state: 'done', noMatch: true }, zh)).toBe('无匹配')
  })

  it('says nothing about a read that returned content', () => {
    expect(noMatchLabel({ state: 'done' }, en)).toBeUndefined()
    expect(noMatchLabel({ state: 'done', noMatch: false }, en)).toBeUndefined()
  })

  it('never puts the chip on a failure', () => {
    // The red dot is the failure's; a chip that read as "no match" would blur the
    // two states the feed exists to separate.
    for (const state of ['error', 'cancelled', 'running', 'waiting'] as const) {
      expect(noMatchLabel({ state, noMatch: true }, en), state).toBeUndefined()
    }
  })
})

describe('no-match chip styling', () => {
  it('keeps the chip small, grey and rounded, next to the state chip', async () => {
    const raw = await readFile(resolve(import.meta.dirname, '../src/panel/styles.css'), 'utf8')
    // Comments explain the choice and would otherwise satisfy the assertions.
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    const at = css.indexOf('.ops__no-match {')
    expect(at, '.ops__no-match exists').toBeGreaterThanOrEqual(0)
    const rule = css.slice(at, css.indexOf('}', at))
    expect(rule).toContain('font-size: 10.5px')
    expect(rule).toContain('border-radius')
    expect(rule).toMatch(/color: var\(--muted\)|color: #6b7280/)

    // The chip shares the state chip's right-hand column rather than floating
    // wherever the label happens to end.
    const columnAt = css.indexOf('.ops__chips {')
    expect(columnAt, '.ops__chips exists').toBeGreaterThanOrEqual(0)
    expect(css.slice(columnAt, css.indexOf('}', columnAt))).toContain('margin-left: auto')
  })

  it('keeps the success dot colour alone', async () => {
    const css = (await readFile(resolve(import.meta.dirname, '../src/panel/styles.css'), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
    // A `done` operation stays green: the read succeeded, so the mark must not
    // have moved the operation to the error colour to be noticeable. The green
    // is the `--ok` token now, which is what lets the dot brighten in dark mode
    // instead of staying the light-mode green on a dark panel.
    expect(css).toContain('.ops__dot--done { background: var(--ok); }')
    expect(css).not.toContain('.ops__dot--no-match')
  })
})
