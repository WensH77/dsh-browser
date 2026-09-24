/**
 * Print the Chrome extension ID implied by `extensions/dsh-browser/manifest.json`.
 *
 * Chrome derives an extension's ID from the public key in its manifest `key`
 * field: the SHA-256 of the key's SubjectPublicKeyInfo DER, first 16 bytes, with
 * every hex digit mapped onto the `a`-`p` alphabet. The bridge pins that ID
 * (`BRIDGE_EXTENSION_IDS` in the bridge protocol) so the loopback no-token
 * handshake is bound to this one extension instead of to any origin that merely
 * claims to be a `chrome-extension://` context.
 *
 * The manifest carries a `key` for exactly this reason: an unpacked extension
 * with no `key` gets an ID derived from its directory path, so the pinned value
 * would move whenever the folder moved. Public key material only — no private
 * key is kept in this repository, so the extension cannot be signed with it.
 *
 * Usage: node scripts/extension-id.mjs
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const manifestPath = fileURLToPath(new URL('../extensions/dsh-browser/manifest.json', import.meta.url))

/**
 * Derive a Chrome extension ID from a base64 SubjectPublicKeyInfo.
 * @param keyBase64 - the manifest `key` field.
 * @returns the 32-character ID.
 */
export function extensionIdFromKey(keyBase64) {
  const der = Buffer.from(keyBase64, 'base64')
  if (der.length === 0) throw new Error('the manifest key is not valid base64')
  const digest = createHash('sha256').update(der).digest().subarray(0, 16)
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .split('')
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join('')
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

if (typeof manifest.key !== 'string' || manifest.key === '') {
  console.error('extensions/dsh-browser/manifest.json has no "key" field: its ID would be derived from the directory path.')
  process.exit(1)
}

console.log(extensionIdFromKey(manifest.key))
