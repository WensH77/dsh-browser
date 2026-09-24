// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addBlockRule,
  addHeaderRule,
  clearTabRules,
  listTabRules,
  parseHeaderChanges,
} from '../src/background/net-rules.ts'

interface UpdateCall {
  removeRuleIds?: number[]
  addRules?: Array<Record<string, unknown>>
}

function mockChrome(): { updates: UpdateCall[]; store: Map<string, unknown> } {
  const updates: UpdateCall[] = []
  const store = new Map<string, unknown>()
  vi.stubGlobal('chrome', {
    declarativeNetRequest: {
      updateSessionRules: vi.fn(async (options: UpdateCall) => { updates.push(options) }),
    },
    storage: {
      session: {
        get: vi.fn(async (key: string) => store.has(key) ? { [key]: store.get(key) } : {}),
        set: vi.fn(async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) store.set(key, value)
        }),
      },
    },
  })
  return { updates, store }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('network rules', () => {
  it('scopes a block rule to the controlled tab', async () => {
    const { updates } = mockChrome()

    const id = await addBlockRule(42, '*/ads/*', ['image'])

    expect(updates).toEqual([{
      addRules: [{
        id,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: '*/ads/*', tabIds: [42], resourceTypes: ['image'] },
      }],
    }])
    expect(await listTabRules(42)).toEqual([{ id, tabId: 42, kind: 'block' }])
  })

  it('installs request and response header changes as one modifyHeaders rule', async () => {
    const { updates } = mockChrome()

    const id = await addHeaderRule(
      7,
      '*/api/*',
      [{ header: 'x-dsh', operation: 'set', value: '1' }],
      [{ header: 'content-security-policy', operation: 'remove' }],
    )

    expect(updates[0]?.addRules?.[0]).toMatchObject({
      id,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'x-dsh', operation: 'set', value: '1' }],
        responseHeaders: [{ header: 'content-security-policy', operation: 'remove' }],
      },
      condition: { urlFilter: '*/api/*', tabIds: [7] },
    })
  })

  it('clears only the rules it installed for that tab', async () => {
    const { updates } = mockChrome()
    const first = await addBlockRule(1, 'a')
    const second = await addBlockRule(2, 'b')
    const third = await addHeaderRule(1, 'c', [{ header: 'x', operation: 'remove' }], undefined)

    const removed = await clearTabRules(1)

    expect(removed).toBe(2)
    expect(updates.at(-1)).toEqual({ removeRuleIds: [first, third] })
    expect(await listTabRules(1)).toEqual([])
    expect(await listTabRules(2)).toEqual([{ id: second, tabId: 2, kind: 'block' }])
  })

  it('rejects malformed header changes instead of installing them', async () => {
    mockChrome()

    expect(parseHeaderChanges([{ header: 'x', operation: 'set' }])).toBeUndefined()
    expect(parseHeaderChanges([{ header: 'x', operation: 'patch', value: '1' }])).toBeUndefined()
    expect(parseHeaderChanges([{ operation: 'remove' }])).toBeUndefined()
    expect(parseHeaderChanges([])).toBeUndefined()
    expect(parseHeaderChanges([{ header: 'x', operation: 'remove' }]))
      .toEqual([{ header: 'x', operation: 'remove' }])
  })
})
