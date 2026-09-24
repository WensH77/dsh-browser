/**
 * The user's consent gate for browser-debugging capabilities.
 *
 * `chrome.debugger` can read and rewrite anything the page can see, so the
 * extension only advertises it (and only runs those tools) while the user has
 * "Allow browser debugging" switched on. The setting is off on first install:
 * the host then never registers the tools, so the model cannot even see them.
 *
 * @module
 */

import { DEBUG_TOOL_NAMES } from 'dsh-bridge-browser/src/protocol.ts'
import type { ToolAnswer } from './tools.ts'

/** Re-exported so callers and tests keep one import path for the list. */
export { DEBUG_TOOL_NAMES }

/**
 * Tools that need `chrome.debugger`. The list itself lives in the shared wire
 * contract so this half cannot drift from the host's registration.
 */
const DEBUG_TOOLS = new Set<string>(DEBUG_TOOL_NAMES)

/**
 * Refuse a debugging tool while the user has the capability switched off.
 *
 * @param name - tool name from the bridge.
 * @param allowed - the current "allow browser debugging" setting.
 * @returns a refusal to answer with, or undefined when the call may proceed.
 */
export function debugToolRefusal(name: string, allowed: boolean): ToolAnswer | undefined {
  if (allowed || !DEBUG_TOOLS.has(name)) return undefined
  return {
    ok: false,
    error: {
      code: 'unsupported',
      message: `Browser debugging is switched off in the extension settings, so ${name} is unavailable. Turn on "Allow browser debugging" in the extension's options to use screenshots, console, network, and page evaluation.`,
    },
  }
}
