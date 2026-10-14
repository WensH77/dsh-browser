/**
 * The two prompts this plugin raises for a human, in the language the connected
 * extension's own UI speaks.
 *
 * Everything else this plugin produces is read by the model and stays English.
 * These two are different: the page-choice question and the nudge for a call
 * that has gone quiet are read by the person in front of Chrome, so they follow
 * the extension's `uiLanguage` setting (reported over `bridge.uiLanguage`, see
 * {@link BridgeServer.clientUiLanguage}). Only the copy that a human reads lives
 * here — and it is deliberately not a copy of the extension's own translation
 * table, which covers a whole panel.
 *
 * @module
 */

import type { UiLanguage } from './protocol.ts'

/** Strings for the two human-facing prompts. */
export interface UserPromptCopy {
  /** Asked by `browser_bind_interactive`, and by a call that found no page. */
  bindQuestion: string
  /**
   * Asked when a bridge call has been silent for a while.
   *
   * @param name - the tool that has not answered.
   * @param seconds - how long it has been silent.
   */
  silentQuestion: (name: string, seconds: number) => string
  /** The nudge's two answers: nothing is waiting, or the user is answering it. */
  silentAnswerNone: string
  silentAnswerWorking: string
}

const EN: UserPromptCopy = {
  bindQuestion: 'Which open page should this session operate?',
  silentQuestion: (name, seconds) =>
    `${name} has run ${seconds} seconds with no answer. Chrome may be showing a confirmation for it — the extension marks that on its toolbar badge — or the page may be stuck. Is a prompt waiting for you?`,
  silentAnswerNone: 'No — nothing is waiting',
  silentAnswerWorking: 'Yes — I am answering it',
}

const ZH: UserPromptCopy = {
  bindQuestion: '这个会话要操作哪个已打开的页面？',
  silentQuestion: (name, seconds) =>
    `${name} 已经 ${seconds} 秒没有回应。可能是 Chrome 里有个确认在等你（扩展会在工具栏徽标上标出来），也可能是页面卡住了。现在有弹窗在等你处理吗？`,
  silentAnswerNone: '没有——没有东西在等',
  silentAnswerWorking: '有——我正在处理',
}

/**
 * Pick the copy for one language.
 *
 * @param language - what the extension reported; undefined means it never said,
 *   which keeps English.
 * @returns the strings of that language.
 */
export function userPromptCopy(language: UiLanguage | undefined): UserPromptCopy {
  return language === 'zh' ? ZH : EN
}
