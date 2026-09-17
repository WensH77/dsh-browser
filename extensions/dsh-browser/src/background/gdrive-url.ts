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

import { GDRIVE_UNSUPPORTED_HINT, gdriveExportKind } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'

export { GDRIVE_UNSUPPORTED_HINT }

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
  const kind = gdriveExportKind(value)
  if (kind === undefined) {
    return { error: `That link is not a Google Doc or Sheet this tool can export. ${GDRIVE_UNSUPPORTED_HINT}` }
  }
  const id = (/\/(?:document|spreadsheets)\/d\/([^/?#]+)/.exec(url.pathname)?.[1]) ?? ''
  return kind === 'docs'
    ? { kind: 'docs', id, exportUrl: `https://docs.google.com/document/d/${id}/export?format=md`, binary: false }
    : { kind: 'sheets', id, exportUrl: `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, binary: true }
}

/** Whether one URL is an exportable Google Doc or Sheet. */
export function isExportableGdriveUrl(value: string): boolean {
  return !('error' in parseGdriveExportUrl(value))
}
