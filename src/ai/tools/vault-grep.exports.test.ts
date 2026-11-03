import { describe, expect, it } from 'vitest'
import * as vaultGrep from './vault-grep'

/**
 * Export-contract lock for `~/ai/tools/vault-grep` after the mechanical
 * split into `vault-grep-constants` / `vault-grep-pattern` /
 * `vault-grep-files` / `vault-grep-execute`.
 */
describe('vault-grep export contract', () => {
	it('keeps the public functions', () => {
		expect(typeof vaultGrep.assertSafeGrepPattern).toBe('function')
		expect(typeof vaultGrep.executeVaultGrep).toBe('function')
	})

	it('keeps the public budget constants', () => {
		expect(vaultGrep.VAULT_GREP_DEFAULT_MAX_FILES).toBe(1000)
		expect(vaultGrep.VAULT_GREP_DEFAULT_MAX_TOTAL_BYTES).toBe(64 * 1024 * 1024)
		expect(vaultGrep.VAULT_GREP_DEFAULT_DEADLINE_MS).toBe(15_000)
		expect(vaultGrep.VAULT_GREP_MAX_PATTERN_LENGTH).toBe(400)
	})

	it('keeps the tool definition', () => {
		expect(vaultGrep.vaultGrepTool).toBeDefined()
	})
})
