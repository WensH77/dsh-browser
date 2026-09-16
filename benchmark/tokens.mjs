#!/usr/bin/env node
/**
 * Token accounting for the browser tools, straight from local session logs.
 *
 * Sums what each `browser_*` tool actually put into the model's context
 * (characters, with images counted as a rough token-equivalent) and reports how
 * much page text was sent twice. Use it before and after a change that claims
 * to save tokens: same tasks, same model, lower totals, unchanged success.
 *
 * Usage:
 *   node benchmark/tokens.mjs [--project dsh-browser] [--days 7] [--json]
 *
 * Sessions live at `$DSH_HOME/sessions/<cwd-slug>/<session-id>/session.v3.jsonl.zstd`
 * and need `zstd` on PATH (`brew install zstd`).
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Characters per token, for the rough totals this script prints. */
const CHARS_PER_TOKEN = 4
/** Token-equivalent charged for one attached screenshot. */
const IMAGE_CHARS = 1_500
/** Results smaller than this are status lines, not page text. */
const PAGE_TEXT_MIN_CHARS = 400

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const project = flag('project', 'dsh-browser')
const days = Number(flag('days', '7'))
const asJson = args.includes('--json')

const sessionsRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000

/** Every session log for a matching workspace, newest first. */
function sessionLogs() {
  if (!existsSync(sessionsRoot)) return []
  const found = []
  for (const workspace of readdirSync(sessionsRoot)) {
    if (!workspace.includes(project)) continue
    const workspaceDir = join(sessionsRoot, workspace)
    for (const session of readdirSync(workspaceDir)) {
      const log = join(workspaceDir, session, 'session.v3.jsonl.zstd')
      if (existsSync(log)) found.push(log)
    }
  }
  return found
}

function readLog(path) {
  try {
    return execFileSync('zstd', ['-dc', path], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8')
  } catch {
    return ''
  }
}

const perTool = new Map()
let pageCharsSent = 0
let pageCharsRepeated = 0
let sessions = 0
let totalChars = 0

for (const log of sessionLogs()) {
  let mtimeMs = 0
  try {
    mtimeMs = Number(execFileSync('stat', ['-f', '%m', log]).toString().trim()) * 1_000
  } catch {
    mtimeMs = 0
  }
  if (mtimeMs !== 0 && mtimeMs < cutoffMs) continue

  const names = new Map()
  const seenPageText = new Set()
  let sessionUsed = false
  let sessionPageChars = 0

  for (const line of readLog(log).split('\n')) {
    if (line === '') continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const data = entry.data ?? {}
    if (entry.type === 'tool/call') {
      names.set(data.callId, data.name)
      continue
    }
    if (entry.type !== 'tool/result') continue
    const name = names.get(data.message?.source?.callId)
    if (typeof name !== 'string' || !name.startsWith('browser_')) continue

    for (const block of data.message?.content ?? []) {
      if (block.type !== 'tool-result') continue
      const text = (block.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join(' ')
      const images = (block.content ?? []).filter((part) => part.type === 'image').length
      const chars = text.length + images * IMAGE_CHARS
      const stat = perTool.get(name) ?? { calls: 0, chars: 0, errors: 0, max: 0 }
      stat.calls += 1
      stat.chars += chars
      stat.max = Math.max(stat.max, chars)
      if (block.isError === true) stat.errors += 1
      perTool.set(name, stat)
      totalChars += chars
      sessionUsed = true

      const pageText = stripStatusPrefix(text)
      if (pageText.length >= PAGE_TEXT_MIN_CHARS) {
        sessionPageChars += pageText.length
        const digest = createHash('sha256').update(pageText).digest('hex')
        if (seenPageText.has(digest)) pageCharsRepeated += pageText.length
        else seenPageText.add(digest)
      }
    }
  }

  if (sessionUsed) {
    sessions += 1
    pageCharsSent += sessionPageChars
  }
}

/** Drop the envelope and status lines that legitimately differ between reads. */
function stripStatusPrefix(text) {
  const withoutNonce = text.replace(/nonce="[^"]+"/g, '')
  const anchored = /(?:Page change v\d+[\s\S]*?)?(Interactive elements:|Main content:)/.exec(withoutNonce)
  return anchored === null ? '' : withoutNonce.slice(anchored.index)
}

const rows = [...perTool.entries()]
  .map(([name, stat]) => ({ name, ...stat, share: totalChars === 0 ? 0 : stat.chars / totalChars }))
  .sort((a, b) => b.chars - a.chars)

if (asJson) {
  console.log(JSON.stringify({
    project,
    days,
    sessions,
    totalChars,
    totalTokens: Math.round(totalChars / CHARS_PER_TOKEN),
    pageCharsSent,
    pageCharsRepeated,
    repeatRate: pageCharsSent === 0 ? 0 : pageCharsRepeated / pageCharsSent,
    tools: rows,
  }, null, 2))
} else {
  console.log(`project=${project} days=${days} sessions=${sessions}`)
  console.log('tool                      calls    chars   share     max   errors')
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(24)} ${String(row.calls).padStart(5)} ${String(row.chars).padStart(8)} `
      + `${(row.share * 100).toFixed(1).padStart(6)}% ${String(row.max).padStart(7)} ${String(row.errors).padStart(7)}`,
    )
  }
  console.log(`TOTAL ${totalChars} chars ≈ ${Math.round(totalChars / CHARS_PER_TOKEN)} tokens`)
  const repeat = pageCharsSent === 0 ? 0 : (100 * pageCharsRepeated) / pageCharsSent
  console.log(`page text sent ${pageCharsSent} chars; repeated verbatim ${pageCharsRepeated} (${repeat.toFixed(1)}%)`)
}
