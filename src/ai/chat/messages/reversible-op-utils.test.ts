import { describe, expect, it } from 'vitest'
import type { ReversibleToolOp } from '~/ai/chat/types'
import { createSkippedFileSnapshot } from './reversible-content'
import {
	copyReversibleToolOp,
	normalizeReversibleToolOpRecord,
} from './reversible-op-utils'

describe('reversible operation skipped snapshots', () => {
	it('preserves skipped content through normalization and copy', () => {
		const operation: ReversibleToolOp = {
			vaultPath: 'note.md',
			operation: 'update',
			before: createSkippedFileSnapshot(123, 'too-large'),
			after: createSkippedFileSnapshot(456, 'budget'),
		}

		const normalized = normalizeReversibleToolOpRecord(operation)
		if (normalized?.operation !== 'update') {
			throw new Error('Expected an update operation')
		}
		expect(normalized.before.skipped).toEqual({
			size: 123,
			reason: 'too-large',
		})
		expect(normalized.after?.skipped).toEqual({
			size: 456,
			reason: 'budget',
		})

		const copied = copyReversibleToolOp(operation)
		if (copied.operation !== 'update') {
			throw new Error('Expected an update operation')
		}
		expect(copied.before.skipped).toEqual({
			size: 123,
			reason: 'too-large',
		})
	})
})
