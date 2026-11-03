import type { ChatSession } from '~/ai/chat/domain'
import type { ReversibleToolOp } from '~/ai/chat/types'
import type { App } from 'obsidian'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import { getMessageText, getUserContextItems } from './ui-message'
import { copyUserContextItems } from '~/ai/chat/context/user-context'
import {
	captureWorkspaceContexts,
	computeChangedContexts,
} from '~/ai/chat/context/workspace-context'
import type { MessageFactory } from './message-factory'
import {
	isSessionExecutionPending,
	type RuntimeStates,
} from '~/ai/chat/runtime/runtime-state'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { RecallMessageResult } from '~/ai/chat/ui/types'
import logger from '~/utils/logger'
import type { SkillRepository } from '~/ai/skills/repository'
import type { VaultFileSystemManager } from '~/ai/tools/vault-filesystem'
import type {
	SettingsSnapshotFn,
	SettingsUpdater,
} from '~/ai/tools/tool-context'
import type { RegenerationTransaction } from '~/ai/chat/runtime/regeneration'
import { restoreFilesForRecall } from './message-ops-reversible'

export class MessageOps {
	constructor(
		private app: App,
		private state: ChatState,
		private runtimeStates: RuntimeStates,
		private store: SessionStore,
		private notify: () => void,
		private reportTransientError: (message: string) => void,
		private messageFactory: MessageFactory,
		private validateSelection: (session: ChatSession) => boolean,
		private enqueueRegenerate: (
			sessionId: string,
			targetMessageId: string,
		) => boolean,
		private skillRepository?: SkillRepository,
		private settingsIo?: {
			getSettingsSnapshot: SettingsSnapshotFn
			updateSettings: SettingsUpdater
		},
		private fileSystemManager?: VaultFileSystemManager,
	) {}

	deleteMessage(messageId: string) {
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}
		const runtime = this.runtimeStates.get(session.id)
		if (runtime.runState !== 'idle') {
			return
		}
		const agent = this.messageFactory.getActiveAgent(session)
		const idx = agent.timeline.findIndex((message) => message.id === messageId)
		if (idx === -1) {
			return
		}
		const target = agent.timeline[idx]
		if (target.role === 'user') {
			let endIdx = idx + 1
			while (
				endIdx < agent.timeline.length &&
				agent.timeline[endIdx].role !== 'user'
			) {
				endIdx++
			}
			for (const removed of agent.timeline.splice(idx, endIdx - idx)) {
				delete agent.operations[removed.id]
			}
		} else {
			agent.timeline.splice(idx, 1)
			delete agent.operations[target.id]
		}
		this.store.persistSessionSoon(session)
		this.notify()
	}

	async recallMessage(
		messageId: string,
		options?: { restoreFiles?: boolean; session?: ChatSession | string },
	): Promise<RecallMessageResult | void> {
		const session = this.resolveTargetSession(options?.session)
		if (!session) {
			return
		}
		const runtime = this.runtimeStates.get(session.id)
		if (runtime.runState !== 'idle') {
			return
		}
		const agent = this.messageFactory.getActiveAgent(session)
		const idx = agent.timeline.findIndex((message) => message.id === messageId)
		if (idx === -1) {
			return
		}
		const recalledMessage = agent.timeline[idx]
		const recalledText =
			recalledMessage.role === 'user' ? getMessageText(recalledMessage) : ''
		const recalledUserContext = copyUserContextItems(
			getUserContextItems(recalledMessage),
		)
		const recallRange = agent.timeline.slice(idx)
		const reversibleOps = recallRange.flatMap(
			(message) => agent.operations[message.id] ?? [],
		)
		try {
			if (options?.restoreFiles) {
				await this.restoreFilesForRecall(reversibleOps)
				// K3: the await above is a switch window; never mutate a session
				// that was unloaded/replaced while we were waiting.
				if (!this.isWritableSession(session)) {
					return
				}
			}
			for (const removed of agent.timeline.splice(idx)) {
				delete agent.operations[removed.id]
			}
			runtime.draft.userContext = recalledUserContext
			runtime.draft.text = recalledText
			await this.store.persistSession(session)
			this.notify()
			return {
				text: recalledText,
				userContext: copyUserContextItems(recalledUserContext),
			}
		} catch (error) {
			logger.error(error)
			this.reportTransientError(
				error instanceof Error ? error.message : String(error),
			)
		}
	}

	recallMessageHasReversibleOps(messageId: string): boolean {
		const session = this.getLoadedActiveSession()
		if (!session) {
			return false
		}
		const agent = this.messageFactory.getActiveAgent(session)
		const idx = agent.timeline.findIndex((message) => message.id === messageId)
		if (idx === -1) {
			return false
		}
		return agent.timeline
			.slice(idx)
			.some((message) => Boolean(agent.operations[message.id]?.length))
	}

	async regenerateMessage(messageId: string) {
		const session = this.getLoadedActiveSession()
		if (!session || !this.validateSelection(session)) {
			return
		}
		const runtime = this.runtimeStates.get(session.id)
		if (isSessionExecutionPending(runtime)) {
			return
		}
		const agent = this.messageFactory.getActiveAgent(session)
		const idx = agent.timeline.findIndex((message) => message.id === messageId)
		if (idx === -1) {
			return
		}
		this.enqueueRegenerate(session.id, messageId)
	}

	async beginRegeneration(
		session: ChatSession,
		targetMessageId: string,
		isCurrent: () => boolean,
	): Promise<RegenerationTransaction | undefined> {
		const agent = this.messageFactory.getActiveAgent(session)
		const idx = agent.timeline.findIndex(
			(message) => message.id === targetMessageId,
		)
		if (idx === -1) return undefined
		await this.skillRepository?.refresh()
		if (!isCurrent()) return undefined

		const originalTimeline = agent.timeline.slice()
		const originalOperations = Object.fromEntries(
			Object.entries(agent.operations).map(([id, operations]) => [
				id,
				operations.slice(),
			]),
		)
		const originalToolTimings = Object.fromEntries(
			Object.entries(agent.toolTimings).map(([id, timing]) => [
				id,
				{ ...timing },
			]),
		)
		const originalSessionIndexPosition = this.state.sessionIndex.findIndex(
			(item) => item.id === session.id,
		)
		const originalSessionUpdatedAt = session.updatedAt
		const prefix = originalTimeline.slice(0, idx)
		const suffix = originalTimeline.slice(idx + 1)

		let lastUserIdx = -1
		for (let index = prefix.length - 1; index >= 0; index -= 1) {
			if (prefix[index].role === 'user') {
				lastUserIdx = index
				break
			}
		}
		if (lastUserIdx !== -1) {
			const prevMessages = prefix.slice(0, lastUserIdx)
			const current = captureWorkspaceContexts(this.app, this.skillRepository)
			const changed = computeChangedContexts(prevMessages, current)
			const message = prefix[lastUserIdx]
			prefix[lastUserIdx] = {
				...message,
				parts: message.parts.filter(
					(part) => part.type !== 'data-workspace-context',
				),
			}
			if (changed.length) {
				prefix[lastUserIdx].parts.unshift({
					type: 'data-workspace-context',
					data: { deltas: changed },
				})
			}
		}

		agent.timeline = prefix
		return {
			targetMessageId,
			targetToolCallIds: originalTimeline[idx].parts.flatMap((part) =>
				part.type === 'dynamic-tool' ? [part.toolCallId] : [],
			),
			originalTimeline,
			originalOperations,
			originalToolTimings,
			originalReadVaultPaths: agent.readVaultPaths?.slice(),
			originalSessionUpdatedAt,
			originalSessionIndexItem:
				originalSessionIndexPosition === -1
					? undefined
					: {
							...this.state.sessionIndex[originalSessionIndexPosition],
						},
			originalSessionIndexPosition,
			prefixLength: prefix.length,
			suffix,
		}
	}

	commitRegeneration(
		session: ChatSession,
		transaction: RegenerationTransaction,
	) {
		const agent = this.messageFactory.getActiveAgent(session)
		delete agent.operations[transaction.targetMessageId]
		for (const toolCallId of transaction.targetToolCallIds) {
			delete agent.toolTimings[toolCallId]
		}
		agent.timeline = [...agent.timeline, ...transaction.suffix]
	}

	rollbackRegeneration(
		session: ChatSession,
		transaction: RegenerationTransaction,
	) {
		const agent = this.messageFactory.getActiveAgent(session)
		agent.timeline = transaction.originalTimeline.slice()
		agent.operations = Object.fromEntries(
			Object.entries(transaction.originalOperations).map(([id, operations]) => [
				id,
				operations.slice(),
			]),
		)
		agent.toolTimings = Object.fromEntries(
			Object.entries(transaction.originalToolTimings).map(([id, timing]) => [
				id,
				{ ...timing },
			]),
		)
		agent.readVaultPaths = transaction.originalReadVaultPaths?.slice()
		session.updatedAt = transaction.originalSessionUpdatedAt
		const currentIndexPosition = this.state.sessionIndex.findIndex(
			(item) => item.id === session.id,
		)
		if (transaction.originalSessionIndexItem) {
			const restored = { ...transaction.originalSessionIndexItem }
			if (currentIndexPosition === -1) {
				const position = Math.min(
					transaction.originalSessionIndexPosition,
					this.state.sessionIndex.length,
				)
				this.state.sessionIndex = [
					...this.state.sessionIndex.slice(0, position),
					restored,
					...this.state.sessionIndex.slice(position),
				]
			} else {
				this.state.sessionIndex = this.state.sessionIndex.slice()
				this.state.sessionIndex[currentIndexPosition] = restored
			}
		} else if (currentIndexPosition !== -1) {
			this.state.sessionIndex = this.state.sessionIndex.filter(
				(item) => item.id !== session.id,
			)
		}
	}

	async restoreFilesForRecall(operations: ReversibleToolOp[]) {
		await restoreFilesForRecall(this.app, operations, {
			fileSystemManager: this.fileSystemManager,
			settingsIo: this.settingsIo,
		})
	}

	/**
	 * K9: bind the operation to an explicit session captured at the synchronous
	 * entry point. A string target is resolved against `loadedSessions`; a
	 * `ChatSession` reference additionally gets the K3 object-identity guard.
	 */
	private resolveTargetSession(
		target?: ChatSession | string,
	): ChatSession | undefined {
		if (target === undefined) return this.getLoadedActiveSession()
		const sessionId = typeof target === 'string' ? target : target.id
		if (this.state.deletedSessionIds.has(sessionId)) return undefined
		const session = this.state.loadedSessions.get(sessionId)
		if (!session) return undefined
		if (typeof target !== 'string' && session !== target) return undefined
		return session
	}

	private isWritableSession(session: ChatSession): boolean {
		return (
			!this.state.deletedSessionIds.has(session.id) &&
			this.state.loadedSessions.get(session.id) === session
		)
	}

	private getLoadedActiveSession() {
		return this.state.activeSessionId
			? this.state.loadedSessions.get(this.state.activeSessionId)
			: undefined
	}
}
