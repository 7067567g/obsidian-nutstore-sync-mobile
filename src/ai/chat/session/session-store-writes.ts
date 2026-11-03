import type { ChatSession } from '~/ai/chat/domain'
import { perfMetrics, perfNow } from '~/diagnostics/perf-metrics'
import { encodeChatSessionForStorage } from './session-persistence'
import { SessionWriteQueue } from './session-write-queue'
import logger from '~/utils/logger'
import { SessionStoreBase } from './session-store-base'

export class SessionStoreWritesBase extends SessionStoreBase {
	private getWriteQueue(sessionId: string) {
		let queue = this.writeQueues.get(sessionId)
		if (!queue) {
			queue = new SessionWriteQueue(async (task) => {
				if (this.state.deletedSessionIds.has(sessionId) || !task.isCurrent()) {
					return
				}
				const encodeStartedAt = perfNow()
				const snapshot = await encodeChatSessionForStorage(task.session)
				perfMetrics.recordPersistenceEncode(perfNow() - encodeStartedAt)
				if (this.state.deletedSessionIds.has(sessionId) || !task.isCurrent()) {
					return
				}
				await this.recovery?.markStarted(sessionId)
				await this.backend.writeSessionFile(
					sessionId,
					{
						session: snapshot,
						title: task.title,
					},
					task.session,
				)
				await this.recovery?.markCompleted(sessionId)
			})
			this.writeQueues.set(sessionId, queue)
		}
		return queue
	}

	async persistSession(
		session: ChatSession,
		isCurrent: () => boolean = () =>
			this.state.loadedSessions.get(session.id) === session,
	) {
		if (this.state.deletedSessionIds.has(session.id) || !isCurrent()) {
			return
		}
		const startedAt = perfNow()
		try {
			const queue = this.getWriteQueue(session.id)
			const promise = queue.schedule({
				session,
				title: this.getIndexedTitle(session),
				isCurrent,
			})
			void promise.catch((error) => {
				logger.error('Failed to persist chat session', error)
			})
			// Awaited persists are durability points, so flush immediately. This also
			// drains any fire-and-forget batch already queued for this session.
			await queue.flush()
		} finally {
			perfMetrics.recordPersistence(perfNow() - startedAt)
		}
	}

	/**
	 * Queue a write-behind persist for callers that do not await persistence
	 * (selection changes, queued-message bookkeeping). The fixed window coalesces
	 * bursts into one write; `flushSession`/`flushAll` are the durability barriers.
	 */
	persistSessionSoon(
		session: ChatSession,
		isCurrent: () => boolean = () =>
			this.state.loadedSessions.get(session.id) === session,
	) {
		if (this.state.deletedSessionIds.has(session.id) || !isCurrent()) {
			return
		}
		const promise = this.getWriteQueue(session.id).schedule({
			session,
			title: this.getIndexedTitle(session),
			isCurrent,
		})
		void promise.catch((error) => {
			logger.error('Failed to persist chat session', error)
		})
	}

	/** Force one session's pending write-behind batch to disk. */
	async flushSession(sessionId: string) {
		const queue = this.writeQueues.get(sessionId)
		if (!queue) return
		const startedAt = perfNow()
		try {
			await queue.flush()
		} finally {
			perfMetrics.recordPersistence(perfNow() - startedAt)
		}
	}

	/** Flush every session's pending write-behind batch, aggregating failures. */
	async flushAll() {
		const results = await Promise.allSettled(
			[...this.writeQueues.keys()].map((sessionId) =>
				this.flushSession(sessionId),
			),
		)
		const errors: unknown[] = results.flatMap((result) =>
			result.status === 'rejected' ? [result.reason as unknown] : [],
		)
		if (errors.length > 0) {
			throw new AggregateError(errors, 'Failed to flush chat sessions')
		}
	}
}
