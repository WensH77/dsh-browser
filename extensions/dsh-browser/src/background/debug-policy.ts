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

import type { ToolAnswer } from './tools.ts'

/** Tools that need `chrome.debugger`; mirrors the host's DEBUG_TOOL_NAMES. */
export const DEBUG_TOOL_NAMES = new Set([
  'browser_capture',
  'browser_console',
  'browser_network',
  'browser_eval',
  'browser_dialog',
])

/**
 * Refuse a debugging tool while the user has the capability switched off.
 *
 * @param name - tool name from the bridge.
 * @param allowed - the current "allow browser debugging" setting.
 * @returns a refusal to answer with, or undefined when the call may proceed.
 */
export function debugToolRefusal(name: string, allowed: boolean): ToolAnswer | undefined {
  if (allowed || !DEBUG_TOOL_NAMES.has(name)) return undefined
  return {
    ok: false,
    error: {
      code: 'unsupported',
      message: `Browser debugging is switched off in the extension settings, so ${name} is unavailable. Turn on "Allow browser debugging" in the extension's options to use screenshots, console, network, and page evaluation.`,
    },
  }
}
