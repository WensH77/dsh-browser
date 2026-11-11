/**
 * Guard the error strings the shipped skills quote.
 *
 * A skill's job is often "paste this message into the tool result and say what it
 * means". The message lives in the bridge source and the quote lives in markdown,
 * so a reworded message leaves the skill pointing at text no user will ever see —
 * silently, because nothing reads both sides. This check does.
 *
 * It pulls every backticked English phrase out of `.dsh/skills/**.md`, keeps the
 * ones that read like a message, and requires each to appear in the bridge's
 * source or tests (a template with `${…}` is matched on its literal words).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const skillRoot = `${root}.dsh/skills`
const searchRoots = [
  'packages/browser/bridge-browser/extension',
  'packages/browser/bridge-browser/src',
  'packages/browser/bridge-browser/tests',
  'extensions/dsh-browser/src',
  'extensions/dsh-browser/tests',
]

/**
 * Phrases that are not bridge messages: commands the skill teaches, tool-call
 * examples, text belonging to the host or to an arbitrary web page.
 */
const NOT_A_BRIDGE_MESSAGE = [
  'CGEventCreateMouseEvent',
  'CGEventPost',
  'screencapture',
  'curl -',
  'osascript',
  'browser_',
  'sharePageContent',
  'Checking your browser',
  'Just a moment',
  'slides selected', // Google Slides import dialog, rendered by the page
  'Approval prompts are disabled in this session', // the host's own wording, not this repo's
]

const problems = []
const corpus = []

function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.isFile() && /\.(ts|js|mjs|json)$/.test(entry.name)) corpus.push(readFileSync(path, 'utf8'))
  }
}

function markdownFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...markdownFiles(path))
    else if (entry.name.endsWith('.md')) out.push(path)
  }
  return out
}

/** The longest run of plain English words, which is what the source quotes verbatim. */
function fragmentOf(phrase) {
  // Placeholders (`<url>`, `(net::ERR_…)`, `tab N`) are filled in by the source,
  // so they are dropped before matching.
  const cleaned = phrase
    .replace(/<[^>]*>/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/…/g, ' ')
    .replace(/\bN\b/g, ' ')
  const runs = cleaned.match(/[A-Za-z][A-Za-z ,'-]{9,}/g) ?? []
  const best = runs.map((run) => run.trim()).sort((a, b) => b.length - a.length)[0] ?? ''
  // A single token is a name (code, an API), not a sentence to look up.
  return best.length >= 10 && best.includes(' ') ? best : ''
}

for (const searchRoot of searchRoots) walk(join(root, searchRoot))

for (const file of markdownFiles(skillRoot)) {
  const text = readFileSync(file, 'utf8')
  for (const [, phrase] of text.matchAll(/`([^`\n]{15,})`/g)) {
    const candidate = phrase.trim()
    if (!candidate.includes(' ')) continue
    const ascii = [...candidate].filter((ch) => ch.charCodeAt(0) < 128).length / candidate.length
    if (ascii < 0.9) continue
    if (NOT_A_BRIDGE_MESSAGE.some((skip) => candidate.includes(skip))) continue
    const fragment = fragmentOf(candidate)
    if (fragment === '') continue
    if (!corpus.some((source) => source.includes(fragment))) {
      problems.push(`${file.slice(root.length)}: quotes "${candidate.slice(0, 60)}…", but "${fragment}" is in no bridge source or test`)
    }
  }
}

if (problems.length > 0) {
  for (const problem of new Set(problems)) console.error(`skill strings: ${problem}`)
  process.exit(1)
}
console.log('skill strings: every quoted message still exists in the bridge source')
