import { Notice } from 'obsidian'
import type { ChatSession, LegacyChatSession } from '~/ai/chat/domain'
import { deriveTitle } from '~/ai/chat/messages/message-utils'
import {
	SessionFileCorruptError,
	type SessionsFileBackend,
	getChatSessionPath,
	type ChatSessionFilePayload,
} from './session-files'
import type { OpsGcOptions } from './ops-gc'
import {
	decodeChatSessionFromStorage,
	type PersistedChatSession,
} from './session-persistence'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import { SessionStoreIndexBase } from './session-store-index'
import { SessionUnavailableError } from './session-store-base'
import { SessionLogCorruptionError } from './session-log-parse'

export { SessionUnavailableError }
export type { SessionLegacyStore } from './session-store-base'

/**
 * Optional persistence-backend capability (H4 / K15). It returns a cheap,
 * comparable token for the currently persisted session payload — e.g. a
 * `mtime+size` pair or the log generation. When present, the in-memory session
 * cache is revalidated before every cache hit so external rewrites (Nutstore
 * sync, another window, compaction) are picked up without re-decoding on every
 * switch. Backends that do not implement it keep today's behaviour: the cached
 * object stays authoritative until `invalidateSession` is called.
 */
export interface SessionCacheVersionSource {
	getSessionFileVersion(sessionId: string): Promise<string | number | undefined>
}

function hasSessionCacheVersion(
	backend: SessionsFileBackend,
): backend is SessionsFileBackend & SessionCacheVersionSource {
	return (
		typeof (
			backend as unknown as {
				getSessionFileVersion?: unknown
			}
		).getSessionFileVersion === 'function'
	)
}

export class SessionStore extends SessionStoreIndexBase {
	/** In-flight loads keyed by session id, so concurrent misses share one read (WS2-N1). */
	private readonly loadingSessions = new Map<string, Promise<ChatSession>>()
	/** Version token captured when a session was cached, compared on cache hit (H4). */
	private readonly loadedSessionVersions = new Map<string, string | number>()
	/**
	 * Bumped on `invalidateSession`; a read that started before the bump returns
	 * its value but must not repopulate the cache with pre-invalidation data.
	 */
	private readonly sessionEpochs = new Map<string, number>()

	async collectOperationGcReport(options?: OpsGcOptions) {
		return this.backend.collectOperationGcReport(options)
	}

	async recoverPendingWrites() {
		await this.backend.recoverPendingTemps()
		if (!this.recovery) return
		await this.recovery.recoverPending(async (id) => {
			await this.backend.readSessionFile(id, { hydrateOperations: false })
			this.state.deletedSessionIds.delete(id)
			// H4: recovery applies on-disk state written out-of-band (crash temp
			// promote), so any cached copy of this session is stale by definition.
			this.invalidateSession(id)
		})
	}

	async loadInitialSession() {
		await this.loadSessionIndex()
		const activeSessionId = this.state.activeSessionId
		if (!activeSessionId) return undefined

		try {
			return await this.loadSessionById(activeSessionId)
		} catch (error) {
			// N3: a transient read failure is not a missing session; do not
			// reconcile (and therefore trim) the index for it.
			if (!(error instanceof SessionUnavailableError) || error.transient) {
				throw error
			}
		}

		await this.reconcileSessionIndex(null)
		const fallbackSessionId = this.state.activeSessionId
		if (!fallbackSessionId) return undefined
		return this.loadSessionById(fallbackSessionId)
	}

	async loadSessionById(sessionId: string) {
		try {
			return await this.loadSessionByIdUnchecked(sessionId)
		} catch (error) {
			if (!(error instanceof SessionUnavailableError)) throw error
			// N3: only a genuinely unavailable (file gone/corrupt) session may
			// trigger an index reconcile; a transient read failure keeps the index.
			if (error.transient) throw error
			try {
				await this.reconcileSessionIndex(null)
			} catch (reconcileError) {
				logger.warn(
					`Failed to reconcile unavailable chat session ${sessionId}`,
					reconcileError,
				)
			}
			throw error
		}
	}

	/**
	 * Drop a cached session so the next `loadSessionById` re-reads it from the
	 * persistence backend. Returns whether a cached entry was removed. Call this
	 * from external-write paths (sync pull, import, second window) that bypass
	 * this store's write queue (H4).
	 */
	invalidateSession(sessionId: string): boolean {
		this.sessionEpochs.set(sessionId, this.getSessionEpoch(sessionId) + 1)
		this.loadingSessions.delete(sessionId)
		this.loadedSessionVersions.delete(sessionId)
		// R2b / S2: the JSONL write path has its own TTL-bounded state cache;
		// an explicit external-write invalidation must clear it too.
		this.backend.invalidateSessionState(sessionId)
		return this.state.loadedSessions.delete(sessionId)
	}

	/** Drop every cached session, e.g. after an external bulk sync (H4). */
	invalidateAllSessions(): void {
		for (const sessionId of this.state.loadedSessions.keys()) {
			this.sessionEpochs.set(sessionId, this.getSessionEpoch(sessionId) + 1)
			this.backend.invalidateSessionState(sessionId)
		}
		this.loadingSessions.clear()
		this.loadedSessionVersions.clear()
		this.state.loadedSessions.clear()
	}

	private getSessionEpoch(sessionId: string) {
		return this.sessionEpochs.get(sessionId) ?? 0
	}

	private async loadSessionByIdUnchecked(sessionId: string) {
		const cached = this.state.loadedSessions.get(sessionId)
		if (cached) {
			if (await this.isCachedSessionFresh(sessionId)) {
				return cached
			}
			this.state.loadedSessions.delete(sessionId)
			this.loadedSessionVersions.delete(sessionId)
		}

		// Coalesce concurrent misses for the same session onto one read so the
		// store and every caller share a single instance (WS2-N1).
		const pending = this.loadingSessions.get(sessionId)
		if (pending) {
			return pending
		}

		const load = this.readSessionIntoCache(sessionId)
		this.loadingSessions.set(sessionId, load)
		try {
			return await load
		} finally {
			if (this.loadingSessions.get(sessionId) === load) {
				this.loadingSessions.delete(sessionId)
			}
		}
	}

	private async isCachedSessionFresh(sessionId: string) {
		if (!hasSessionCacheVersion(this.backend)) {
			return true
		}
		const version = await this.readSessionVersion(sessionId)
		return (
			version === undefined ||
			this.loadedSessionVersions.get(sessionId) === version
		)
	}

	private async readSessionVersion(
		sessionId: string,
	): Promise<string | number | undefined> {
		const backend = this.backend
		if (!hasSessionCacheVersion(backend)) {
			return undefined
		}
		try {
			return await backend.getSessionFileVersion(sessionId)
		} catch (error) {
			logger.warn(`Failed to read chat session version for ${sessionId}`, error)
			return undefined
		}
	}

	private async readSessionIntoCache(sessionId: string) {
		const epoch = this.getSessionEpoch(sessionId)
		// Read the version before the payload: if the file changes between the
		// two, the stored token is older than the content, so the next hit
		// revalidates instead of trusting a mismatched pair.
		const version = await this.readSessionVersion(sessionId)

		let payload: ChatSessionFilePayload | undefined
		try {
			payload = await this.backend.readSessionFile(sessionId)
		} catch (error) {
			if (error instanceof SessionFileCorruptError) {
				new Notice(
					i18n.t('chatbox.errors.corruptSessionFile', {
						path: error.filePath,
					}),
					10000,
				)
				throw new SessionUnavailableError(sessionId, {
					cause: error,
				})
			}
			// N3: a non-corruption read failure is only "the session is gone"
			// when the file is really absent. If it still exists, this is a
			// transient I/O/sync failure and must not be downgraded to a
			// full-index reconcile (which would drop the session from the list).
			if (!(error instanceof SessionLogCorruptionError)) {
				let stillOnDisk = false
				try {
					stillOnDisk = await this.backend.hasSessionFile(sessionId)
				} catch {
					/* treat an existence probe failure as "not present" */
				}
				if (stillOnDisk) {
					throw new SessionUnavailableError(sessionId, {
						cause: error,
						transient: true,
					})
				}
			}
			payload = undefined
		}

		let stored: ChatSession | LegacyChatSession | undefined
		let embeddedTitle: string | undefined
		if (payload) {
			try {
				stored = decodeChatSessionFromStorage(payload.session)
			} catch (error) {
				new Notice(
					i18n.t('chatbox.errors.corruptSessionFile', {
						path: getChatSessionPath(sessionId),
					}),
					10000,
				)
				throw new SessionUnavailableError(sessionId, { cause: error })
			}
			embeddedTitle = payload.title
		} else {
			try {
				const legacy = await this.legacy.getSession(sessionId)
				if (legacy && typeof legacy === 'object') {
					stored = decodeChatSessionFromStorage(legacy as PersistedChatSession)
				}
			} catch {
				/* missing/unavailable legacy record */
			}
		}
		if (!stored) {
			throw new SessionUnavailableError(sessionId)
		}

		const { session, changed } = this.rehydrateSession(stored)
		if (epoch !== this.getSessionEpoch(sessionId)) {
			// Invalidated while this read was in flight: hand the caller the
			// decoded value but leave the cache cold, so the next caller re-reads
			// instead of trusting this possibly pre-invalidation copy.
			return session
		}
		this.resetSessionExecution(sessionId, session)
		this.state.loadedSessions.set(sessionId, session)
		if (version !== undefined) {
			this.loadedSessionVersions.set(sessionId, version)
		}

		const existing = this.state.sessionIndex.find(
			(item) => item.id === sessionId,
		)
		const freshTitle =
			embeddedTitle && embeddedTitle !== i18n.t('chatbox.newChat')
				? embeddedTitle
				: existing?.title && existing.title !== i18n.t('chatbox.newChat')
					? existing.title
					: deriveTitle(session)
		this.upsertSessionIndexItem(session, freshTitle)

		if (changed || !payload || !embeddedTitle) {
			await this.persistSession(session)
			await this.persistMetaAndIndex()
		}
		return session
	}

	async deleteSession(sessionId: string) {
		const queue = this.writeQueues.get(sessionId)
		if (queue) {
			await queue.flush().catch((error) => {
				logger.error('Failed to flush chat session before delete', error)
			})
		}
		this.loadingSessions.delete(sessionId)
		this.loadedSessionVersions.delete(sessionId)
		// N2: mark the id deleted for the duration of the backend delete so
		// concurrent persists cannot resurrect the file. If the delete fails the
		// mark must be rolled back, otherwise every later persist for this session
		// is silently suppressed until the plugin reloads.
		this.state.deletedSessionIds.add(sessionId)
		try {
			if (queue) {
				await queue.dispose()
				this.writeQueues.delete(sessionId)
			}
			await this.backend.deleteSessionFile(sessionId)
		} catch (error) {
			this.state.deletedSessionIds.delete(sessionId)
			throw error
		}
		await this.recovery?.markCompleted(sessionId)
		try {
			await this.legacy.unsetSession(sessionId)
		} catch {
			/* best-effort legacy cleanup */
		}
	}
}
