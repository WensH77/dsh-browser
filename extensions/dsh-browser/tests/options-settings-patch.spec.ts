// @vitest-environment node
/**
 * The options form's save patch.
 *
 * The patch is what the background persists, so it is the one place where a
 * control added to the page can be forgotten: the language selector would keep
 * its choice in the form and never write it.
 */

import { describe, expect, it } from 'vitest'
import { settingsPatch } from '../src/options/settings-patch.ts'
import { SETTINGS_DEFAULTS } from '../src/shared/settings.ts'

describe('settingsPatch', () => {
  it('sends the language the selector picked', () => {
    expect(settingsPatch({ ...SETTINGS_DEFAULTS, uiLanguage: 'zh' }).uiLanguage).toBe('zh')
    expect(settingsPatch({ ...SETTINGS_DEFAULTS, uiLanguage: 'en' }).uiLanguage).toBe('en')
  })

  it('covers every field the form owns', () => {
    const patch = settingsPatch({ ...SETTINGS_DEFAULTS, bridgeUrl: ' ws://127.0.0.1:3999/ext/bridge ' })

    expect(patch.bridgeUrl).toBe('ws://127.0.0.1:3999/ext/bridge')
    expect(Object.keys(patch).sort()).toEqual([
      'allowCrossDomainNavigation',
      'allowExtensionDebug',
      'approvalNotifications',
      'blockedOrigins',
      'bridgeUrl',
      'sharePageContent',
      'statusMode',
      'token',
      'trustJsExecution',
      'trustedActionOrigins',
      'uiLanguage',
    ])
  })
})
