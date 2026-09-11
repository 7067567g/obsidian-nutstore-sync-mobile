import type { SessionLogBackend } from './session-log-backend'
import type { JsonRecord } from './session-log-format'

export const DEFAULT_SESSION_LOG_COMPACTION_BYTES = 512 * 1024

/** Compact an append log into a segment snapshot when it grows past the budget. */
export async function maybeCompactSessionLog(
	backend: SessionLogBackend,
	id: string,
	session: JsonRecord,
	thresholdBytes = DEFAULT_SESSION_LOG_COMPACTION_BYTES,
): Promise<boolean> {
	const size = await backend.getLogSize(id)
	if (size <= thresholdBytes) return false
	await backend.compactSession(id, session)
	return true
}
