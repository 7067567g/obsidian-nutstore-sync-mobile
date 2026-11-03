import { describe, expect, it } from 'vitest'
import * as applyPatch from './apply-patch'

/**
 * Export-contract lock for `~/ai/tools/apply-patch` after the mechanical
 * split into `apply-patch-parse` / `apply-patch-hunks` / `apply-patch-paths`.
 */
describe('apply-patch export contract', () => {
	it('keeps the public functions and tool definition', () => {
		expect(typeof applyPatch.parsePatch).toBe('function')
		expect(typeof applyPatch.applyHunks).toBe('function')
		expect(applyPatch.applyPatchTool).toBeDefined()
	})
})
