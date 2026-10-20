/**
 * Static guardrails for the browser half of the plugin.
 *
 * `src/client/client.js` is a hand-written bundle: it is not compiled by `tsc`
 * or `tsdown`, and no test runs it — the browser's module loader is the only
 * consumer. These checks cover what can drift silently: the manifest the host
 * reads, the bundle path, the row attribute the stylesheet keys on, and the
 * route string, which is also defined in `protocol.ts`. A rename on one side
 * would otherwise surface only as a badge that never appears.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BRIDGE_BINDINGS_METHOD, BRIDGE_BINDINGS_PATH } from '../src/protocol.ts'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

interface PackageManifest {
  name?: string
  dsh?: { client?: { platform?: string } }
  exports?: Record<string, unknown>
}

describe('client bundle', () => {
  it('declares a web client entry that exists', async () => {
    const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as PackageManifest
    expect(pkg.dsh?.client?.platform).toBe('web')

    const entry = pkg.exports?.['./client']
    expect(typeof entry).toBe('string')
    // The host resolves the export relative to the package directory.
    const source = await readFile(join(packageRoot, entry as string), 'utf8')
    expect(source).toContain('window.__ModuleLoader__.load')
  })

  it('registers under the package id and polls the route the host serves', async () => {
    const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as PackageManifest
    const source = await readFile(join(packageRoot, 'src/client/client.js'), 'utf8')

    // The loader matches a bundle to its graph row by id, which is the package name.
    expect(source).toContain(`id: "${String(pkg.name)}"`)
    // Renaming the route in protocol.ts without renaming it here would leave a
    // silently 404ing poll.
    expect(source).toContain(`"${BRIDGE_BINDINGS_PATH}"`)
    // The rpc method and the HTTP route are different halves; the browser half
    // reads the route, never the socket method. (Comments may name the method.)
    expect(source).not.toContain(`method: "${BRIDGE_BINDINGS_METHOD}"`)
    // The stylesheet and the tagger share this attribute; a mismatch draws nothing.
    expect(source).toContain('data-dsh-browser-bound')
    // The badge colour keys off the row's own status dot (`data-state`), one
    // rule per state the workspace renders.
    for (const state of ['warning', 'done', 'error']) {
      expect(source).toContain(`[data-state=\\"${state}\\"]`)
    }
    expect(source).toContain('--dsw-alias-state-warn-primary')
    expect(source).toContain('--dsw-alias-state-success-primary')
    expect(source).toContain('--dsw-alias-state-error-primary')
    expect(source).toContain('exports.apply = apply')
  })
})
