/**
 * Human-readable one-liners for the operation feed.
 *
 * The label says what the model was doing in the user's terms — a host, an
 * element's name, a pattern — while the tool name stays visible beside it, so
 * the feed stays auditable (a run of identical tool calls is still obvious).
 * Nothing here is model-authored: either the extension resolved it at execution
 * time (`op.label`) or it is derived from the call's own arguments.
 *
 * @module
 */

import { shorten } from '../shared/text.ts'
import type { RecentOp } from '../shared/messages.ts'

/** Strings one label needs; supplied by the panel so this stays locale-free. */
export interface OpCopy {
  opNavigate: string
  opClick: string
  opType: string
  opPress: string
  opScroll: string
  opWait: string
  opSnapshot: string
  opGetText: string
  opBack: string
  opForward: string
  opReload: string
  opListTabs: string
  opBindTab: string
  opEval: string
  opBlock: string
  opHeaders: string
  opCapture: string
  opConsole: string
  opNetwork: string
  opDialog: string
  opChars: string
  opElement: string
}

/** Longest source string kept before the panel's own ellipsis takes over. */
const SOURCE_MAX = 48

function short(value: string, max: number = SOURCE_MAX): string {
  return shorten(value, max)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return short(url)
  }
}

function stringArg(op: RecentOp, key: string): string {
  const value = op.args[key]
  return typeof value === 'string' ? value : ''
}

function numberArg(op: RecentOp, key: string): number | undefined {
  const value = op.args[key]
  return typeof value === 'number' ? value : undefined
}

/** The element this call addressed, as far as the arguments reveal it. */
function target(op: RecentOp, copy: OpCopy): string {
  const selector = stringArg(op, 'selector')
  if (selector !== '') return short(selector)
  const index = numberArg(op, 'index')
  return index === undefined ? copy.opElement : `[${index}]`
}

/**
 * Derive the feed's primary text for one operation.
 *
 * @param op - the recorded operation (its `label` wins when execution resolved one).
 * @param copy - localized verb strings.
 * @returns a short, factual label.
 */
export function opLabel(op: RecentOp, copy: OpCopy): string {
  // What the extension actually resolved beats anything guessed from arguments.
  const resolved = typeof op.label === 'string' && op.label.trim() !== '' ? short(op.label) : undefined
  const named = (verb: string): string => `${verb} ${resolved ?? target(op, copy)}`
  switch (op.name) {
    case 'browser_navigate': return `${copy.opNavigate} ${hostOf(stringArg(op, 'url'))}`
    case 'browser_click': return named(copy.opClick)
    case 'browser_type': return resolved === undefined
      ? `${copy.opType} ${stringArg(op, 'text').length}${copy.opChars} → ${target(op, copy)}`
      : `${copy.opType} ${stringArg(op, 'text').length}${copy.opChars} → ${resolved}`
    case 'browser_press': return `${copy.opPress} ${short(stringArg(op, 'key'))}`
    case 'browser_scroll': return `${copy.opScroll} ${short(stringArg(op, 'direction'))}`
    case 'browser_wait': {
      const ms = numberArg(op, 'ms')
      return `${copy.opWait}${ms === undefined ? '' : ` ${ms}ms`}`
    }
    case 'browser_snapshot': return copy.opSnapshot
    case 'browser_capture': return copy.opCapture
    case 'browser_get_text': {
      // The search term and the region are what tell one read from another; the
      // label used to be the same two words every time.
      const scope = stringArg(op, 'selector')
      const find = stringArg(op, 'find')
      const parts = [find === '' ? '' : `"${short(find, 24)}"`, scope === '' ? '' : short(scope, 24)].filter((p) => p !== '')
      return parts.length === 0 ? copy.opGetText : `${copy.opGetText} ${parts.join(' · ')}`
    }
    case 'browser_console': return copy.opConsole
    case 'browser_network': {
      if (op.args.mock !== undefined || op.args.mockClear === true) return copy.opNetwork
      const requestId = stringArg(op, 'requestId')
      if (requestId !== '') return `${copy.opNetwork} (${short(requestId, 16)})`
      // A filtered list is a different question from an unfiltered one; without
      // the filter every entry read as a bare "Network".
      const filter = stringArg(op, 'url')
      const type = stringArg(op, 'resourceType')
      const parts = [filter === '' ? '' : short(filter, 28), type === '' ? '' : type].filter((p) => p !== '')
      return parts.length === 0 ? copy.opNetwork : `${copy.opNetwork} ${parts.join(' · ')}`
    }
    case 'browser_eval': return copy.opEval
    case 'browser_dialog': return `${copy.opDialog} ${stringArg(op, 'action')}`
    case 'browser_block': return `${copy.opBlock} ${short(stringArg(op, 'pattern'))}`
    case 'browser_headers': return `${copy.opHeaders} ${short(stringArg(op, 'pattern'))}`
    case 'browser_back': return copy.opBack
    case 'browser_forward': return copy.opForward
    case 'browser_reload': return copy.opReload
    case 'browser_list_tabs': return copy.opListTabs
    case 'browser_bind_tab': {
      const tabId = numberArg(op, 'tabId')
      return `${copy.opBindTab} ${tabId ?? ''}`.trim()
    }
    default: return op.name
  }
}
