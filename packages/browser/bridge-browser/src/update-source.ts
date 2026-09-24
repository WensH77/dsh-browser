/**
 * Where this installation comes from, and the command that updates it.
 *
 * `browser_update` prints that command and never runs it: the installer writes
 * into `~/.dsh`, rewrites a browser-loaded directory, and its first run needs a
 * click in Chrome, so executing it is the user's call and not a tool's side
 * effect. Keeping the command in one pure function also means the tool, the
 * installers, and the READMEs can be checked against each other — see
 * `scripts/check-installers.mjs`, which fails when the repository slug drifts
 * apart between them.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Repository the installers are fetched from.
 *
 * Must stay identical to `REPOSITORY` in `scripts/install.sh` and `$Repository`
 * in `scripts/install.ps1`; `scripts/check-installers.mjs` asserts that.
 */
export const UPDATE_REPOSITORY = 'WensH77/dsh-browser'

/** Branch the installers are fetched from (install.sh's `REMOTE_REF`). */
export const UPDATE_REF = 'main'

/** Base URL of the raw installer files for {@link UPDATE_REF}. */
export const UPDATE_RAW_BASE = `https://raw.githubusercontent.com/${UPDATE_REPOSITORY}/refs/heads/${UPDATE_REF}`

/** How this plugin was installed. */
export type InstallMode = 'managed' | 'checkout'

/** Which shell the user is in, as far as the installer command is concerned. */
export type UpdatePlatform = 'posix' | 'win32'

/**
 * The exact command that updates this installation.
 *
 * A managed install (the one-line installer copied the repository into
 * `~/.dsh/dsh-browser`) is updated by rerunning that same one-liner; a checkout
 * is updated by rerunning the script in place. Printing the other one would
 * either pull a second copy of the repository or run a file that is not there,
 * which is why the mode is part of the answer rather than a footnote.
 *
 * @param mode - how this plugin was installed.
 * @param platform - platform whose installer command to print.
 * @returns one runnable command line.
 */
export function updateCommand(mode: InstallMode, platform: UpdatePlatform): string {
  if (platform === 'win32') {
    return mode === 'managed'
      ? '$s="$env:TEMP\\dsh-install.ps1"; irm ' + `${UPDATE_RAW_BASE}/scripts/install.ps1`
        + ' -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s'
      : '.\\scripts\\install.ps1'
  }
  return mode === 'managed'
    ? `curl -fsSL ${UPDATE_RAW_BASE}/scripts/install.sh | bash`
    : './scripts/install.sh'
}

/** The platform whose installer command this process should print. */
export function currentPlatform(): UpdatePlatform {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

/**
 * Repository root this plugin is running from, found by walking up.
 *
 * The walk looks for the installers rather than counting `..` segments so it
 * works from source (`src/`) and from the bundle (`lib/`) without knowing which
 * one this is; the fallback keeps the printed command a plausible relative path
 * instead of throwing when neither marker is found.
 *
 * @returns absolute path of the repository root guess.
 */
export function repoRootDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(dir, 'scripts', 'install.sh'))) return dir
    dir = dirname(dir)
  }
  return fileURLToPath(new URL('../../../..', import.meta.url))
}

/**
 * Which install this process is running from.
 *
 * `install.sh` drops `.managed-by-install-sh` only in the copy it manages under
 * `~/.dsh`, so the marker answers the question without a config file of our own.
 *
 * @returns `managed` for a copy the installer owns, else `checkout`.
 */
export function currentInstallMode(): InstallMode {
  return existsSync(join(repoRootDir(), '.managed-by-install-sh')) ? 'managed' : 'checkout'
}
