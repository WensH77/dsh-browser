// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isExportableGdriveUrl, parseGdriveExportUrl } from '../src/background/gdrive-url.ts'

describe('parseGdriveExportUrl', () => {
  it('accepts Docs and Sheets links, with their parameters', () => {
    expect(parseGdriveExportUrl('https://docs.google.com/document/d/DOC-ID/edit?usp=sharing')).toMatchObject({
      kind: 'docs',
      id: 'DOC-ID',
      binary: false,
    })
    expect(parseGdriveExportUrl('https://docs.google.com/spreadsheets/d/SHEET-ID/edit#gid=0')).toMatchObject({
      kind: 'sheets',
      id: 'SHEET-ID',
      binary: true,
    })
    expect(parseGdriveExportUrl('https://spreadsheets.google.com/spreadsheets/d/ALT-ID/edit')).toMatchObject({ kind: 'sheets', id: 'ALT-ID' })
  })

  it('refuses Slides and Drive files, pointing at the browser tools', () => {
    for (const url of [
      'https://docs.google.com/presentation/d/DECK-ID/edit',
      'https://drive.google.com/file/d/FILE-ID/view',
      'https://drive.google.com/uc?export=download&id=FILE-ID',
    ]) {
      const parsed = parseGdriveExportUrl(url)
      expect('error' in parsed).toBe(true)
      expect('error' in parsed ? parsed.error : '').toContain('browser_navigate')
      expect(isExportableGdriveUrl(url)).toBe(false)
    }
  })

  it('refuses other hosts and malformed URLs without pretending to export', () => {
    for (const url of ['https://example.com/document/d/x', 'not a url', 'https://docs.google.com/']) {
      const parsed = parseGdriveExportUrl(url)
      expect('error' in parsed).toBe(true)
    }
  })

  it('still recognises both exportable kinds', () => {
    expect(isExportableGdriveUrl('https://docs.google.com/document/d/a/edit')).toBe(true)
    expect(isExportableGdriveUrl('https://docs.google.com/spreadsheets/d/b/edit')).toBe(true)
  })
})
