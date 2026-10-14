/**
 * UI language of the extension's user-facing surfaces.
 *
 * The language is a user setting (`settings.uiLanguage`, default `'en'`), not a
 * property of the browser: a user on a Chinese Chrome may still want the English
 * panel. The background worker is the only document that reads the setting, so
 * it is the only one that calls {@link setUiLocale}; the panel and the options
 * page are separate documents, take the language from the `ui.state` snapshot
 * (`localeFromUiState`), and fall back to English when it is missing.
 *
 * @module
 */

/** Languages the extension UI speaks. */
export type UiLocale = 'en' | 'zh'

/** The UI language before settings load, and whenever the stored one is unusable. */
const DEFAULT_UI_LOCALE: UiLocale = 'en'

let uiLocale: UiLocale = DEFAULT_UI_LOCALE

/** @param value - anything a stored setting or a wire frame carried. */
export function isUiLocale(value: unknown): value is UiLocale {
  return value === 'en' || value === 'zh'
}

/**
 * Apply the user's language setting.
 *
 * Anything that is not `'en'` or `'zh'` falls back to English rather than
 * throwing: this runs on every settings load and every save, and a stored value
 * from a build with a language this one does not know must not stop the worker.
 *
 * @param value - the stored or patched `uiLanguage`.
 */
export function setUiLocale(value: unknown): void {
  uiLocale = isUiLocale(value) ? value : DEFAULT_UI_LOCALE
}

/** @returns the language the extension's own surfaces should speak. */
export function getUiLocale(): UiLocale {
  return uiLocale
}

/**
 * Read the language out of a UI-state snapshot.
 *
 * The panel and the options page are separate documents from the worker, so they
 * cannot see {@link getUiLocale}'s module state; the background carries `locale`
 * in `ui.state` instead. A snapshot that never arrived (or one from a worker too
 * old to send it) leaves the page in English.
 *
 * @param state - the snapshot, or null/undefined when none arrived.
 * @returns the language to render in.
 */
export function localeFromUiState(state: { locale?: unknown } | null | undefined): UiLocale {
  const value = state?.locale
  return isUiLocale(value) ? value : DEFAULT_UI_LOCALE
}
