/**
 * Which Google links this extension can export.
 *
 * Only Docs (`/document/d/…`) and Sheets (`/spreadsheets/d/…`) are exported:
 * both have a clean server-side export, and the spreadsheet path feeds the
 * per-sheet CSV flow. Slides and Drive files are deliberately *not* exported —
 * they are ordinary pages to open in the controlled tab and read with the page
 * tools (snapshot, capture, dom_query), which keeps one path for "look at this
 * link" instead of two.
 *
 * @module
 */

/** Exportable Google file kinds. */
export type GdriveKind = 'docs' | 'sheets'

/** A parsed, exportable Google file link. */
export interface GdriveTarget {
  kind: GdriveKind
  id: string
  /** Server-side export URL for the default format. */
  exportUrl: string
  /** True when the default export is a binary the model cannot read as text. */
  binary: boolean
}

/** Hosts that serve either exportable kind. */
const EXPORT_HOSTS = new Set(['docs.google.com', 'spreadsheets.google.com', 'drive.google.com'])

/** What to tell the model about a link this tool does not handle. */
export const GDRIVE_UNSUPPORTED_HINT = 'google_drive_export only handles Google Docs (/document/d/…) and Sheets (/spreadsheets/d/…) links. '
  + 'For Slides, Drive files, or any other link, read it in the browser instead: browser_navigate to it, then browser_snapshot, '
  + 'browser_capture, or browser_dom_query.'

/**
 * Parse one Google link into an export target.
 *
 * @param value - raw URL from the model.
 * @returns the target, or an error message describing why it cannot be exported.
 */
export function parseGdriveExportUrl(value: string): GdriveTarget | { error: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { error: `That is not a valid URL. ${GDRIVE_UNSUPPORTED_HINT}` }
  }
  if (!EXPORT_HOSTS.has(url.hostname.toLowerCase())) {
    return { error: `Only Google Docs and Sheets links can be exported; this URL is on ${url.hostname || 'an unknown host'}. ${GDRIVE_UNSUPPORTED_HINT}` }
  }
  const id = (pattern: RegExp): string | undefined => pattern.exec(url.pathname)?.[1]
  const doc = id(/\/document\/d\/([^/?#]+)/)
  if (doc !== undefined) {
    return { kind: 'docs', id: doc, exportUrl: `https://docs.google.com/document/d/${doc}/export?format=md`, binary: false }
  }
  const sheet = id(/\/spreadsheets\/d\/([^/?#]+)/)
  if (sheet !== undefined) {
    return { kind: 'sheets', id: sheet, exportUrl: `https://docs.google.com/spreadsheets/d/${sheet}/export?format=xlsx`, binary: true }
  }
  return { error: `That link is not a Google Doc or Sheet this tool can export. ${GDRIVE_UNSUPPORTED_HINT}` }
}

/** Whether one URL is an exportable Google Doc or Sheet. */
export function isExportableGdriveUrl(value: string): boolean {
  return !('error' in parseGdriveExportUrl(value))
}
