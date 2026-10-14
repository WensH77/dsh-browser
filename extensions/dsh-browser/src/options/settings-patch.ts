/**
 * The settings fields the options form owns.
 *
 * The form edits a local draft and sends everything it owns in one
 * `settings.set`, so a field that reaches the form and not this list is
 * silently never saved. Kept separate from the component for that reason: the
 * patch is the contract the background persists, and it is testable without a
 * DOM.
 *
 * @module
 */

import type { Settings } from '../shared/settings.ts'

/**
 * Build the patch the options form saves.
 *
 * @param settings - the form's current draft.
 * @returns every field the form owns, with the same trimming the form applied.
 */
export function settingsPatch(settings: Settings): Partial<Settings> {
  return {
    bridgeUrl: settings.bridgeUrl.trim(),
    token: settings.token,
    sharePageContent: settings.sharePageContent,
    trustedActionOrigins: settings.trustedActionOrigins,
    approvalNotifications: settings.approvalNotifications,
    statusMode: settings.statusMode,
    allowCrossDomainNavigation: settings.allowCrossDomainNavigation,
    blockedOrigins: settings.blockedOrigins,
    uiLanguage: settings.uiLanguage,
    allowExtensionDebug: settings.allowExtensionDebug,
    trustJsExecution: settings.trustJsExecution,
  }
}
