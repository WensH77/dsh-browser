// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getUiLocale, isUiLocale, localeFromUiState, setUiLocale } from '../src/i18n.ts'
import { SETTINGS_DEFAULTS } from '../src/shared/settings.ts'

/** Every test here mutates one module-level value; reset it to the shipped default. */
afterEach(() => {
  setUiLocale(SETTINGS_DEFAULTS.uiLanguage)
  vi.unstubAllGlobals()
})

describe('UI language setting', () => {
  it('ships English and ignores the browser language entirely', () => {
    // The language is a user setting, not a property of Chrome: a Chinese
    // browser profile must still get the English default until the user says
    // otherwise. The old implementation read `navigator.languages` here.
    expect(SETTINGS_DEFAULTS.uiLanguage).toBe('en')
    vi.stubGlobal('navigator', { languages: ['zh-Hant', 'en-US'], language: 'zh-CN' })
    expect(getUiLocale()).toBe('en')
  })

  it('follows setUiLocale once the setting is applied', () => {
    setUiLocale('zh')
    expect(getUiLocale()).toBe('zh')

    setUiLocale('en')
    expect(getUiLocale()).toBe('en')
  })

  it('falls back to English for any unusable stored value', () => {
    const unusable: unknown[] = ['auto', 'ZH', 'fr', '', undefined, null, 42, {}]
    for (const value of unusable) {
      setUiLocale('zh')
      setUiLocale(value)
      expect(getUiLocale(), String(value)).toBe('en')
    }
  })

  it('classifies exactly the two supported languages', () => {
    expect(isUiLocale('en')).toBe(true)
    expect(isUiLocale('zh')).toBe(true)
    expect(isUiLocale('auto')).toBe(false)
    expect(isUiLocale(undefined)).toBe(false)
  })
})

describe('locale from a UI-state snapshot', () => {
  it('takes the language the background pushed', () => {
    expect(localeFromUiState({ locale: 'zh' })).toBe('zh')
    expect(localeFromUiState({ locale: 'en' })).toBe('en')
  })

  it('falls back to English when no snapshot or no usable field arrived', () => {
    // The panel and the options page are separate documents: they cannot read
    // the worker's locale state, so a snapshot from a worker too old to send
    // `locale` (or one that never answered) must render in English.
    expect(localeFromUiState(null)).toBe('en')
    expect(localeFromUiState(undefined)).toBe('en')
    expect(localeFromUiState({})).toBe('en')
    expect(localeFromUiState({ locale: 'auto' })).toBe('en')
  })
})
