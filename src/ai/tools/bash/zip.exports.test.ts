import { describe, expect, it } from 'vitest'
import * as zip from './zip'

/**
 * Export-contract lock for `~/ai/tools/bash/zip` after the mechanical split
 * into `zip-args` / `zip-format`.
 */
describe('bash/zip export contract', () => {
	it('keeps the public decompression limit and command list', () => {
		expect(zip.UNZIP_MAX_DECOMPRESSED_SIZE).toBe(128 * 1024 * 1024)
		expect(zip.archiveCommands).toHaveLength(2)
	})
})
