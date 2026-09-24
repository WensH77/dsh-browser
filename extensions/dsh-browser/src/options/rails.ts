/**
 * The consent ledger's four rails.
 *
 * Length is a *qualitative step*, not a score: it answers "how much runs
 * without asking". Full is reserved for an axis that genuinely never asks
 * anywhere, so a capability that still prompts on untrusted sites tops out at
 * the trusted tier — which is why page actions and JavaScript never fill the
 * rail even when their settings are enabled.
 *
 * @module
 */

import type { Settings } from '../shared/settings.ts'

/** One policy axis. */
export interface Rail {
  label: string
  value: string
  /** 0–1; drives the filled portion of the track. */
  level: number
  /** What the colour means: allowed outright, asked about, or refused. */
  tone: 'allow' | 'ask' | 'deny'
}

/** The strings one rail needs; supplied by the page so this stays locale-free. */
export interface RailCopy {
  railReads: string
  railActions: string
  railJs: string
  railNav: string
  readsOff: string
  readsAsk: string
  readsAuto: string
  actionsNone: string
  actionsTrusted: (count: number) => string
  jsOff: string
  jsTrusted: string
  jsNoTrust: string
  jsDisabled: string
  navSame: string
  navAny: string
}

/** Asks (or refuses) on every call. */
export const LEVEL_ASKS = 0.08
/** Allowed but scoped, or asked about on reads only. */
export const LEVEL_SCOPED = 0.45
/** Covered by origin trust: no asking there, still asking everywhere else. */
export const LEVEL_TRUSTED = 0.7
/** Never asks, on any site. */
export const LEVEL_ALWAYS = 1

/**
 * Derive the four rails from the settings the user is editing right now.
 *
 * @param settings - current form state (not necessarily saved).
 * @param copy - localized labels.
 * @returns one rail per consent axis, in reading order.
 */
export function policyRails(settings: Settings, copy: RailCopy): Rail[] {
  const trusted = settings.trustedActionOrigins.length
  const jsCovered = settings.allowExtensionDebug && settings.trustJsExecution && trusted > 0
  return [
    {
      label: copy.railReads,
      value: settings.sharePageContent === 'off' ? copy.readsOff : settings.sharePageContent === 'ask' ? copy.readsAsk : copy.readsAuto,
      level: settings.sharePageContent === 'off' ? LEVEL_ASKS : settings.sharePageContent === 'ask' ? LEVEL_SCOPED : LEVEL_ALWAYS,
      tone: settings.sharePageContent === 'off' ? 'deny' : settings.sharePageContent === 'ask' ? 'ask' : 'allow',
    },
    {
      label: copy.railActions,
      value: trusted === 0 ? copy.actionsNone : copy.actionsTrusted(trusted),
      level: trusted === 0 ? LEVEL_ASKS : LEVEL_TRUSTED,
      tone: 'ask',
    },
    {
      label: copy.railJs,
      value: !settings.allowExtensionDebug
        ? copy.jsDisabled
        : !settings.trustJsExecution ? copy.jsOff : trusted === 0 ? copy.jsNoTrust : copy.jsTrusted,
      level: jsCovered ? LEVEL_TRUSTED : LEVEL_ASKS,
      tone: settings.allowExtensionDebug ? 'ask' : 'deny',
    },
    {
      label: copy.railNav,
      // Allowing other hosts widens what is *reachable*; it does not stop the
      // per-destination prompt, so this axis never reaches the full rail.
      value: settings.allowCrossDomainNavigation ? copy.navAny : copy.navSame,
      level: settings.allowCrossDomainNavigation ? (trusted === 0 ? LEVEL_SCOPED : LEVEL_TRUSTED) : LEVEL_ASKS,
      tone: settings.allowCrossDomainNavigation ? 'ask' : 'deny',
    },
  ]
}
