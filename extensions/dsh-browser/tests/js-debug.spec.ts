// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDebuggerSessionsForTest } from '../src/background/debugger-session.ts'

/**
 * The debugger's state (scripts, pauses, breakpoints) lives at module scope, so
 * each test reloads the module. `emit` drives the listener `js-debug.ts`
 * installs for itself — the console/network router in `devtools.ts` never sees
 * `Debugger.*` events, on purpose (that router drops tabs it keeps no buffer
 * record for).
 */
type JsDebug = typeof import('../src/background/js-debug.ts')

interface Harness {
  js: JsDebug
  emit: (tabId: number, method: string, params?: object) => void
  detach: (tabId: number, reason?: string) => void
  sendCommand: ReturnType<typeof vi.fn>
  attach: ReturnType<typeof vi.fn>
}

async function loadHarness(): Promise<Harness> {
  const eventListeners: Array<(source: { tabId?: number }, method: string, params?: object) => void> = []
  const detachListeners: Array<(source: { tabId?: number }, reason: string) => void> = []
  const sendCommand = vi.fn(async (_target: unknown, method: string, _params?: object) => {
    if (method === 'Debugger.setBreakpointByUrl') {
      return { breakpointId: 'bp-1', locations: [{ scriptId: '7', lineNumber: 41, columnNumber: 0 }] }
    }
    if (method === 'Runtime.getProperties') {
      return {
        result: [
          { name: 'total', value: { value: 3 } },
          { name: 'items', value: { description: 'Array(2)' } },
          { name: 'computed', get: { objectId: 'getter' } },
        ],
      }
    }
    if (method === 'Debugger.evaluateOnCallFrame') return { result: { value: 42 } }
    return {}
  })
  const attach = vi.fn(async () => undefined)
  vi.stubGlobal('chrome', {
    debugger: {
      attach,
      detach: vi.fn(async () => undefined),
      sendCommand,
      onEvent: { addListener: (listener: (typeof eventListeners)[number]) => eventListeners.push(listener) },
      onDetach: { addListener: (listener: (typeof detachListeners)[number]) => detachListeners.push(listener) },
    },
  })
  vi.resetModules()
  const js = await import('../src/background/js-debug.ts')
  return {
    js,
    sendCommand,
    attach,
    emit: (tabId, method, params) => { for (const listener of eventListeners) listener({ tabId }, method, params) },
    detach: (tabId, reason = 'canceled_by_user') => { for (const listener of detachListeners) listener({ tabId }, reason) },
  }
}

const FRAME = {
  callFrameId: 'frame-0',
  functionName: 'onClick',
  url: 'https://app.example/app.js',
  location: { lineNumber: 41, columnNumber: 5, scriptId: '7' },
  scopeChain: [{ type: 'local', object: { objectId: 'scope-0' } }],
}

let harness: Harness

beforeEach(async () => {
  resetDebuggerSessionsForTest()
  harness = await loadHarness()
})

afterEach(() => {
  resetDebuggerSessionsForTest()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('script inventory', () => {
  it('buffers parsed scripts, lists the newest first, and filters', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'scripts' }, 32_000)
    harness.emit(1, 'Debugger.scriptParsed', { scriptId: '1', url: 'https://app.example/vendor.js', length: 1_000 })
    harness.emit(1, 'Debugger.scriptParsed', { scriptId: '2', url: 'https://app.example/app.js', length: 2_000 })
    // A repeat of the same scriptId must not duplicate the inventory.
    harness.emit(1, 'Debugger.scriptParsed', { scriptId: '2', url: 'https://app.example/app.js', length: 2_000 })

    const all = await harness.js.jsDebugAnswer(1, { action: 'scripts' }, 32_000)
    expect(all.result?.text).toContain('app.js (2000 bytes)')
    expect(all.result?.text.indexOf('app.js')).toBeLessThan(all.result?.text.indexOf('vendor.js') ?? 0)
    expect(all.result?.text.match(/app\.js/g)).toHaveLength(1)
    expect(all.result?.text).toContain('nextCursor: 2')

    const filtered = await harness.js.jsDebugAnswer(1, { action: 'scripts', url: 'vendor' }, 32_000)
    expect(filtered.result?.text).toContain('vendor.js')
    expect(filtered.result?.text).not.toContain('app.js')

    // The cursor pages by discovery order, so a later chunk shows up as new.
    const paged = await harness.js.jsDebugAnswer(1, { action: 'scripts', cursor: 1 }, 32_000)
    expect(paged.result?.text).toContain('app.js')
    expect(paged.result?.text).not.toContain('vendor.js')
    harness.emit(1, 'Debugger.scriptParsed', { scriptId: '3', url: 'https://app.example/lazy.js', length: 10 })
    const later = await harness.js.jsDebugAnswer(1, { action: 'scripts', cursor: 2 }, 32_000)
    expect(later.result?.text).toContain('lazy.js')
    expect(later.result?.text).not.toContain('app.js')
  })

  it('pages forward: a script the page left out is the next page\'s first', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'scripts' }, 32_000)
    harness.emit(1, 'Debugger.scriptParsed', { scriptId: '1', url: 'https://app.example/a.js' })
    harness.emit(1, 'Debugger.scriptParsed', { scriptId: '2', url: 'https://app.example/b.js' })

    const first = await harness.js.jsDebugAnswer(1, { action: 'scripts', limit: 1 }, 32_000)
    expect(first.result?.text).toContain('a.js')
    expect(first.result?.text).not.toContain('b.js')
    expect(first.result?.text).toContain('nextCursor: 1')

    const second = await harness.js.jsDebugAnswer(1, { action: 'scripts', limit: 1, cursor: 1 }, 32_000)
    expect(second.result?.text).toContain('b.js')
  })
})

describe('breakpoints', () => {
  beforeEach(async () => {
    await harness.js.jsDebugAnswer(1, { action: 'scripts' }, 32_000)
    harness.emit(1, 'Debugger.scriptParsed', { scriptId: '7', url: 'https://app.example/app.js', length: 9_000 })
  })

  it('resolves a unique url substring, installs the breakpoint, lists and removes it', async () => {
    const set = await harness.js.jsDebugAnswer(1, { action: 'break', url: 'app.js', lineNumber: 41, condition: 'total > 3' }, 32_000)

    expect(harness.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Debugger.setBreakpointByUrl',
      { lineNumber: 41, url: 'https://app.example/app.js', condition: 'total > 3' },
    )
    expect(set.result?.text).toContain('id=bp-1')
    expect(set.result?.text).toContain('condition: total > 3')
    expect(set.result?.text).toContain('Locations 7:41:0')
    expect(set.result?.text).toContain('Resolved to https://app.example/app.js')

    const listed = await harness.js.jsDebugAnswer(1, { action: 'list' }, 32_000)
    expect(listed.result?.text).toContain('id=bp-1')

    const removed = await harness.js.jsDebugAnswer(1, { action: 'unbreak', id: 'bp-1' }, 32_000)
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Debugger.removeBreakpoint', { breakpointId: 'bp-1' })
    expect(removed.result?.text).toContain('Removed id=bp-1')

    const empty = await harness.js.jsDebugAnswer(1, { action: 'list' }, 32_000)
    expect(empty.result?.text).toContain('(none installed)')
  })

  it('refuses an ambiguous url substring with the candidates instead of guessing', async () => {
    harness.emit(1, 'Debugger.scriptParsed', { scriptId: '8', url: 'https://cdn.example/app.js', length: 10 })

    const answer = await harness.js.jsDebugAnswer(1, { action: 'break', url: 'app.js', lineNumber: 5 }, 32_000)

    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('matches 2 loaded scripts')
    expect(answer.error?.message).toContain('https://cdn.example/app.js')
    expect(harness.sendCommand).not.toHaveBeenCalledWith({ tabId: 1 }, 'Debugger.setBreakpointByUrl', expect.anything())
  })

  it('stops on XHR/fetch traffic and removes that breakpoint by url', async () => {
    const set = await harness.js.jsDebugAnswer(1, { action: 'break', kind: 'xhr', url: '/api/orders' }, 32_000)

    // XHR breakpoints belong to `DOMDebugger`; `Debugger.setXHRBreakpoint` does
    // not exist (measured live: -32601).
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'DOMDebugger.setXHRBreakpoint', { url: '/api/orders' })
    expect(set.result?.text).toContain('id=xhr:/api/orders')

    await harness.js.jsDebugAnswer(1, { action: 'unbreak', id: 'xhr:/api/orders' }, 32_000)
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'DOMDebugger.removeXHRBreakpoint', { url: '/api/orders' })
  })

  it('clears every breakpoint at once', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'break', url: 'app.js', lineNumber: 41 }, 32_000)
    await harness.js.jsDebugAnswer(1, { action: 'break', kind: 'xhr', url: '/api' }, 32_000)

    const cleared = await harness.js.jsDebugAnswer(1, { action: 'unbreak', all: true }, 32_000)

    expect(cleared.result?.text).toContain('Removed 2 breakpoint(s)')
    const listed = await harness.js.jsDebugAnswer(1, { action: 'list' }, 32_000)
    expect(listed.result?.text).toContain('(none installed)')
  })
})

describe('pauses', () => {
  it('reports the pause, its frames and the top frame variables, with a cursor', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    harness.emit(1, 'Debugger.paused', { reason: 'other', hitBreakpoints: ['bp-1'], callFrames: [FRAME] })

    expect(harness.js.pausedAtBreakpoint(1)).toBe('paused at https://app.example/app.js:41:5 (reason other)')

    const read = await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    expect(read.result?.text).toContain('[1] other hit bp-1 — 1 frame(s)')
    expect(read.result?.text).toContain('[0] onClick @ https://app.example/app.js:41:5')
    expect(read.result?.text).toContain('local: total=3, items=Array(2)')
    // Accessor-only entries are not values the page holds; the card would lie.
    expect(read.result?.text).not.toContain('computed=')
    expect(read.result?.text).toContain('nextCursor: 1')

    const again = await harness.js.jsDebugAnswer(1, { action: 'wait', cursor: 1 }, 32_000)
    expect(again.result?.text).toContain('pauses (none new; buffer holds 1)')
  })

  it('marks an older pause as stale instead of offering a dead frame id', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    harness.emit(1, 'Debugger.paused', { reason: 'other', callFrames: [FRAME] })
    harness.emit(1, 'Debugger.resumed', {})
    harness.emit(1, 'Debugger.paused', { reason: 'other', callFrames: [{ ...FRAME, callFrameId: 'frame-1' }] })

    const read = await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    expect(read.result?.text).toContain('[1] other — 1 frame(s) (not the current pause: frame ids are stale, eval will not work)')
    // Only the current pause spends the property round trips.
    expect(harness.sendCommand.mock.calls.filter((call) => call[1] === 'Runtime.getProperties')).toHaveLength(1)
  })

  it('says "already running" instead of quoting Chrome when there is no pause', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    harness.sendCommand.mockRejectedValueOnce(new Error('Can only perform operation while paused.'))

    const answer = await harness.js.jsDebugAnswer(1, { action: 'resume' }, 32_000)

    expect(answer.ok).toBe(true)
    expect(answer.result?.text).toContain('nothing to resume')
  })

  it('says a scope could not be read rather than printing nothing', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    harness.emit(1, 'Debugger.paused', { reason: 'other', callFrames: [FRAME] })
    harness.sendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'Runtime.getProperties') throw new Error('Inspected target navigated or closed')
      return {}
    })

    const read = await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)

    expect(read.result?.text).toContain('local: (could not be read)')
  })

  it('names the script when Chrome leaves the frame url empty', async () => {
    // Measured live: a plain http://127.0.0.1 script paused with an empty
    // `Debugger.CallFrame.url`, and the pause rendered as "(anonymous script)".
    await harness.js.jsDebugAnswer(1, { action: 'scripts' }, 32_000)
    harness.emit(1, 'Debugger.scriptParsed', { scriptId: '7', url: 'https://app.example/app.js' })
    harness.emit(1, 'Debugger.paused', { reason: 'other', callFrames: [{ ...FRAME, url: '' }] })

    expect(harness.js.pausedAtBreakpoint(1)).toBe('paused at https://app.example/app.js:41:5 (reason other)')
    const read = await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    expect(read.result?.text).toContain('[0] onClick @ https://app.example/app.js:41:5')
  })

  it('clears the pause on resume', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    harness.emit(1, 'Debugger.paused', { reason: 'other', callFrames: [FRAME] })
    harness.emit(1, 'Debugger.resumed', {})

    expect(harness.js.pausedAtBreakpoint(1)).toBeUndefined()
    const read = await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    expect(read.result?.text).toContain('page is running')
  })

  it('pages pauses forward, so a truncated read loses nothing', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    harness.emit(1, 'Debugger.paused', { reason: 'other', callFrames: [FRAME] })
    harness.emit(1, 'Debugger.resumed', {})
    harness.emit(1, 'Debugger.paused', { reason: 'other', callFrames: [{ ...FRAME, callFrameId: 'frame-1' }] })

    const first = await harness.js.jsDebugAnswer(1, { action: 'wait', limit: 1 }, 32_000)
    expect(first.result?.text).toContain('[1] other')
    expect(first.result?.text).not.toContain('[2] other')
    expect(first.result?.text).toContain('nextCursor: 1')

    const second = await harness.js.jsDebugAnswer(1, { action: 'wait', limit: 1, cursor: 1 }, 32_000)
    expect(second.result?.text).toContain('[2] other')
  })

  it('waits for the next pause when asked to', async () => {    await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    const pending = harness.js.jsDebugAnswer(1, { action: 'wait', timeoutMs: 5_000 }, 32_000)
    setTimeout(() => harness.emit(1, 'Debugger.paused', { reason: 'other', callFrames: [FRAME] }), 5)

    const read = await pending

    expect(read.result?.text).toContain('[1] other — 1 frame(s)')
  })

  it('moves execution with pause, step and resume', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'pause' }, 32_000)
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Debugger.pause')

    await harness.js.jsDebugAnswer(1, { action: 'step', kind: 'into' }, 32_000)
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Debugger.stepInto')

    const bad = await harness.js.jsDebugAnswer(1, { action: 'step', kind: 'sideways' }, 32_000)
    expect(bad.ok).toBe(false)

    await harness.js.jsDebugAnswer(1, { action: 'resume' }, 32_000)
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Debugger.resume')
  })
})

describe('evaluating in a paused frame', () => {
  it('refuses while the page is running', async () => {
    const answer = await harness.js.jsDebugAnswer(1, { action: 'eval', expression: 'x' }, 32_000)
    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('not paused')
  })

  it('evaluates in the named frame and reports the value', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    harness.emit(1, 'Debugger.paused', { reason: 'other', callFrames: [FRAME] })

    const answer = await harness.js.jsDebugAnswer(1, { action: 'eval', expression: 'total + 1' }, 32_000)

    // No `awaitPromise`: the CDP method has no such parameter, which is also why
    // a promise can only come back as an object while the page is paused.
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Debugger.evaluateOnCallFrame', {
      callFrameId: 'frame-0',
      expression: 'total + 1',
      returnByValue: true,
      silent: false,
    })
    expect(answer.result?.text).toBe('result: 42')
  })

  it('reports an exception instead of a value', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    harness.emit(1, 'Debugger.paused', { reason: 'other', callFrames: [FRAME] })
    harness.sendCommand.mockResolvedValueOnce({ exceptionDetails: { exception: { description: 'ReferenceError: nope' } } })

    const answer = await harness.js.jsDebugAnswer(1, { action: 'eval', expression: 'nope' }, 32_000)

    expect(answer.ok).toBe(true)
    expect(answer.result?.text).toContain('exception in onClick: ReferenceError: nope')
  })
})

describe('teardown', () => {
  it('re-enables the domain after a drop instead of trusting stale bookkeeping', async () => {
    // `dropJsDebug` turns the Debugger domain off through the session, so the
    // next holder must send `Debugger.enable` again — otherwise every later
    // breakpoint would fail with "Debugger agent is not enabled".
    await harness.js.jsDebugAnswer(1, { action: 'list' }, 32_000)
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Debugger.enable')

    await harness.js.dropJsDebug(1)
    harness.sendCommand.mockClear()

    await harness.js.jsDebugAnswer(1, { action: 'list' }, 32_000)

    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Debugger.enable')
  })

  it('resumes and disables the debugger when the state is dropped', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    harness.emit(1, 'Debugger.paused', { reason: 'other', callFrames: [FRAME] })
    harness.emit(1, 'Debugger.scriptParsed', { scriptId: '7', url: 'https://app.example/app.js' })

    const touched = await harness.js.dropJsDebug(1)

    expect(touched).toBe(true)
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Debugger.resume')
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Debugger.disable')
    expect(harness.js.pausedAtBreakpoint(1)).toBeUndefined()
  })

  it('forgets the pause when Chrome drops the session, without sending commands', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    harness.emit(1, 'Debugger.paused', { reason: 'other', callFrames: [FRAME] })
    harness.sendCommand.mockClear()

    harness.detach(1, 'canceled_by_user')

    expect(harness.js.pausedAtBreakpoint(1)).toBeUndefined()
    expect(harness.sendCommand).not.toHaveBeenCalled()
  })
})

describe('unknown action', () => {
  it('names the actions that exist', async () => {
    const answer = await harness.js.jsDebugAnswer(1, { action: 'breakdance' }, 32_000)
    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('Unknown browser_debug action "breakdance"')
  })
})
