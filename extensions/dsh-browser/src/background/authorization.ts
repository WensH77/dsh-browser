/** Pure authorization policy for model-requested browser tools. */

import type { ToolCall } from './tools.ts'
import type { TabFrame } from './frames.ts'
import type { ApprovalPrompt } from '../security/approval.ts'
import { getUiLocale, type UiLocale } from '../i18n.ts'

const PAGE_READS = new Set([
  'browser_snapshot',
  'browser_get_text',
  'browser_capture',
  'browser_image',
  'browser_console',
  'browser_network',
  'browser_dom_query',
])
/** Actions whose blast radius is not bounded by "one origin", so they never trust-skip. */
const UNTRUSTABLE_ACTIONS = new Set(['browser_eval', 'browser_headers', 'browser_dialog'])
const STATE_CHANGING_ACTIONS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
])
/**
 * Background-answered downloads that spend the user's signed-in session on a
 * remote origin. They are approved exactly like an action: origin-scoped,
 * trustable, and skippable once that origin is trusted.
 */
const REMOTE_FETCH_ACTIONS = new Set(['gdrive.fetch'])

/** Consent policy knobs the background mirrors from user settings. */
export interface ActionTrustPolicy {
  /** Whether origin trust also covers page-context JavaScript execution. */
  trustJsExecution: boolean
}

let actionTrustPolicy: ActionTrustPolicy = { trustJsExecution: false }

/** Apply the user's consent policy; called whenever settings load or change. */
export function setActionTrustPolicy(policy: ActionTrustPolicy): void {
  actionTrustPolicy = policy
}

/** Return an approval prompt, or undefined when this call needs no prompt. */
export function approvalPromptForCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  frames: TabFrame[],
  locale: UiLocale = getUiLocale(),
): ApprovalPrompt | undefined {
  if (call.name === 'browser_network' && (call.args.mock !== undefined || call.args.mockClear === true)) {
    return {
      kind: 'action',
      action: call.name,
      summary: localized(locale, 'Replace or block a network response on the current page', '替换或阻断当前页面的某个网络响应'),
      origins: uniqueOrigins(frames, frames),
      canTrust: false,
    }
  }

  if (REMOTE_FETCH_ACTIONS.has(call.name)) {
    // Consent is about the file's origin: the user trusts a document host, not
    // one particular file id. The summary keeps the displayed URL origin+path
    // only, so share links never print their query-string tokens.
    const url = typeof call.args.url === 'string' ? call.args.url : ''
    const destination = originFromUrl(url)
    const shown = displayUrl(url, locale)
    return {
      kind: 'action',
      action: call.name,
      summary: localized(
        locale,
        `Export ${shown} to the session folder using your signed-in browser session`,
        `使用你已登录的浏览器会话把 ${shown} 导出到会话目录`,
      ),
      origins: destination === undefined ? [] : [destination],
      canTrust: destination !== undefined,
    }
  }

  if (PAGE_READS.has(call.name)) {
    if (sharePageContent !== 'ask') return undefined
    const targetFrames = call.name === 'browser_snapshot'
      ? frames
      : frames.filter((frame) => frame.frameId === requestedFrame(call.args))
    return {
      kind: 'read',
      action: call.name,
      summary: call.name === 'browser_snapshot'
        ? localized(locale, 'Read the current page and accessible iframes', '读取当前页面及可访问 iframe')
        : call.name === 'browser_capture'
          ? localized(locale, 'Capture a screenshot of the current page', '截取当前页面截图')
          : call.name === 'browser_image'
            ? localized(locale, 'Read a picture from the current page', '读取当前页面里的一张图片')
            : call.name === 'browser_dom_query'
              ? localized(locale, 'Read elements matching a CSS selector on the current page', '按 CSS 选择器读取当前页面的元素')
            : localized(locale, 'Read text from the specified area of the current page', '读取当前页面的指定文本区域'),
      origins: uniqueOrigins(targetFrames, frames),
      canTrust: false,
    }
  }

  if (call.name === 'browser_block') {
    const pattern = typeof call.args.pattern === 'string' ? call.args.pattern : ''
    return {
      kind: 'action',
      action: call.name,
      summary: localized(
        locale,
        `Block network requests matching ${safeInline(pattern)} on this tab`,
        `在本标签页阻断匹配 ${safeInline(pattern)} 的网络请求`,
      ),
      origins: uniqueOrigins(frames, frames),
      // Blocking is scoped to one tab and reversible; a trusted origin may skip it.
      canTrust: true,
    }
  }

  if (UNTRUSTABLE_ACTIONS.has(call.name)) {
    // JavaScript execution only joins origin trust when the user opts in: a
    // trusted click target is not automatically a trusted place to run code.
    const trustable = call.name === 'browser_eval' && actionTrustPolicy.trustJsExecution
    // `browser_eval` runs its expression in one frame, so that frame's origin is
    // the whole boundary. Listing every frame in the tab instead made consent
    // depend on auxiliary frames — Slides loads sandboxed ones — that come and go
    // on their own, which invalidated grants the user had just given.
    const targets = call.name === 'browser_eval'
      ? frames.filter((frame) => frame.frameId === requestedFrame(call.args))
      : frames
    return {
      kind: 'action',
      action: call.name,
      summary: call.name === 'browser_eval'
        ? localized(locale, 'Run JavaScript in the current page context', '在当前页面的 JS 上下文里执行代码')
        : call.name === 'browser_dialog'
          ? localized(
              locale,
              `Answer the page's JavaScript dialog (${call.args.action === 'accept' ? 'accept' : 'dismiss'})`,
              `回应页面的 JS 弹窗（${call.args.action === 'accept' ? '确认' : '取消'}）`,
            )
          : localized(
            locale,
            `Rewrite request/response headers for ${safeInline(typeof call.args.pattern === 'string' ? call.args.pattern : '')}`,
            `改写匹配 ${safeInline(typeof call.args.pattern === 'string' ? call.args.pattern : '')} 的请求/响应头`,
          ),
      origins: uniqueOrigins(targets, frames),
      // Header rewriting can exfiltrate or reshape what the page loads, so it is
      // never trust-skipped; JS execution joins trust only by explicit opt-in.
      canTrust: trustable,
    }
  }

  if (!STATE_CHANGING_ACTIONS.has(call.name)) return undefined

  // Navigation consent is about the DESTINATION: once the user trusts a site,
  // the model may drive the controlled tab to it from anywhere. The departure
  // page is never added to an allowlist (the bound tab is itself the user's
  // consent surface), so cross-origin navigations can offer trust too.
  if (call.name === 'browser_navigate') {
    const destination = originFromUrl(typeof call.args.url === 'string' ? call.args.url : '')
    return {
      kind: 'action',
      action: call.name,
      summary: summarizeAction(call, locale),
      origins: destination === undefined ? [] : [destination],
      // Invalid, opaque, or non-http(s) destinations stay untrustable.
      canTrust: destination !== undefined,
    }
  }

  const frameId = requestedFrame(call.args)
  const target = frames.find((frame) => frame.frameId === frameId) ?? frames.find((frame) => frame.frameId === 0)
  const origins = uniqueOrigins(target === undefined ? [] : [target], frames)
  // History destinations are unknown, so back/forward can never expand trust.
  const canTrust = origins.length === 1 && call.name !== 'browser_back' && call.name !== 'browser_forward'
  return {
    kind: 'action',
    action: call.name,
    summary: summarizeAction(call, locale),
    origins,
    canTrust,
  }
}

function requestedFrame(args: Record<string, unknown>): number {
  return typeof args.frame === 'number' && Number.isInteger(args.frame) && args.frame >= 0 ? args.frame : 0
}

function uniqueOrigins(targets: TabFrame[], allFrames: TabFrame[]): string[] {
  const origins = new Set<string>()
  for (const frame of targets) {
    const origin = effectiveFrameOrigin(frame, allFrames)
    if (origin !== undefined) origins.add(origin)
  }
  return [...origins].sort()
}

function effectiveFrameOrigin(frame: TabFrame, frames: TabFrame[], visited = new Set<number>()): string | undefined {
  if (visited.has(frame.frameId)) return undefined
  visited.add(frame.frameId)
  const direct = originFromUrl(frame.url)
  if (direct !== undefined) return direct
  const parent = frames.find((candidate) => candidate.frameId === frame.parentFrameId)
  return parent === undefined ? undefined : effectiveFrameOrigin(parent, frames, visited)
}

export function originFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'blob:') return undefined
    return url.origin === 'null' ? undefined : url.origin
  } catch {
    return undefined
  }
}

function summarizeAction(call: ToolCall, locale: UiLocale): string {
  const frame = typeof call.args.frame === 'number' && call.args.frame !== 0
    ? localized(locale, `, iframe ${call.args.frame}`, `，iframe ${call.args.frame}`)
    : ''
  const index = typeof call.args.index === 'number' ? call.args.index : '?'
  const selector = typeof call.args.selector === 'string' && call.args.selector.trim() !== '' ? call.args.selector.trim() : undefined
  switch (call.name) {
    case 'browser_click': return selector === undefined
      ? localized(locale, `Click element [${index}]${frame}`, `点击元素 [${index}]${frame}`)
      : localized(locale, `Click the element matching ${safeInline(selector)}`, `点击匹配 ${safeInline(selector)} 的元素`)
    case 'browser_type': {
      const length = typeof call.args.text === 'string' ? call.args.text.length : 0
      const where = selector === undefined ? `element [${index}]` : `the field matching ${safeInline(selector)}`
      const whereZh = selector === undefined ? `元素 [${index}]` : `匹配 ${safeInline(selector)} 的字段`
      return localized(
        locale,
        `Enter ${length} characters in ${where}${frame} (the text is not shown in this dialog)`,
        `向${whereZh}输入 ${length} 个字符${frame}（文本内容不会显示在确认框）`,
      )
    }
    case 'browser_press': return localized(
      locale,
      `Press “${safeInline(typeof call.args.key === 'string' ? call.args.key : '')}”${frame}`,
      `发送按键「${safeInline(typeof call.args.key === 'string' ? call.args.key : '')}」${frame}`,
    )
    case 'browser_navigate': return localized(
      locale,
      `Navigate to ${displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)}`,
      `导航到 ${displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)}`,
    )
    case 'browser_back': return localized(locale, 'Go back in browser history (destination domain unknown)', '返回浏览历史上一页（目标域名未知）')
    case 'browser_forward': return localized(locale, 'Go forward in browser history (destination domain unknown)', '前进到浏览历史下一页（目标域名未知）')
    case 'browser_reload': return localized(locale, 'Reload the current page', '重新加载当前页面')
    default: return call.name
  }
}

function displayUrl(value: string, locale: UiLocale): string {
  try {
    const url = new URL(value)
    return safeInline(`${url.origin}${url.pathname}`, 160)
  } catch {
    return localized(locale, '(invalid URL)', '(无效 URL)')
  }
}

function localized(locale: UiLocale, english: string, chinese: string): string {
  return locale === 'zh' ? chinese : english
}

function safeInline(value: string, maxLength = 40): string {
  const inline = value.replace(/\s+/g, ' ').trim()
  return inline.length <= maxLength ? inline : `${inline.slice(0, maxLength - 1)}…`
}
