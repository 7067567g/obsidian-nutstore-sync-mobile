import { describe, expect, it } from 'vitest'
import * as vaultBatchEdit from './vault-batch-edit'

/**
 * Export-contract lock for `~/ai/tools/vault-batch-edit` after the
 * mechanical split into `vault-batch-edit-core`.
 */
describe('vault-batch-edit export contract', () => {
	it('keeps the public function and tool definition', () => {
		expect(typeof vaultBatchEdit.executeVaultBatchEdit).toBe('function')
		expect(vaultBatchEdit.vaultBatchEditTool).toBeDefined()
	})
})
