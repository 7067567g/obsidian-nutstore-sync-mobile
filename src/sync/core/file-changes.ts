import type { StatModel } from '~/model/stat.model'
import { isSameTime } from '~/utils/is-same-time'
import type {
	SyncDecisionInput,
	SyncRecordItem,
} from '../decision/sync-decision.interface'

function remoteTime(stat: StatModel) {
	return stat.serverMtime ?? stat.mtime
}

export function getRemoteFileChanged(
	remote: StatModel,
	recordedRemote: StatModel,
) {
	if (recordedRemote.etag && remote.etag) {
		return recordedRemote.etag !== remote.etag
	}
	return !isSameTime(remoteTime(remote), remoteTime(recordedRemote))
}

/** All policies use the same evidence: content hashes/ETags first, then
 * server-provided timestamps. Planning never downloads remote content.
 */
export async function getFileChanges(
	input: SyncDecisionInput,
	local: Extract<StatModel, { isDir: false }>,
	remote: Extract<StatModel, { isDir: false }>,
	record: SyncRecordItem,
): Promise<{ localChanged: boolean; remoteChanged: boolean }> {
	const localMtimeChanged = !isSameTime(local.mtime, record.local.mtime)
	const bothRemoteEtags = !!(record.remote.etag && remote.etag)
	const remoteEtagsDiffer =
		bothRemoteEtags && record.remote.etag !== remote.etag
	const remoteChanged = getRemoteFileChanged(remote, record.remote)

	let localChanged = localMtimeChanged
	const recordedLocalHash = record.local.isDir ? undefined : record.local.hash
	const recordedLocalSize = record.local.isDir ? undefined : record.local.size
	let contentCheck = 'mtime-unchanged'
	if (localMtimeChanged) {
		contentCheck = 'no-base'
		const recordedHash = recordedLocalHash ?? record.base?.hash
		if (local.size !== recordedLocalSize) {
			localChanged = true
			contentCheck = 'size-differs'
		} else if (recordedHash && input.getLocalContentHash) {
			try {
				const currentHash = await input.getLocalContentHash(local.path)
				if (currentHash) {
					localChanged = currentHash !== recordedHash
					contentCheck = localChanged
						? 'content-hash-differs'
						: 'content-hash-equal'
				} else {
					contentCheck = 'hash-unavailable'
				}
			} catch {
				contentCheck = 'hash-failed'
			}
		} else if (record.base?.key && !record.local.isDir) {
			contentCheck = 'base-unavailable'
			const base = await input.getBaseContent(record.base.key)
			if (base) {
				localChanged = !(await input.compareFileContent(local.path, base))
				contentCheck = localChanged ? 'content-differs' : 'content-equal'
			}
		}
	}
	if (localMtimeChanged || remoteChanged) {
		input.logger.debug({
			reason: 'recorded file change evaluation',
			localPath: local.path,
			local: { mtime: local.mtime, size: local.size },
			remote: {
				mtime: remote.mtime,
				serverMtime: remote.serverMtime,
				etag: remote.etag,
				size: remote.size,
			},
			recordedLocal: {
				mtime: record.local.mtime,
				size: record.local.isDir ? undefined : record.local.size,
				hash: recordedLocalHash,
			},
			recordedRemote: {
				mtime: record.remote.mtime,
				serverMtime: record.remote.serverMtime,
				etag: record.remote.etag,
				size: record.remote.isDir ? undefined : record.remote.size,
			},
			localMtimeChanged,
			remoteEtagsDiffer,
			contentCheck,
			localChanged,
			remoteChanged,
		})
	}
	return { localChanged, remoteChanged }
}
