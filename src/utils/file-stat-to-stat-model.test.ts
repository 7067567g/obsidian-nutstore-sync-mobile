import { describe, expect, it } from 'vitest'
import type { FileStat } from 'webdav'
import { fileStatToStatModel } from './file-stat-to-stat-model'
import { isSameTime } from './is-same-time'

const VALID_LASTMOD = 'Wed, 01 Jan 2025 00:00:00 GMT'

function stat(overrides: Partial<FileStat>): FileStat {
	return {
		filename: '/folder/a.txt',
		basename: 'a.txt',
		lastmod: VALID_LASTMOD,
		size: 12,
		type: 'file',
		etag: null,
		mime: 'text/plain',
		...overrides,
	} as FileStat
}

describe('fileStatToStatModel lastmod fallback (A15)', () => {
	it('parses a valid HTTP Last-Modified', () => {
		const model = fileStatToStatModel(stat({}))
		const expected = Date.parse(VALID_LASTMOD)
		expect(model.mtime).toBe(expected)
		expect(model.serverMtime).toBe(expected)
		expect(Number.isNaN(model.mtime)).toBe(false)
	})

	it('treats an empty lastmod as a deterministic epoch, not NaN', () => {
		const model = fileStatToStatModel(stat({ lastmod: '' }))
		expect(Number.isNaN(model.mtime)).toBe(false)
		expect(model.mtime).toBe(0)
		expect(model.serverMtime).toBe(0)
		expect(isSameTime(model.serverMtime, 0)).toBe(true)
	})

	it('treats a missing or malformed lastmod as the epoch', () => {
		const missing = fileStatToStatModel(stat({ lastmod: undefined }))
		expect(missing.mtime).toBe(0)
		expect(missing.serverMtime).toBe(0)

		const malformed = fileStatToStatModel(stat({ lastmod: 'not-a-date' }))
		expect(malformed.mtime).toBe(0)
		expect(malformed.serverMtime).toBe(0)
	})

	it('applies the same fallback to directories', () => {
		const model = fileStatToStatModel(stat({ type: 'directory', lastmod: '' }))
		expect(model.isDir).toBe(true)
		expect(model.mtime).toBe(0)
		expect(model.serverMtime).toBe(0)
	})

	it('stays stable across repeated conversions (isSameTime true)', () => {
		const first = fileStatToStatModel(stat({ lastmod: '' }))
		const second = fileStatToStatModel(stat({ lastmod: '' }))
		expect(isSameTime(first.serverMtime, second.serverMtime)).toBe(true)
	})
})
