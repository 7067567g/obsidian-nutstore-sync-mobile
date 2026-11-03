import { objectHash } from 'ohash'
import { sha256Hex } from './sha256'
import { sha256Fallback } from './sha256-fallback'
import { normalizeVaultPath } from './normalize-vault-path'
import { stdRemotePath } from './std-remote-path'

/**
 * Synchronous SHA-256 hex used for account scoping. For the short strings an
 * account id is, `sha256Hex` already resolves to exactly this fallback digest,
 * so the DB key stays byte-identical with the traversal cache key while
 * keeping `getDBKey` synchronous (callers construct it in a constructor).
 */
function accountHashSync(remoteAccountId: string) {
	return Array.from(
		new Uint8Array(sha256Fallback(new TextEncoder().encode(remoteAccountId))),
	)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

/**
 * Sync record key for a vault/remote base directory. Account id and endpoint
 * are folded in (hashed/normalized the same way as the traversal cache key) so
 * switching accounts while `vaultName + remoteBaseDir` stay the same does not
 * reuse another account's `sync_record`.
 */
export function getDBKey(
	vaultName: string,
	remoteBaseDir: string,
	remoteAccountId?: string,
	remoteEndpoint?: string,
) {
	return objectHash({
		vaultName,
		remoteBaseDir: stdRemotePath(remoteBaseDir),
		...(remoteAccountId
			? { accountHash: accountHashSync(remoteAccountId) }
			: {}),
		...(remoteEndpoint ? { remoteEndpoint } : {}),
	})
}

export async function getTraversalWebDAVDBKey(
	remoteAccountId: string,
	remoteEndpoint: string,
	remoteBaseDir: string,
) {
	return objectHash({
		remoteEndpoint,
		accountHash: await sha256Hex(new TextEncoder().encode(remoteAccountId)),
		remoteBaseDir: normalizeVaultPath(remoteBaseDir),
	})
}
