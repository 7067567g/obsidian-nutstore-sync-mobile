import { expect } from 'vitest'
import { type IntelligentMergeParams } from './merge-utils'

export function expectAutoMerged(
	result: { success: boolean; mergedText?: string },
	params: IntelligentMergeParams,
	requiredFragments: readonly string[],
) {
	expect(result.success).toBe(true)
	expect(typeof result.mergedText).toBe('string')
	expect(result.mergedText).not.toBe('')
	expect(result.mergedText).not.toBe(params.baseContentText)
	expect(result.mergedText).not.toBe(params.localContentText)
	expect(result.mergedText).not.toBe(params.remoteContentText)
	expect(result.mergedText).not.toContain('<<<<<<<')
	for (const fragment of requiredFragments) {
		expect(result.mergedText).toContain(fragment)
	}
}
