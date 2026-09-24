// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { shorten } from '../src/shared/text.ts'

describe('shorten', () => {
  it('collapses whitespace and trims', () => {
    expect(shorten('  a\n\n b\tc  ', 40)).toBe('a b c')
  })

  it('returns short text unchanged', () => {
    expect(shorten('short', 40)).toBe('short')
    expect(shorten('exactly-ten', 11)).toBe('exactly-ten')
  })

  it('keeps the ellipsis inside the budget', () => {
    // The two copies this replaced appended the ellipsis to a full-length slice
    // and returned one character more than asked for.
    for (const max of [1, 2, 5, 10]) {
      expect([...shorten('x'.repeat(50), max)].length, `max ${max}`).toBe(max)
    }
    expect(shorten('x'.repeat(50), 5)).toBe('xxxx…')
  })

  it('counts by code point, so CJK shortens by visible character', () => {
    const text = '中文标题很长很长很长很长很长'
    expect([...shorten(text, 6)].length).toBe(6)
    expect(shorten(text, 6)).toBe('中文标题很…')
  })

  it('handles a zero budget without throwing', () => {
    expect(shorten('anything', 0)).toBe('…')
  })
})
