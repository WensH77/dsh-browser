// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { LEVEL_ALWAYS, LEVEL_ASKS, LEVEL_SCOPED, LEVEL_TRUSTED, policyRails, type RailCopy } from '../src/options/rails.ts'
import { SETTINGS_DEFAULTS, type Settings } from '../src/shared/settings.ts'

const copy: RailCopy = {
  railReads: 'reads',
  railActions: 'actions',
  railJs: 'js',
  railNav: 'nav',
  readsOff: 'reads off',
  readsAsk: 'reads ask',
  readsAuto: 'reads auto',
  actionsNone: 'actions ask',
  actionsTrusted: (count) => `trusted ${count}`,
  jsOff: 'js asks',
  jsTrusted: 'js trusted',
  jsNoTrust: 'js no trust yet',
  jsDisabled: 'debugging off',
  navSame: 'same host',
  navAny: 'any host',
}

const settings = (patch: Partial<Settings> = {}): Settings => ({
  ...SETTINGS_DEFAULTS,
  // Most cases are about the consent axes, so debugging starts on.
  allowExtensionDebug: true,
  ...patch,
})

describe('policyRails', () => {
  it('fills only the axes that genuinely stop asking', () => {
    const [reads, actions, js, nav] = policyRails(settings({ sharePageContent: 'auto', allowCrossDomainNavigation: true }), copy)

    expect(reads!.level).toBe(LEVEL_ALWAYS)
    // Navigation still prompts per destination, so it can never fill the rail.
    expect(nav!.level).toBe(LEVEL_SCOPED)
    expect(actions!.level).toBe(LEVEL_ASKS)
    expect(js!.level).toBe(LEVEL_ASKS)
  })

  it('treats cross-host navigation as reach, never as consent', () => {
    const noTrust = policyRails(settings({ allowCrossDomainNavigation: true }), copy)[3]!
    const withTrust = policyRails(settings({ allowCrossDomainNavigation: true, trustedActionOrigins: ['https://a.example'] }), copy)[3]!
    const scoped = policyRails(settings({ allowCrossDomainNavigation: false, trustedActionOrigins: ['https://a.example'] }), copy)[3]!

    expect(noTrust).toMatchObject({ level: LEVEL_SCOPED, tone: 'ask' })
    expect(withTrust).toMatchObject({ level: LEVEL_TRUSTED, tone: 'ask' })
    // Same-host-only is a hard boundary, not merely a prompt.
    expect(scoped).toMatchObject({ level: LEVEL_ASKS, tone: 'deny' })
  })

  it('gives trusted origins the trusted tier, never full', () => {
    const [, actions, js] = policyRails(settings({
      trustedActionOrigins: ['https://a.example', 'https://b.example'],
      trustJsExecution: true,
    }), copy)

    expect(actions).toMatchObject({ level: LEVEL_TRUSTED, value: 'trusted 2' })
    expect(js).toMatchObject({ level: LEVEL_TRUSTED, value: 'js trusted' })
  })

  it('treats an empty trust list as no coverage, even with JS trust enabled', () => {
    const [, actions, js] = policyRails(settings({ trustJsExecution: true }), copy)

    expect(actions).toMatchObject({ level: LEVEL_ASKS, value: 'actions ask' })
    expect(js).toMatchObject({ level: LEVEL_ASKS, value: 'js no trust yet' })
  })

  it('reports the JavaScript axis as off while debugging is disabled', () => {
    const [, , js] = policyRails(settings({ allowExtensionDebug: false, trustJsExecution: true, trustedActionOrigins: ['https://a.example'] }), copy)

    expect(js).toMatchObject({ level: LEVEL_ASKS, tone: 'deny', value: 'debugging off' })
  })

  it('marks blocked reads as denied rather than merely asked about', () => {
    const [reads] = policyRails(settings({ sharePageContent: 'off' }), copy)

    expect(reads).toMatchObject({ level: LEVEL_ASKS, tone: 'deny', value: 'reads off' })
  })

  it('keeps scoped states above asks and below full', () => {
    const [reads] = policyRails(settings({ sharePageContent: 'ask' }), copy)

    expect(reads!.level).toBe(LEVEL_SCOPED)
    expect(LEVEL_ASKS).toBeLessThan(LEVEL_SCOPED)
    expect(LEVEL_SCOPED).toBeLessThan(LEVEL_TRUSTED)
    expect(LEVEL_TRUSTED).toBeLessThan(LEVEL_ALWAYS)
  })
})
