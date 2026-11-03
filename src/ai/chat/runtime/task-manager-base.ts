import type { App } from 'obsidian'
import { findAgent } from '~/ai/chat/agents/agent-tree'
import type { ChatSession } from '~/ai/chat/domain'
import { getMasterAgent, isTerminalAgent } from '~/ai/chat/domain'
import { extractErrorMessage } from '~/ai/chat/error-utils'
import {
	ContextCompactionCoordinator,
	createContextCompactionRevision,
	type ContextCompactionRequest,
} from './context-compaction-coordinator'
import { type AgentLoopError } from './agent-loop'
import type { AgentRunner } from './agent-runner'
import type { ContextSummaryBackend } from './context-compression'
import type { ChatState } from './chat-state'
import type { TaskOrigin } from './master-turn-scheduler'
import type { Selection } from './selection'
import type { ToolExecutor } from './tool-executor'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import type { AIModelConfig, AIProviderConfig } from '~/ai/core/types'
import i18n from '~/i18n'
import createId, { createUniqueWordId } from '~/utils/create-id'

export class TaskManagerBase {
	protected enqueueMasterAgentInput: (
		sessionId: string,
		input: AppUIMessage,
		origin: TaskOrigin,
	) => boolean = () => false
	protected taskOrigins = new Map<string, TaskOrigin>()

	constructor(
		protected app: App,
		protected ensureProviderReady: (
			provider: AIProviderConfig,
		) => Promise<void>,
		protected state: ChatState,
		protected selection: Selection,
		protected store: SessionStore,
		protected notify: () => void,
		protected toolExecutor: ToolExecutor,
		protected messageFactory: import('~/ai/chat/messages/message-factory').MessageFactory,
		protected agentRunner: AgentRunner,
		compactionCoordinator?: ContextCompactionCoordinator,
		protected getCompressionBackend: () => ContextSummaryBackend = () =>
			'deterministic',
	) {
		this.compactionCoordinator =
			compactionCoordinator ??
			new ContextCompactionCoordinator(this.store, this.messageFactory)
	}

	protected readonly compactionCoordinator: ContextCompactionCoordinator

	setMasterAgentInputHandler(
		handler: (
			sessionId: string,
			input: AppUIMessage,
			origin: TaskOrigin,
		) => boolean,
	) {
		this.enqueueMasterAgentInput = handler
	}

	protected agentLoopErrorMessage(error: AgentLoopError) {
		if (error.type !== 'turn-failed') {
			return i18n.t('chatbox.errors.contextCompressionFailed')
		}
		return extractErrorMessage(error.cause, i18n.t('chatbox.requestFailed'))
	}

	protected createCompactionRequest(
		session: ChatSession,
		agent: ChatAgentState,
		provider: AIProviderConfig,
		model: AIModelConfig,
		isTurnAlive: () => boolean,
	): ContextCompactionRequest {
		const selectedModel = agent.model
		// Capture primitive ids at request creation. The selection object can be
		// mutated in place when settings change; retaining the object reference
		// would make the stale-job check observe the new values as if they were
		// the original configuration.
		const selectedProviderId = selectedModel?.providerId
		const selectedModelId = selectedModel?.modelId
		const backend = this.getCompressionBackend()
		const revision = createContextCompactionRevision(
			session,
			provider,
			model,
			backend,
		)
		return {
			session,
			agent,
			provider,
			model,
			backend,
			revision,
			ensureProviderReady: () => this.ensureProviderReady(provider),
			resolveSummaryContext: () =>
				this.agentRunner.resolveSummaryContext(agent, session, model),
			isCancelled: () => !isTurnAlive(),
			isCurrent: () => {
				const currentSelection = agent.model
				return (
					isTurnAlive() &&
					currentSelection?.providerId === selectedProviderId &&
					currentSelection?.modelId === selectedModelId &&
					createContextCompactionRevision(session, provider, model, backend) ===
						revision
				)
			},
		}
	}

	protected async createAgentId(session: ChatSession, agentType: string) {
		return createUniqueWordId(agentType, (id) =>
			Boolean(findAgent(getMasterAgent(session), id)),
		)
	}

	protected resolveSubagentModelSelection(
		configuredModel: ChatSession['model'],
		fallbackModel: ChatSession['model'],
	) {
		if (!configuredModel) {
			return fallbackModel ? { ...fallbackModel } : undefined
		}
		try {
			const provider = this.selection.getProviderByIdOrThrow(
				configuredModel.providerId,
			)
			this.selection.getModelByIdsOrThrow(provider, configuredModel.modelId)
			return { ...configuredModel }
		} catch {
			return fallbackModel ? { ...fallbackModel } : undefined
		}
	}

	protected originKey(sessionId: string, agentId: string) {
		return `${sessionId}:${agentId}`
	}

	protected isCurrentSession(session: ChatSession) {
		return (
			this.state.loadedSessions.get(session.id) === session &&
			!this.state.deletedSessionIds.has(session.id)
		)
	}

	protected isOriginAlive(origin: TaskOrigin) {
		return !origin.signal.aborted
	}

	protected isAgentExecutionAlive(
		session: ChatSession,
		agent: ChatAgentState,
		origin: TaskOrigin,
	) {
		return (
			this.isCurrentSession(session) &&
			this.isOriginAlive(origin) &&
			!isTerminalAgent(agent)
		)
	}

	protected persistCurrentSession(session: ChatSession) {
		return this.store.persistSession(session, () =>
			this.isCurrentSession(session),
		)
	}

	protected createTaskResultInput(
		taskId: string,
		resultPath: string,
	): AppUIMessage {
		return {
			id: createId('input'),
			role: 'user',
			metadata: { createdAt: Date.now() },
			parts: [
				{
					type: 'data-system-notification',
					data: {
						kind: 'task-result-ready',
						taskId,
						resultPath,
					},
				},
			],
		}
	}

	protected hasTaskResultNotification(agent: ChatAgentState, taskId: string) {
		return agent.timeline.some((message: AppUIMessage) =>
			message.parts.some(
				(part) =>
					part.type === 'data-system-notification' &&
					part.data.kind === 'task-result-ready' &&
					part.data.taskId === taskId,
			),
		)
	}

	protected removePendingInput(agent: ChatAgentState, input: AppUIMessage) {
		const inputIndex = agent.pendingInputs.indexOf(input)
		if (inputIndex !== -1) agent.pendingInputs.splice(inputIndex, 1)
	}

	protected hasActiveChildAgents(agent: ChatAgentState) {
		return Object.values(agent.subagents).some(
			(child) => !isTerminalAgent(child),
		)
	}

	protected cleanupAgentTracking(sessionId: string, agentId: string) {
		this.taskOrigins.delete(this.originKey(sessionId, agentId))
	}
}
