import { describe, expect, it } from 'vitest'
import {
	createSkippedFileSnapshot,
	decodeReversibleFileSnapshot,
	hasCompressedFileContent,
	isSkippedFileSnapshot,
} from './reversible-content'

describe('reversible snapshot skipping', () => {
	it('marks an oversized snapshot as skipped and refuses to decode it', async () => {
		const snapshot = createSkippedFileSnapshot(10 * 1024 * 1024, 'too-large')
		expect(isSkippedFileSnapshot(snapshot)).toBe(true)
		expect(snapshot.skipped).toEqual({
			size: 10 * 1024 * 1024,
			reason: 'too-large',
		})
		expect(hasCompressedFileContent(snapshot)).toBe(false)
		await expect(decodeReversibleFileSnapshot(snapshot)).rejects.toThrow(
			'snapshot content was not retained',
		)
	})
})
