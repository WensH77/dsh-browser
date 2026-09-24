/**
 * Declarative Net Request rules for the controlled tab: block requests, and
 * rewrite request/response headers.
 *
 * Rules are *session* rules, so they vanish with the browser session, and they
 * carry `tabIds`, so they never affect the user's other tabs. Bookkeeping lives
 * in `chrome.storage.session` because the service worker can restart while the
 * rules stay live; every mutation reads it back before writing.
 *
 * Response *bodies* cannot be replaced here — DNR has no such action — that is
 * `browser_network`'s CDP path.
 *
 * @module
 */

/** One header change requested by the model. */
export interface HeaderChange {
  header: string
  operation: 'set' | 'append' | 'remove'
  value?: string
}

/** Bookkeeping for the rules this extension installed, keyed by the controlled tab. */
interface RuleRecord {
  id: number
  tabId: number
  kind: 'block' | 'headers'
}

const STORAGE_KEY = 'dshNetRules'
/** First rule id handed out; ids must be unique within the extension. */
const RULE_ID_BASE = 10_000

async function readRecords(): Promise<RuleRecord[]> {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY)
    const value = stored[STORAGE_KEY]
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is RuleRecord =>
      typeof entry === 'object' && entry !== null
      && typeof (entry as RuleRecord).id === 'number'
      && typeof (entry as RuleRecord).tabId === 'number'
      && ((entry as RuleRecord).kind === 'block' || (entry as RuleRecord).kind === 'headers'))
  } catch {
    return []
  }
}

async function writeRecords(records: RuleRecord[]): Promise<void> {
  await chrome.storage.session.set({ [STORAGE_KEY]: records })
}

export function parseHeaderChanges(value: unknown): HeaderChange[] | undefined {
  if (!Array.isArray(value)) return undefined
  const changes: HeaderChange[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined
    const change = item as { header?: unknown; operation?: unknown; value?: unknown }
    if (typeof change.header !== 'string' || change.header.trim() === '') return undefined
    if (change.operation !== 'set' && change.operation !== 'append' && change.operation !== 'remove') return undefined
    if (change.operation !== 'remove' && typeof change.value !== 'string') return undefined
    changes.push({
      header: change.header,
      operation: change.operation,
      ...typeof change.value === 'string' ? { value: change.value } : {},
    })
  }
  return changes.length === 0 ? undefined : changes
}

function toModifyHeaderInfo(changes: HeaderChange[]): chrome.declarativeNetRequest.ModifyHeaderInfo[] {
  return changes.map((change) => ({
    header: change.header,
    // The enum's runtime values are these exact strings.
    operation: change.operation as unknown as chrome.declarativeNetRequest.HeaderOperation,
    ...change.value === undefined ? {} : { value: change.value },
  }))
}

async function nextRuleId(records: RuleRecord[]): Promise<number> {
  const highest = records.reduce((max, record) => Math.max(max, record.id), RULE_ID_BASE - 1)
  return highest + 1
}

/** Add one rule and record it; the model's pattern is a DNR `urlFilter`. */
async function addRule(
  tabId: number,
  rule: Omit<chrome.declarativeNetRequest.Rule, 'id'>,
  kind: RuleRecord['kind'],
): Promise<number> {
  const records = await readRecords()
  const id = await nextRuleId(records)
  await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ ...rule, id }] })
  records.push({ id, tabId, kind })
  await writeRecords(records)
  return id
}

/**
 * Install one block rule for the controlled tab.
 *
 * @param tabId - the controlled tab the rule is scoped to.
 * @param pattern - DNR `urlFilter` (supports `*` wildcards and `||` domain anchors).
 * @param resourceTypes - optional resource-type restriction.
 * @returns the rule id.
 */
export async function addBlockRule(tabId: number, pattern: string, resourceTypes?: string[]): Promise<number> {
  return addRule(tabId, {
    priority: 1,
    action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      urlFilter: pattern,
      tabIds: [tabId],
      ...resourceTypes === undefined ? {} : { resourceTypes: resourceTypes as chrome.declarativeNetRequest.ResourceType[] },
    },
  }, 'block')
}

/**
 * Install one header-rewrite rule for the controlled tab.
 *
 * @param tabId - the controlled tab the rule is scoped to.
 * @param pattern - DNR `urlFilter`.
 * @param requestHeaders - changes applied to the outgoing request.
 * @param responseHeaders - changes applied to the response.
 * @returns the rule id.
 */
export async function addHeaderRule(
  tabId: number,
  pattern: string,
  requestHeaders: HeaderChange[] | undefined,
  responseHeaders: HeaderChange[] | undefined,
): Promise<number> {
  return addRule(tabId, {
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      ...requestHeaders === undefined ? {} : { requestHeaders: toModifyHeaderInfo(requestHeaders) },
      ...responseHeaders === undefined ? {} : { responseHeaders: toModifyHeaderInfo(responseHeaders) },
    },
    condition: { urlFilter: pattern, tabIds: [tabId] },
  }, 'headers')
}

/** Remove every rule this extension installed for one tab. */
export async function clearTabRules(tabId: number): Promise<number> {
  const records = await readRecords()
  const mine = records.filter((record) => record.tabId === tabId)
  if (mine.length > 0) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: mine.map((record) => record.id) })
  }
  await writeRecords(records.filter((record) => record.tabId !== tabId))
  return mine.length
}

/** Rules this extension currently holds for one tab (for reporting). */
export async function listTabRules(tabId: number): Promise<RuleRecord[]> {
  return (await readRecords()).filter((record) => record.tabId === tabId)
}
