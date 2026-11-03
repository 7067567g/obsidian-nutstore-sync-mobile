import { describe, expect, it } from 'vitest'
import * as bashFs from './fs'

/**
 * Export-contract lock for `~/ai/tools/bash/fs` after the mechanical split
 * into `fs-encoding` / `fs-path-index` / `fs-permission` /
 * `fs-resource-budget` / `fs-reversible-recorder`.
 */
describe('bash/fs export contract', () => {
	it('keeps the public functions', () => {
		expect(typeof bashFs.createBashResourceBudget).toBe('function')
		expect(typeof bashFs.decodeContent).toBe('function')
		expect(typeof bashFs.encodeContent).toBe('function')
		expect(typeof bashFs.toArrayBuffer).toBe('function')
	})

	it('keeps the public classes and mount constant', () => {
		expect(typeof bashFs.BashResourceBudget).toBe('function')
		expect(typeof bashFs.ReversibleOpRecorder).toBe('function')
		expect(typeof bashFs.ObsidianVaultFs).toBe('function')
		expect(typeof bashFs.VAULT_MOUNT_POINT).toBe('string')
	})

	it('keeps the public resource-limit defaults', () => {
		expect(bashFs.BASH_DEFAULT_MAX_WRITE_BYTES).toBe(64 * 1024 * 1024)
		expect(bashFs.BASH_DEFAULT_MAX_WRITE_OPERATIONS).toBe(2000)
		expect(bashFs.BASH_DEFAULT_MAX_RECURSION_DEPTH).toBe(32)
	})
})
