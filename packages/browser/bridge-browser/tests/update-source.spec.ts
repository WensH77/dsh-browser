/**
 * Coverage for the update source and the command it prints.
 *
 * `browser_update` hands the user a command instead of running one, so the exact
 * string matters: a wrong mode prints a command that either downloads a second
 * copy of the repository or runs a file that is not there.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  UPDATE_RAW_BASE,
  UPDATE_REF,
  UPDATE_REPOSITORY,
  currentInstallMode,
  currentPlatform,
  repoRootDir,
  updateCommand,
} from '../src/update-source.ts'

describe('update command', () => {
  it('reruns the one-line installer for a managed install', () => {
    expect(updateCommand('managed', 'posix'))
      .toBe(`curl -fsSL ${UPDATE_RAW_BASE}/scripts/install.sh | bash`)
  })

  it('reruns the local script for a checkout', () => {
    expect(updateCommand('checkout', 'posix')).toBe('./scripts/install.sh')
  })

  it('prints the PowerShell one-liner on Windows, per mode', () => {
    expect(updateCommand('managed', 'win32'))
      .toBe(`$s="$env:TEMP\\dsh-install.ps1"; irm ${UPDATE_RAW_BASE}/scripts/install.ps1 `
        + '-OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s')
    expect(updateCommand('checkout', 'win32')).toBe('.\\scripts\\install.ps1')
  })

  it('names the same repository and branch the installers fetch from', () => {
    // The command above is only runnable while this stays true; the repository
    // slug was changed by hand once already, which is why it is asserted.
    const sh = readFileSync(new URL('../../../../scripts/install.sh', import.meta.url), 'utf8')
    const ps1 = readFileSync(new URL('../../../../scripts/install.ps1', import.meta.url), 'utf8')
    expect(sh).toContain(`REPOSITORY="${UPDATE_REPOSITORY}"`)
    expect(ps1).toContain(`$Repository = '${UPDATE_REPOSITORY}'`)
    expect(sh).toContain(`REMOTE_REF="${UPDATE_REF}"`)
    expect(ps1).toContain(`$RemoteRef = '${UPDATE_REF}'`)
    expect(UPDATE_RAW_BASE)
      .toBe(`https://raw.githubusercontent.com/${UPDATE_REPOSITORY}/refs/heads/${UPDATE_REF}`)
  })

  it('finds the repository this checkout runs from', () => {
    // Both a source run and the bundled `lib/index.js` sit one level under the
    // package, so the same walk has to hold in each.
    expect(repoRootDir()).toContain('dsh-browser')
    expect(readFileSync(`${repoRootDir()}/scripts/install.sh`, 'utf8')).toContain('dsh-browser')
    expect(['managed', 'checkout']).toContain(currentInstallMode())
    expect(['posix', 'win32']).toContain(currentPlatform())
  })
})
