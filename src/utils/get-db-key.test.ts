import { describe, expect, it } from 'vitest'
import { objectHash } from 'ohash'
import { sha256Hex } from './sha256'
import { getDBKey } from './get-db-key'
import { stdRemotePath } from './std-remote-path'

const vaultName = 'MyVault'
const remoteBaseDir = '/team/notes'

describe('getDBKey account/endpoint scoping (A20)', () => {
	it('changes when the account changes but vault/base stay equal', () => {
		const a = getDBKey(vaultName, remoteBaseDir, 'account-a', 'https://dav.x')
		const b = getDBKey(vaultName, remoteBaseDir, 'account-b', 'https://dav.x')
		expect(a).not.toBe(b)
	})

	it('changes when the endpoint changes', () => {
		const a = getDBKey(vaultName, remoteBaseDir, 'account-a', 'https://dav.x')
		const b = getDBKey(vaultName, remoteBaseDir, 'account-a', 'https://dav.y')
		expect(a).not.toBe(b)
	})

	it('is stable for the same vault/base/account/endpoint', () => {
		expect(
			getDBKey(vaultName, remoteBaseDir, 'account-a', 'https://dav.x'),
		).toBe(getDBKey(vaultName, remoteBaseDir, 'account-a', 'https://dav.x'))
	})

	it('uses the same account hash as the traversal cache key', async () => {
		const accountHash = await sha256Hex(new TextEncoder().encode('account-a'))
		expect(
			getDBKey(vaultName, remoteBaseDir, 'account-a', 'https://dav.x'),
		).toBe(
			objectHash({
				vaultName,
				remoteBaseDir: stdRemotePath(remoteBaseDir),
				accountHash,
				remoteEndpoint: 'https://dav.x',
			}),
		)
	})

	it('stays backwards compatible when no account/endpoint is available', () => {
		expect(getDBKey(vaultName, remoteBaseDir)).toBe(
			objectHash({
				vaultName,
				remoteBaseDir: stdRemotePath(remoteBaseDir),
			}),
		)
	})
})
