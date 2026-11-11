/**
 * Guard the ad-hoc skill docs under `.dsh/skills/`.
 *
 * A skill can be split across a `SKILL.md` plus sibling files reached through
 * pointers ("读 `page-failure.md`", "见第三节"). Both kinds of reference fail
 * silently: a renamed sibling leaves a pointer that still reads fine but points
 * nowhere, and a renumbered section turns "见第三节" into a wrong turn. Neither
 * shows up until an agent follows it and finds nothing, so they are asserted
 * here instead of trusted.
 *
 * Checks per skill directory:
 *   - `SKILL.md` has frontmatter, and its `name:` matches the directory name
 *   - every `<file>.md` reference resolves inside the same directory
 *   - every 「第N节」 reference matches an existing `## N、…` heading in the same file
 *   - no heading text repeats inside one file
 *   - every file ends with a newline (so `wc -l` equals the line count)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const skillsRoot = `${root}.dsh/skills`
const problems = []
const warnings = []

/** Drop fenced code blocks, so example commands are not read as references. */
function stripFences(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '')
}

function listMarkdown(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .filter((name) => statSync(`${dir}/${name}`).isFile())
    .sort()
}

function checkFrontmatter(dirName, file, text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  if (!match) {
    problems.push(`${dirName}: SKILL.md has no frontmatter block`)
    return
  }
  const name = match[1].match(/^name:\s*(\S+)\s*$/m)
  if (!name) {
    problems.push(`${dirName}: SKILL.md frontmatter has no name`)
    return
  }
  if (name[1] !== dirName) {
    problems.push(`${dirName}: SKILL.md name is "${name[1]}", expected the directory name "${dirName}"`)
  }
}

function checkPointers(dirName, file, text, known) {
  const body = stripFences(text)
  for (const [, target] of body.matchAll(/`([A-Za-z0-9._-]+\.md)`/g)) {
    if (!known.has(target)) {
      problems.push(`${dirName}/${file}: points at \`${target}\`, which does not exist in this skill directory`)
    }
  }
}

function checkSectionRefs(dirName, file, text) {
  const body = stripFences(text)
  for (const [whole, numeral] of body.matchAll(/第([一二三四五六七八九十]+)节/g)) {
    const marker = `## ${numeral}、`
    if (!body.includes(marker)) {
      problems.push(`${dirName}/${file}: "${whole}" has no matching heading "${marker}…" in this file`)
    }
  }
}

function checkHeadings(dirName, file, text) {
  const seen = new Map()
  for (const line of stripFences(text).split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    if (!heading) continue
    const label = heading[1].trim()
    const count = seen.get(label) ?? 0
    seen.set(label, count + 1)
  }
  for (const [label, count] of seen) {
    if (count > 1) problems.push(`${dirName}/${file}: heading "${label}" appears ${count} times`)
  }
}

function main() {
  for (const dirName of readdirSync(skillsRoot).sort()) {
    const dir = `${skillsRoot}/${dirName}`
    if (!statSync(dir).isDirectory()) continue

    const files = listMarkdown(dir)
    if (!files.includes('SKILL.md')) {
      problems.push(`${dirName}: no SKILL.md`)
      continue
    }
    const known = new Set(files)

    for (const file of files) {
      const text = readFileSync(`${dir}/${file}`, 'utf8')
      if (!text.endsWith('\n')) {
        problems.push(`${dirName}/${file}: does not end with a newline, so wc -l undercounts its lines`)
      }
      checkHeadings(dirName, file, text)
      checkPointers(dirName, file, text, known)
      checkSectionRefs(dirName, file, text)
      if (file === 'SKILL.md') checkFrontmatter(dirName, file, text)
    }

    // Reverse direction: a sibling nobody points at is dead weight.
    const entry = readFileSync(`${dir}/SKILL.md`, 'utf8')
    for (const file of files) {
      if (file === 'SKILL.md') continue
      if (!entry.includes(`\`${file}\``)) warnings.push(`${dirName}/${file}: no pointer from SKILL.md reaches this file`)
    }
  }
}

main()

for (const warning of warnings) console.warn(`skill check: warning: ${warning}`)
if (problems.length > 0) {
  for (const problem of new Set(problems)) console.error(`skill check: ${problem}`)
  process.exit(1)
}
console.log(`skill check: ${problems.length} problems, ${warnings.length} warnings`)
