import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BROWSER_TOOL_NAMES } from '../src/tools.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..')
const SKILL_ROOT = join(REPO_ROOT, '.dsh', 'skills')
// Loaded as plain JavaScript: the repository script has no build step of its own
// and the package's tsconfig only compiles `src`.
const installer = await import(join(REPO_ROOT, 'scripts', 'install-skills.mjs')) as {
  discoverRepoSkills: (sourceRoot?: string) => Array<{ name: string; source: string; installAs: string }>
  installRepoSkills: (options: { sourceRoot?: string; targetRoot: string; link?: boolean }) =>
    Array<{ name: string; status: string; backup?: string }>
  skillNameFromFrontmatter: (markdown: string) => string
}

const tempDirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skills-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Frontmatter of the one skill this repository ships. */
const slidesSkill = readFileSync(join(SKILL_ROOT, 'google-slides-via-browser', 'SKILL.md'), 'utf8')

/**
 * The repository ships advice that tells the model which tools to call. Advice
 * that names a tool which does not exist costs a failed call before the model
 * notices, and a renamed tool would leave a stale skill behind silently — so
 * every tool name the skill mentions is checked against the real tool list.
 */
describe('the skill this repository ships', () => {
  it('is discovered by name from its own frontmatter', () => {
    const skills = installer.discoverRepoSkills(SKILL_ROOT)

    expect(skills.map((skill) => skill.name)).toEqual(['google-slides-via-browser'])
    expect(installer.skillNameFromFrontmatter(slidesSkill)).toBe('google-slides-via-browser')
  })

  it('triggers outside this workspace, where only the user skill root is scanned', () => {
    const description = /^description:[ \t]*(.+)$/m.exec(slidesSkill)?.[1] ?? ''

    // The skill is linked into `<dshHome>/skills` so it also reaches sessions
    // whose cwd is in another project; the description has to name the bridge it
    // depends on, not just Slides, or it will not fire there.
    expect(description).toContain('dsh-browser')
    expect(description).toMatch(/any workspace/i)
  })

  it('names only tools that exist', () => {
    // `browser_*` is mentioned as a wildcard (it stands for the whole tool list),
    // so it is the one token that is not expected to be a tool name.
    const mentioned = new Set((slidesSkill.match(/browser_[a-z]+(?:_[a-z]+)*/g) ?? []).filter((name) => name !== 'browser_'))

    expect(mentioned.size).toBeGreaterThan(3)
    expect([...mentioned].filter((name) => !BROWSER_TOOL_NAMES.includes(name))).toEqual([])
  })

  it('points at the pointer tool rather than a hand-copied snippet', () => {
    expect(BROWSER_TOOL_NAMES).toContain('browser_click_pointer')
    const pointerSection = slidesSkill.slice(slidesSkill.indexOf('## 三、'), slidesSkill.indexOf('## 四、'))

    expect(pointerSection).toContain('browser_click_pointer')
    expect(pointerSection).toContain('"selector"')
  })
})

describe('installing the shipped skills', () => {
  const fixture = (): { sourceRoot: string; targetRoot: string } => {
    const root = tempDir()
    const sourceRoot = join(root, 'repo', '.dsh', 'skills')
    mkdirSync(join(sourceRoot, 'demo-skill'), { recursive: true })
    writeFileSync(join(sourceRoot, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: fixture\n---\n\nbody\n')
    return { sourceRoot, targetRoot: join(root, 'home', 'skills') }
  }

  it('links a skill into the user root and leaves a second run alone', () => {
    const { sourceRoot, targetRoot } = fixture()

    expect(installer.installRepoSkills({ sourceRoot, targetRoot }))
      .toEqual([{ name: 'demo-skill', status: 'installed' }])
    expect(readFileSync(join(targetRoot, 'demo-skill', 'SKILL.md'), 'utf8')).toContain('body')

    // The repo copy is the source of truth, so the installed entry must be a link
    // (a copy would drift the moment the repo file is edited).
    expect(readdirSync(targetRoot)).toEqual(['demo-skill'])
    expect(installer.installRepoSkills({ sourceRoot, targetRoot }))
      .toEqual([{ name: 'demo-skill', status: 'current' }])
  })

  it('copies instead of linking when asked, for platforms without symlinks', () => {
    const { sourceRoot, targetRoot } = fixture()

    expect(installer.installRepoSkills({ sourceRoot, targetRoot, link: false }))
      .toEqual([{ name: 'demo-skill', status: 'copied' }])
    writeFileSync(join(sourceRoot, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: fixture\n---\n\nnew body\n')
    expect(installer.installRepoSkills({ sourceRoot, targetRoot, link: false })[0]?.status).toBe('copied')

    // A copy is refreshed by re-running the installer, so it is a supported
    // fallback rather than a snapshot that silently goes stale.
    expect(readFileSync(join(targetRoot, 'demo-skill', 'SKILL.md'), 'utf8')).toContain('new body')
  })

  it('moves a colliding skill out of the scanned root, never beside the new one', () => {
    const { sourceRoot, targetRoot } = fixture()
    mkdirSync(join(targetRoot, 'demo-skill'), { recursive: true })
    writeFileSync(join(targetRoot, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: mine\n---\n')

    const [result] = installer.installRepoSkills({ sourceRoot, targetRoot })

    expect(result?.status).toBe('installed')
    // Every directory holding a SKILL.md under a scanned root becomes a catalog
    // entry, so a backup left in place would appear as a second `demo-skill`.
    expect(readdirSync(targetRoot)).toEqual(['demo-skill'])
    expect(result?.backup).toBeDefined()
    expect(result!.backup!.startsWith(`${targetRoot}/`)).toBe(false)
    expect(readFileSync(join(result!.backup!, 'SKILL.md'), 'utf8')).toContain('mine')
  })

  it('refuses a skill whose frontmatter has no name', () => {
    const { sourceRoot, targetRoot } = fixture()
    writeFileSync(join(sourceRoot, 'demo-skill', 'SKILL.md'), '---\ndescription: nameless\n---\n')

    expect(() => installer.installRepoSkills({ sourceRoot, targetRoot })).toThrow(/no "name"/)
  })

  it('ignores a nested SKILL.md the provider would not discover', () => {
    const { sourceRoot } = fixture()
    mkdirSync(join(sourceRoot, 'demo-skill', 'nested'), { recursive: true })
    writeFileSync(join(sourceRoot, 'demo-skill', 'nested', 'SKILL.md'), '---\nname: nested\ndescription: x\n---\n')

    expect(installer.discoverRepoSkills(sourceRoot).map((skill) => skill.name)).toEqual(['demo-skill'])
  })

  it('links a flat skill file as a file link', () => {
    const { sourceRoot, targetRoot } = fixture()
    writeFileSync(join(sourceRoot, 'flat-skill.md'), '---\nname: flat-skill\ndescription: flat\n---\n')

    expect(installer.installRepoSkills({ sourceRoot, targetRoot }).map((entry) => entry.name))
      .toEqual(['demo-skill', 'flat-skill'])
    expect(readFileSync(join(targetRoot, 'flat-skill.md'), 'utf8')).toContain('flat')
  })

  it('leaves an unrelated existing link alone unless it is ours', () => {
    const { sourceRoot, targetRoot } = fixture()
    const elsewhere = join(tempDir(), 'other-skill')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'SKILL.md'), '---\nname: other-skill\ndescription: other\n---\n')
    mkdirSync(targetRoot, { recursive: true })
    symlinkSync(elsewhere, join(targetRoot, 'other-skill'), 'dir')

    expect(installer.installRepoSkills({ sourceRoot, targetRoot }).map((entry) => entry.name)).toEqual(['demo-skill'])
    expect(readdirSync(targetRoot).sort()).toEqual(['demo-skill', 'other-skill'])
  })
})
