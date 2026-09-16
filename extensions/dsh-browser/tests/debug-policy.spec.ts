// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { DEBUG_TOOL_NAMES, debugToolRefusal } from '../src/background/debug-policy.ts'

describe('debugToolRefusal', () => {
  it('refuses every debugging tool while the setting is off', () => {
    for (const name of DEBUG_TOOL_NAMES) {
      const refusal = debugToolRefusal(name, false)
      expect(refusal).toMatchObject({ ok: false, error: { code: 'unsupported' } })
      expect(refusal?.error?.message).toContain('Allow browser debugging')
    }
  })

  it('lets them through once the user allows debugging', () => {
    for (const name of DEBUG_TOOL_NAMES) {
      expect(debugToolRefusal(name, true)).toBeUndefined()
    }
  })

  it('never touches tools that do not need the debugger', () => {
    for (const name of ['browser_snapshot', 'browser_click', 'browser_block', 'browser_headers']) {
      expect(debugToolRefusal(name, false)).toBeUndefined()
    }
  })
})
