/**
 * User settings shared by the background worker and the options page.
 *
 * The bridge is a pure tool channel: chat and session-management settings are
 * gone. What remains is connection, sharing, and approval policy.
 *
 * @module
 */

export interface Settings {
  /** Empty = auto-discover the local dsh host. Manual URLs win when set. */
  bridgeUrl: string
  /** Empty = loopback connections skip the token (zero-config local mode). */
  token: string
  /** Whether page content may be shared without an explicit prompt. */
  sharePageContent: 'ask' | 'auto' | 'off'
  /** Origins whose state-changing actions may run without another prompt. */
  trustedActionOrigins: string[]
  /** Show an OS notification when no UI can display an approval. */
  approvalNotifications: boolean
  /** Which surface carries the persistent status view when opened. */
  statusMode: 'panel' | 'floating'
  /** Allow the agent to navigate the controlled tab to other hosts.
   * Default off: only same-host navigation is allowed (initial navigation and
   * explicit "bind to the page" are the supported ways to switch hosts).
   * Same domain with a different host (e.g. another environment) counts as
   * different. */
  allowCrossDomainNavigation: boolean
  /** Origins that must never be operated (reads or actions). */
  blockedOrigins: string[]
}

export const SETTINGS_DEFAULTS: Settings = {
  bridgeUrl: '',
  token: '',
  sharePageContent: 'auto',
  trustedActionOrigins: [],
  approvalNotifications: true,
  statusMode: 'floating',
  allowCrossDomainNavigation: false,
  blockedOrigins: [],
}

export const SETTINGS_STORAGE_KEY = 'dshSettings'
