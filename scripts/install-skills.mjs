/**
 * Install the skills this repository ships into the user's DSH skill root.
 *
 * The repository is the source of truth: `scripts/install.sh` installs the
 * plugin and the extension, and the skills under `.dsh/skills` are part of the
 * same distribution. They live in the repo so a change to browser behaviour and
 * the advice about that behaviour are reviewed and committed together, but the
 * repo copy alone only reaches sessions whose cwd is inside the repo — the skill
 * filesystem provider scans `<projectRoot>/.dsh/skills` at rank 100 and the
 * user's `<dshHome>/skills` at rank 400 (see
 * `@deepseek-ai/dsh-skill-filesystem`). Linking them into the user root is what
 * makes a browser skill reachable from every other workspace.
 *
 * A symlink is the default on platforms that have one, so later edits in the
 * repo take effect immediately and cannot drift from an installed copy. Copying
 * is available for Windows-style environments where creating a link needs
 * privileges.
 *
 * Usage: node scripts/install-skills.mjs [--copy]
 */

import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Where the repository keeps the skills it ships. */
export const SKILL_SOURCE_ROOT = join(REPO_ROOT, '.dsh', 'skills')

/**
 * Resolve the user-level DSH home the same way the installer does.
 *
 * @param env - environment variables to read (`DSH_HOME` overrides the default).
 * @returns the absolute DSH home directory.
 */
export function dshHomeFromEnv(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured === '' ? join(homedir(), '.dsh') : resolve(configured)
}

/**
 * Read the `name` field out of a skill's YAML frontmatter.
 *
 * The skill provider names a catalog entry from this field, not from the
 * directory, so a missing or empty name would install a skill under a name that
 * does not match the path it was linked to.
 *
 * @param markdown - the file contents.
 * @returns the declared name, or `''` when there is no usable frontmatter.
 */
export function skillNameFromFrontmatter(markdown) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  const match = block === null ? null : /^name:[ \t]*(.+?)[ \t]*$/m.exec(block[1])
  return match === null ? '' : match[1].replace(/^['"]|['"]$/g, '')
}

/**
 * List the skills the repository ships.
 *
 * A skill is a directory bundle (`<name>/SKILL.md`) or a flat `<name>.md` at the
 * top level of the source root — nested `SKILL.md` files are not discovered by
 * the provider and are not installed. A flat skill keeps its `.md` suffix when
 * installed, because the provider reads a flat skill's name from its filename
 * rather than from its frontmatter; a mismatch between the two would install a
 * file that is never discovered, so it is rejected here.
 *
 * @param sourceRoot - directory holding the repository's skills.
 * @returns one `{ name, source, installAs }` entry per skill, sorted by install name.
 */
export function discoverRepoSkills(sourceRoot = SKILL_SOURCE_ROOT) {
  if (!existsSync(sourceRoot)) return []
  const skills = []
  const entries = readdirSync(sourceRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const bundle = entry.isDirectory() ? join(sourceRoot, entry.name, 'SKILL.md') : join(sourceRoot, entry.name)
    if (!entry.isDirectory() && !entry.name.endsWith('.md')) continue
    if (!existsSync(bundle)) continue
    const name = skillNameFromFrontmatter(readFileSync(bundle, 'utf8'))
    if (name === '') throw new Error(`${bundle} has no "name" in its YAML frontmatter; the skill provider would not discover it.`)
    if (entry.isDirectory()) {
      skills.push({ name, source: join(sourceRoot, entry.name), installAs: name })
      continue
    }
    const fileBase = entry.name.slice(0, -'.md'.length)
    if (fileBase !== name) {
      throw new Error(`${bundle} declares name "${name}" but a flat skill is discovered as "${fileBase}"; rename the file or its frontmatter name.`)
    }
    skills.push({ name, source: bundle, installAs: `${name}.md` })
  }
  return skills.sort((a, b) => a.installAs.localeCompare(b.installAs))
}

/**
 * Read the target of an installed skill link, resolved against its own directory.
 *
 * @param target - the installed path.
 * @returns the absolute link target, or `undefined` when it is not a symlink.
 */
function linkTargetOf(target) {
  const stats = lstatSync(target, { throwIfNoEntry: false })
  if (stats === undefined || !stats.isSymbolicLink()) return undefined
  return resolve(dirname(target), readlinkSync(target))
}

/**
 * Install every repository skill into a DSH skills root, replacing what is there.
 *
 * A previous install of the same skill is replaced in place. Anything else that
 * already owns the name — a hand-written skill, or an install from another
 * checkout — is moved to `<dshHome>/skill-backups/<timestamp>/<name>` first. It
 * cannot stay beside the new install: every directory holding a `SKILL.md` under
 * a scanned root is discovered, so a `.backup-*` sibling would show up as a
 * second skill with the same name.
 *
 * @param options - `sourceRoot`, `targetRoot`, and `link` (symlink when true, copy when false).
 * @returns one `{ name, status, backup? }` entry per skill: `installed`, `current`, or `copied`.
 */
export function installRepoSkills({ sourceRoot = SKILL_SOURCE_ROOT, targetRoot, link = true } = {}) {
  if (targetRoot === undefined) throw new Error('installRepoSkills needs a targetRoot')
  const skills = discoverRepoSkills(sourceRoot)
  if (skills.length === 0) return []
  mkdirSync(targetRoot, { recursive: true })

  const results = []
  for (const skill of skills) {
    const target = join(targetRoot, skill.installAs)
    let backup
    if (existsSync(target)) {
      if (linkTargetOf(target) === resolve(skill.source)) {
        results.push({ name: skill.name, status: 'current' })
        continue
      }
      backup = join(dirname(targetRoot), 'skill-backups', new Date().toISOString().replace(/[-:]|\..+$/g, ''), skill.installAs)
      mkdirSync(dirname(backup), { recursive: true })
      renameSync(target, backup)
    }
    if (link) symlinkSync(relative(targetRoot, skill.source), target, skill.installAs.endsWith('.md') ? 'file' : 'dir')
    else cpSync(skill.source, target, { recursive: true })
    results.push({ name: skill.name, status: link ? 'installed' : 'copied', ...(backup === undefined ? {} : { backup }) })
  }
  return results
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const targetRoot = join(dshHomeFromEnv(), 'skills')
  const results = installRepoSkills({ targetRoot, link: !process.argv.includes('--copy') })
  if (results.length === 0) {
    console.log(`没有可安装的技能 / no skills found under ${SKILL_SOURCE_ROOT}`)
  } else {
    console.log(`安装技能到 ${targetRoot} / installing skills into ${targetRoot}`)
    for (const { name, status, backup } of results) {
      console.log(`  ${name} — ${status}${backup === undefined ? '' : ` (原内容备份到 / previous content moved to ${backup})`}`)
    }
  }
}
