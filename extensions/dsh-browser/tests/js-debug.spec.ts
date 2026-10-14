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

describe('event listeners', () => {
  /**
   * A page shaped like the one this action exists for: the input has no handler
   * of its own, and the `blur` handler sits on `document` in the capture phase
   * — legacy React 15 delegation, where the node-level answer is empty while
   * the field does submit on blur.
   */
  const NODES: Record<string, { className: string; description: string; parent?: string }> = {
    'obj-input': { className: 'HTMLInputElement', description: 'input#email', parent: 'obj-form' },
    'obj-form': { className: 'HTMLFormElement', description: 'form#signup', parent: 'obj-body' },
    'obj-body': { className: 'HTMLBodyElement', description: 'body', parent: 'obj-doc' },
    'obj-doc': { className: 'HTMLDocument', description: '#document' },
  }

  function stubChain(listeners: Record<string, Array<Record<string, unknown>>>, start = 'obj-input'): void {
    harness.sendCommand.mockImplementation(async (_target: unknown, method: string, params?: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate') {
        return { result: { objectId: start, className: NODES[start]!.className, description: NODES[start]!.description } }
      }
      if (method === 'DOMDebugger.getEventListeners') {
        return { listeners: listeners[String(params?.objectId)] ?? [] }
      }
      if (method === 'Runtime.callFunctionOn') {
        const parent = NODES[String(params?.objectId)]?.parent
        if (parent === undefined) return { result: { type: 'object', subtype: 'null', value: null } }
        return { result: { objectId: parent, className: NODES[parent]!.className, description: NODES[parent]!.description } }
      }
      return {}
    })
  }

  it('lists every chain level, empty ones included, and pairs document listeners with the delegation warning', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'scripts' }, 32_000)
    harness.emit(1, 'Debugger.scriptParsed', { scriptId: '7', url: 'https://app.example/vendor.js' })
    stubChain({
      'obj-doc': [
        { type: 'blur', useCapture: true, passive: false, once: false, scriptId: '7', lineNumber: 1204, columnNumber: 11 },
        { type: 'click', useCapture: false, passive: true, once: true, scriptId: '99', lineNumber: 3, columnNumber: 0 },
      ],
    })

    const answer = await harness.js.jsDebugAnswer(1, { action: 'listeners', selector: 'input#email' }, 32_000)

    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Runtime.evaluate', {
      expression: 'document.querySelector("input#email")',
      returnByValue: false,
      silent: true,
    })
    // Node-only: Chrome's own default would fold each child's listeners into its parent.
    // `pierce` is off because it also reports other extensions' isolated worlds: on the
    // real page the document level came back with 1390 listeners, most of them foreign.
    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'DOMDebugger.getEventListeners', {
      objectId: 'obj-doc',
      depth: 0,
      pierce: false,
    })

    const text = answer.result?.text ?? ''
    // The empty levels are the answer: they are what "the element has none,
    // document has one" is read from.
    expect(text).toContain('[1] element <input#email>: none')
    expect(text).toContain('[2] parent <form#signup>: none')
    expect(text).toContain('[3] parent <body>: none')
    expect(text).toContain('[4] document: 2')
    expect(text).toContain('blur capture @ https://app.example/vendor.js:1204:11')
    // A listener in a script the buffer does not hold is named, not dropped.
    expect(text).toContain('click bubble (passive, once) @ (script 99 is not in the script buffer):3:0')
    expect(text).toContain('a "none" level is not a verdict')
    expect(text).toContain('can still submit on blur')

    // Handles do not leak: every object consulted is released.
    for (const objectId of ['obj-input', 'obj-form', 'obj-body', 'obj-doc']) {
      expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Runtime.releaseObject', { objectId })
    }
  })

  it('reads document when no selector is given', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'scripts' }, 32_000)
    harness.emit(1, 'Debugger.scriptParsed', { scriptId: '5', url: '' })
    stubChain({ 'obj-doc': [{ type: 'blur', useCapture: true, scriptId: '5', lineNumber: 9, columnNumber: 1 }] }, 'obj-doc')

    const answer = await harness.js.jsDebugAnswer(1, { action: 'listeners' }, 32_000)

    expect(harness.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Runtime.evaluate', {
      expression: 'document',
      returnByValue: false,
      silent: true,
    })
    expect(answer.result?.text).toContain('[1] document: 1')
    expect(answer.result?.text).toContain('blur capture @ (anonymous script):9:1')
    // `document` is the end of the chain: no parent hop is attempted.
    expect(harness.sendCommand).not.toHaveBeenCalledWith({ tabId: 1 }, 'Runtime.callFunctionOn', expect.anything())
  })

  it('says the whole chain is empty without letting it read as "the field ignores blur"', async () => {
    stubChain({})

    const answer = await harness.js.jsDebugAnswer(1, { action: 'listeners', selector: 'input#email' }, 32_000)

    const text = answer.result?.text ?? ''
    expect(text).toContain('none found')
    expect(text).toContain('up to document')
    expect(text).toContain('a "none" level is not a verdict')
    expect(text).toContain('can still respond')
    // The comparison the note depends on is visible: every level is listed.
    expect(text).toContain('[1] element <input#email>: none')
    expect(text).toContain('[4] document: none')
  })

  it('names a selector that matches nothing, and one that is not CSS', async () => {
    harness.sendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'Runtime.evaluate') return { result: { type: 'object', subtype: 'null', value: null } }
      return {}
    })
    const missing = await harness.js.jsDebugAnswer(1, { action: 'listeners', selector: 'input#nope' }, 32_000)
    expect(missing.ok).toBe(false)
    expect(missing.error?.message).toContain('Nothing on this page matches "input#nope"')
    expect(missing.error?.message).toContain('browser_dom_query')

    harness.sendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'Runtime.evaluate') {
        return { exceptionDetails: { exception: { description: 'SyntaxError: "input#" is not a valid selector' } } }
      }
      return {}
    })
    const invalid = await harness.js.jsDebugAnswer(1, { action: 'listeners', selector: 'input#' }, 32_000)
    expect(invalid.ok).toBe(false)
    expect(invalid.error?.message).toContain('"input#" is not a usable CSS selector')
    expect(invalid.error?.message).toContain('not a valid selector')
  })

  it('refuses on a paused page instead of waiting on a renderer that cannot answer', async () => {
    await harness.js.jsDebugAnswer(1, { action: 'wait' }, 32_000)
    harness.emit(1, 'Debugger.paused', { reason: 'other', callFrames: [FRAME] })
    harness.sendCommand.mockClear()

    const answer = await harness.js.jsDebugAnswer(1, { action: 'listeners', selector: 'input#email' }, 32_000)

    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('paused at https://app.example/app.js:41:5')
    expect(answer.error?.message).toContain('Action "resume"')
    expect(harness.sendCommand).not.toHaveBeenCalledWith({ tabId: 1 }, 'Runtime.evaluate', expect.anything())
    // `Runtime` is not even enabled on the way to the refusal: a stopped
    // renderer is the one place this action must not queue a call on.
    expect(harness.sendCommand).not.toHaveBeenCalledWith({ tabId: 1 }, 'Runtime.enable')
  })

  it('narrows to the event types the caller names, and says which', async () => {
    // The question is nearly always "does anything here handle blur?" — and a real
    // document carries a thousand listeners, so the unfiltered dump answered it by luck.
    stubChain({
      'obj-doc': [
        { type: 'blur', useCapture: true, passive: false, once: false, scriptId: '7', lineNumber: 4, columnNumber: 0 },
        { type: 'click', useCapture: false, passive: false, once: false, scriptId: '7', lineNumber: 9, columnNumber: 0 },
        { type: 'focus', useCapture: true, passive: false, once: false, scriptId: '7', lineNumber: 5, columnNumber: 0 },
      ],
    })

    const answer = await harness.js.jsDebugAnswer(1, { action: 'listeners', selector: 'input#email', type: 'BLUR, focus' }, 32_000)

    const text = answer.result?.text ?? ''
    // The counts have to mean what they say, so the filter runs before they are taken.
    expect(text).toContain('of type "blur", "focus"')
    expect(text).toContain('[4] document: 2')
    expect(text).toContain('blur capture')
    expect(text).toContain('focus capture')
    expect(text).not.toContain('click')
  })

  it('reads document directly when the walk runs out of levels first', async () => {
    // The first real page this ran on had the control 12 wrappers deep, and the walk ran out
    // exactly one level short of `document` — the level the whole action exists to report.
    // The ceiling may cut the middle of the chain; it must never cut the end.
    const deep: Record<string, { className: string; description: string; parent?: string }> = {}
    for (let index = 0; index < 40; index += 1) {
      deep[`deep-${index}`] = {
        className: index === 0 ? 'HTMLInputElement' : 'HTMLDivElement',
        description: index === 0 ? 'input#deep' : `div.wrap-${index}`,
        ...(index < 39 ? { parent: `deep-${index + 1}` } : {}),
      }
    }
    deep['obj-doc'] = { className: 'HTMLDocument', description: '#document' }
    let documentReads = 0
    harness.sendCommand.mockImplementation(async (_target: unknown, method: string, params?: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate') {
        if (String(params?.expression) === 'document') {
          documentReads += 1
          return { result: { objectId: 'obj-doc', className: 'HTMLDocument', description: '#document' } }
        }
        return { result: { objectId: 'deep-0', className: 'HTMLInputElement', description: 'input#deep' } }
      }
      if (method === 'DOMDebugger.getEventListeners') {
        return {
          listeners: String(params?.objectId) === 'obj-doc'
            ? [{ type: 'blur', useCapture: true, passive: false, once: false, scriptId: '7', lineNumber: 4, columnNumber: 0 }]
            : [],
        }
      }
      if (method === 'Runtime.callFunctionOn') {
        const parent = deep[String(params?.objectId)]?.parent
        if (parent === undefined) return { result: { type: 'object', subtype: 'null', value: null } }
        return { result: { objectId: parent, className: deep[parent]!.className, description: deep[parent]!.description } }
      }
      return {}
    })

    const answer = await harness.js.jsDebugAnswer(1, { action: 'listeners', selector: 'input#deep' }, 32_000)

    const text = answer.result?.text ?? ''
    expect(documentReads).toBe(1)
    expect(text).toContain('document (reached directly')
    expect(text).not.toContain('document was not reached')
    // The point of reaching it: the delegated handler is visible after all.
    expect(text).toContain('blur capture')
  })
})

describe('unknown action', () => {
  it('names the actions that exist', async () => {
    const answer = await harness.js.jsDebugAnswer(1, { action: 'breakdance' }, 32_000)
    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('Unknown browser_debug action "breakdance"')
  })
})
