/**
 * Guard the two installers' encodings, because both failure modes are silent.
 *
 * `scripts/install.ps1` ships Chinese output and a handful of typographic quotes
 * that Windows PowerShell 5.1 treats as string delimiters. Without its UTF-8 BOM,
 * 5.1 decodes the file as cp1252: the Chinese turns into mojibake and a byte
 * sequence inside a double-quoted string can decode to `”`, which closes the
 * string early and breaks the whole script. The BOM is one byte pair-ish detail
 * that a tool rewriting the file will happily drop — this check has caught it
 * twice already, so it is asserted rather than trusted.
 *
 * `scripts/install.sh` is the opposite: a BOM in front of `#!/bin/bash` stops the
 * kernel from reading the shebang, so the one-line install would fail outright.
 *
 * Both files must also be valid UTF-8, so a bad merge cannot smuggle in
 * replacement characters.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const utf8 = new TextDecoder('utf-8', { fatal: true })
const problems = []

/** Decode strictly, reporting the first invalid byte instead of throwing. */
function assertUtf8(label, bytes) {
  try {
    utf8.decode(bytes)
  } catch {
    problems.push(`${label} is not valid UTF-8`)
  }
}

const ps1 = readFileSync(`${root}scripts/install.ps1`)
assertUtf8('scripts/install.ps1', ps1)
if (!ps1.subarray(0, 3).equals(BOM)) {
  problems.push('scripts/install.ps1 lost its UTF-8 BOM — Windows PowerShell 5.1 would read it as cp1252 and its Chinese output (and quote handling) would break')
}

const sh = readFileSync(`${root}scripts/install.sh`)
assertUtf8('scripts/install.sh', sh)
if (sh.subarray(0, 3).equals(BOM)) {
  problems.push('scripts/install.sh must not start with a UTF-8 BOM — it would hide the shebang and the one-line install would not run')
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`installer check: ${problem}`)
  process.exit(1)
}
console.log('installer check: install.ps1 keeps its UTF-8 BOM, install.sh starts without one, both decode as UTF-8')
