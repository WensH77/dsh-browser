/**
 * jsdom test setup: jsdom has no layout engine, so getBoundingClientRect
 * returns all zeros (which the visibility filter reads as hidden), and it
 * does not implement CSS.escape. Stub both with browser-equivalent behavior.
 * jsdom has no pointer events either, and its `view` member rejects the object
 * this environment calls `window`; both are filled in below.
 *
 * The setup file runs for every spec regardless of the environment a spec asks
 * for, so the DOM stubs are skipped when there is no DOM (a `node` spec that
 * only exercises pure logic).
 */

const FAKE_RECT: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 200,
  bottom: 40,
  width: 200,
  height: 40,
  toJSON: () => ({}),
}

if (typeof Element !== 'undefined') {
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: function getBoundingClientRect(this: Element): DOMRect {
      return FAKE_RECT
    },
  })
}

// jsdom's MouseEvent validates `view` against a real Window instance, but this
// environment exposes a proxy in place of one (`window instanceof Window` is
// false here and true in Chrome), so `new MouseEvent(type, { view: window })`
// throws before any listener runs. Drop only that member, and only when the
// environment cannot accept it — every other option reaches the page unchanged.
if (typeof globalThis.Window !== 'undefined'
  && typeof globalThis.window !== 'undefined'
  && !(globalThis.window instanceof globalThis.Window)) {
  const Native = globalThis.MouseEvent
  class RelaxedMouseEvent extends Native {
    constructor(type: string, init: MouseEventInit = {}) {
      const view = init.view
      super(type, view == null || view instanceof Window ? init : { ...init, view: null })
    }
  }
  Object.defineProperty(globalThis, 'MouseEvent', {
    configurable: true,
    writable: true,
    value: RelaxedMouseEvent,
  })
}

if (typeof globalThis.PointerEvent === 'undefined') {
  // Chrome MV3 ships `PointerEvent`, so this only fills the test environment:
  // `MouseEvent` takes the same coordinate, button, and detail options the
  // pointer path passes.
  Object.defineProperty(globalThis, 'PointerEvent', {
    configurable: true,
    writable: true,
    value: globalThis.MouseEvent,
  })
}

if (typeof globalThis.CSS === 'undefined') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: {
      escape(value: string): string {
        return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
      },
    },
  })
}
