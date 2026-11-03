import type { ChatSession, LegacyChatSession } from '~/ai/chat/domain'
import { ChatSessionIndexItem } from '~/ai/chat/domain'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import type { ChatMetaRecord } from '~/storage'
import { SessionsFileBackend } from './session-files'
import i18n from '~/i18n'
import type { ChatAgentState, ReversibleToolOp } from '~/ai/chat/types'
import { normalizeReversibleToolOpRecord } from '~/ai/chat/messages/reversible-op-utils'
import { MASTER_AGENT_ID } from '~/ai/chat/agents/registry'
import {
	countIncompleteToolCalls,
	normalizeRehydratedExecution,
} from './rehydration-execution'
import { SessionRecovery } from './session-recovery'
import { SessionWriteQueue } from './session-write-queue'
import { migrateChatSession, normalizeLegacySession } from './session-migration'

export interface SessionLegacyStore {
	listSessionKeys(): Promise<string[]>
	getSession(id: string): Promise<unknown>
	unsetSession(id: string): Promise<void>
	getMeta(): Promise<{
		meta: ChatMetaRecord | null
		index: ChatSessionIndexItem[]
	}>
}

export class SessionUnavailableError extends Error {
	/**
	 * N3 (WS-7): `true` when the session could not be read but its file still
	 * exists on disk (transient I/O / sync race). Such a failure must not trigger
	 * an index reconcile, which would trim a session that is merely unreadable for
	 * the moment.
	 */
	readonly transient: boolean

	constructor(
		public readonly sessionId: string,
		options?: { cause?: unknown; transient?: boolean },
	) {
		super(i18n.t('chatbox.errors.sessionNotFound'), options)
		this.name = 'SessionUnavailableError'
		this.transient = options?.transient ?? false
	}
}

export class SessionStoreBase {
	protected readonly writeQueues = new Map<string, SessionWriteQueue>()
	protected startupRecoveredToolCalls = 0

	constructor(
		protected state: ChatState,
		protected selection: Selection,
		protected backend: SessionsFileBackend,
		protected legacy: SessionLegacyStore,
		protected recovery: SessionRecovery | undefined,
		protected resetSessionExecution: (
			sessionId: string,
			session: ChatSession,
		) => void = () => {},
	) {}

	consumeStartupRecoveredToolCalls() {
		const count = this.startupRecoveredToolCalls
		this.startupRecoveredToolCalls = 0
		return count
	}

	protected getIndexedTitle(session: ChatSession): string | undefined {
		const title = this.state.sessionIndex.find(
			(item) => item.id === session.id,
		)?.title
		if (title && title !== i18n.t('chatbox.newChat')) {
			return title
		}
		return undefined
	}

	rehydrateSession(session: ChatSession | LegacyChatSession) {
		const migrated = migrateChatSession(
			'schemaVersion' in session ? session : normalizeLegacySession(session),
		)
		const { session: rehydrated, changed: opsRewritten } =
			this.normalizeSession(migrated.session)
		let changed =
			migrated.changed ||
			this.selection.sanitizeSessionSelection(rehydrated) ||
			opsRewritten

		this.startupRecoveredToolCalls += countIncompleteToolCalls(rehydrated)
		changed = normalizeRehydratedExecution(rehydrated) || changed

		return {
			session: rehydrated,
			changed,
		}
	}

	normalizeSession(session: ChatSession): {
		session: ChatSession
		changed: boolean
	} {
		let changed = false
		const normalizeMessage = (message: ChatAgentState['timeline'][number]) => ({
			...message,
			metadata: message.metadata
				? {
						...message.metadata,
						llm: message.metadata.llm ? { ...message.metadata.llm } : undefined,
					}
				: { createdAt: session.createdAt },
			parts: [...message.parts],
		})
		const normalizeAgent = (agent: ChatAgentState): ChatAgentState => {
			const normalizeTimestamp = (value: unknown) =>
				typeof value === 'number' && Number.isFinite(value) ? value : undefined
			const subagents = Object.fromEntries(
				Object.entries(agent.subagents ?? {}).map(([id, child]) => [
					id,
					normalizeAgent(child),
				]),
			)
			const normalizeOperations = (operations: ReversibleToolOp[]) => {
				const normalized: ReversibleToolOp[] = []
				for (const operation of operations) {
					const canonical = normalizeReversibleToolOpRecord(operation)
					if (!canonical) {
						changed = true
						continue
					}
					if (canonical.vaultPath !== operation.vaultPath) {
						changed = true
					}
					normalized.push(canonical)
				}
				return normalized
			}
			const storedPendingInputs = Array.isArray(agent.pendingInputs)
				? agent.pendingInputs
				: []
			const pendingInputs =
				agent.id === MASTER_AGENT_ID
					? // Master continuation is runtime-only now; do not revive persisted
						// execution input after reload.
						[]
					: storedPendingInputs.map(normalizeMessage)
			const timeline = Array.isArray(agent.timeline)
				? agent.timeline.map(normalizeMessage)
				: []
			const model =
				agent.model &&
				typeof agent.model.providerId === 'string' &&
				typeof agent.model.modelId === 'string'
					? {
							providerId: agent.model.providerId,
							modelId: agent.model.modelId,
						}
					: undefined
			if (agent.id === MASTER_AGENT_ID && storedPendingInputs.length > 0) {
				changed = true
			}
			if (agent.model !== undefined && !model) changed = true
			return {
				id: agent.id,
				type:
					agent.type ||
					(agent.id === MASTER_AGENT_ID ? MASTER_AGENT_ID : 'subagent'),
				model,
				status: agent.id === MASTER_AGENT_ID ? 'idle' : agent.status,
				createdAt: agent.createdAt || session.createdAt,
				startedAt: normalizeTimestamp(agent.startedAt),
				finishedAt: normalizeTimestamp(agent.finishedAt),
				resultPath:
					typeof agent.resultPath === 'string' ? agent.resultPath : undefined,
				timeline,
				pendingInputs,
				operations: Object.fromEntries(
					Object.entries(agent.operations ?? {}).map(
						([messageId, operations]) => [
							messageId,
							normalizeOperations(operations ?? []),
						],
					),
				),
				toolTimings: Object.fromEntries(
					Object.entries(agent.toolTimings ?? {}).flatMap(
						([toolCallId, timing]) => {
							const startedAt = normalizeTimestamp(timing?.startedAt)
							const finishedAt = normalizeTimestamp(timing.finishedAt)
							const outcome =
								typeof timing?.outcome === 'string' ? timing.outcome : undefined
							if (
								startedAt === undefined &&
								finishedAt === undefined &&
								outcome === undefined
							) {
								return []
							}
							return [
								[
									toolCallId,
									{
										...(startedAt === undefined ? {} : { startedAt }),
										...(finishedAt === undefined ? {} : { finishedAt }),
										...(outcome ? { outcome } : {}),
									},
								],
							]
						},
					),
				),
				readVaultPaths: Array.isArray(agent.readVaultPaths)
					? agent.readVaultPaths.filter((path) => typeof path === 'string')
					: undefined,
				subagents,
			}
		}
		const master = normalizeAgent(session.subagents.master)
		return {
			session: {
				schemaVersion: 2,
				id: session.id,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt || session.createdAt,
				model: session.model ? { ...session.model } : undefined,
				systemPrompt: session.systemPrompt,
				disabledMcpServers: Array.isArray(session.disabledMcpServers)
					? session.disabledMcpServers.filter(
							(name): name is string => typeof name === 'string',
						)
					: undefined,
				subagents: { master },
			},
			changed,
		}
	}
}
