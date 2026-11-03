import type { LanguageModelUsage } from 'ai'
import {
	getModelById,
	getProviderById,
	listModels,
	listProviders,
	resolveInitialSelection,
} from '~/ai/catalog/config'
import type { UserContextItem } from '~/ai/chat/context/user-context'
import type { ChatSession } from '~/ai/chat/domain'
import { resolveContextWindow } from '~/ai/chat/runtime/context-compression'
import type { SessionRuntimeState } from '~/ai/chat/runtime/chat-state'
import {
	createMasterTurnScheduler,
	getQueuedUserSubmissions,
} from '~/ai/chat/runtime/master-turn-scheduler'
import type {
	ChatboxProps,
	ChatProviderOption,
	RecallMessageResult,
} from '~/ai/chat/ui/types'
import {
	buildAgentViews,
	buildTimeline,
	collectOtherBusySessionIds,
} from '~/ai/chat/ui/view-projection'
import type { AIModelConfig } from '~/ai/core/types'
import i18n from '~/i18n'
import { ChatServiceQueue } from './chat.service.queue'

type ChatboxActionHandlers = Pick<
	ChatboxProps,
	| 'onNewSession'
	| 'onCompressContext'
	| 'onSwitchSession'
	| 'onExportSession'
	| 'onDeleteSession'
	| 'onSelectProvider'
	| 'onSelectModel'
	| 'onSendMessage'
	| 'onUpdateInputDraft'
	| 'onAddUserContext'
	| 'onRemoveUserContext'
	| 'onResolvePendingContextItem'
	| 'onDropContextItem'
	| 'onStopActiveRun'
	| 'onCancelPendingSubmission'
	| 'onDeleteMessage'
	| 'onRegenerateMessage'
	| 'onRecallMessage'
	| 'onRecallHasReversibleOps'
	| 'onToggleSessionMcpServer'
>

type ChatboxViewRuntime = Pick<
	SessionRuntimeState,
	'runState' | 'draft' | 'scheduler'
>

type ViewSelectionState = {
	selectedProviderId?: string
	selectedModelId?: string
}

export default class ChatService extends ChatServiceQueue {
	override async onunload() {
		await this.teardownOnUnload()
	}

	getViewProps(): ChatboxProps {
		const activeSession = this.getLoadedActiveSession()
		const activeRuntime = this.getViewRuntime(activeSession)
		const selection = this.resolveViewSelection(activeSession)
		const selectedProvider = getProviderById(
			this.plugin.settings.ai.providers,
			selection.selectedProviderId,
		)
		const selectedModel = getModelById(
			selectedProvider,
			selection.selectedModelId,
		)
		const { usage, contextWindow } = this.resolveContextUsage(
			activeSession,
			selectedModel,
		)

		return {
			loading: !this.state.initialized,
			title: this.getActiveSessionTitle(),
			activeContextItems: [],
			sessionHistory: this.state.sessionIndex.map((item) => ({ ...item })),
			activeSessionId: this.state.activeSessionId,
			timeline: activeSession ? buildTimeline(activeSession) : [],
			agentsById: activeSession ? buildAgentViews(activeSession) : {},
			otherBusySessionIds: collectOtherBusySessionIds(
				this.state.loadedSessions,
				this.state.activeSessionId,
				(id) => this.runtimeStates.get(id),
			),
			providers: this.buildProviderOptions(),
			selectedProviderId: selection.selectedProviderId,
			selectedModelId: selection.selectedModelId,
			runState: activeRuntime.runState,
			draft: {
				text: activeRuntime.draft.text,
				userContext: activeRuntime.draft.userContext.slice(),
			},
			pending: getQueuedUserSubmissions(activeRuntime).map((item) => ({
				id: item.id,
				text: item.text,
				userContext: item.userContext.slice(),
			})),
			canSend: !activeRuntime.draft.userContext.some(
				(item) => item.type === 'pending-context',
			),
			canCompress:
				!!activeSession &&
				activeRuntime.runState === 'idle' &&
				this.messageFactory.getActiveAgent(activeSession).timeline.length > 0,
			mcpServers: this.buildMcpServerOptions(activeSession),
			usage,
			contextWindow,
			windowedRendering: this.plugin.settings.ai.windowedRendering !== false,
			...this.bindViewActions(),
		}
	}

	private buildMcpServerOptions(activeSession?: ChatSession) {
		const disabled = new Set(activeSession?.disabledMcpServers ?? [])
		return this.plugin.mcpService
			.getServerRuntimes()
			.filter((runtime) => runtime.enabled)
			.map((runtime) => ({
				name: runtime.name,
				connected: runtime.status === 'connected',
				toolCount: runtime.tools.length,
				disabled: disabled.has(runtime.name),
			}))
	}

	/**
	 * Resolves raw context usage stats for the active agent context: the most recent
	 * assistant `LanguageModelUsage` record, plus the active model's context
	 * window. Returns empty values when no usage data or model is available —
	 * the UI layer decides how to present that (e.g. hide the ring, show "—",
	 * keep the last known value, etc.). Keeping the raw usage object lets the
	 * UI surface outputTokens, cached tokens, and other details later without
	 * changing this service.
	 */
	private resolveContextUsage(
		activeSession?: ChatSession,
		model?: AIModelConfig,
	): { usage?: LanguageModelUsage; contextWindow?: number } {
		if (!activeSession || !model) return {}
		const contextWindow = resolveContextWindow(model)
		const agent = this.messageFactory.getActiveAgent(activeSession)
		const latestUsage = [...agent.timeline]
			.reverse()
			.find((item) => item.role === 'assistant' && item.metadata?.llm?.usage)
			?.metadata?.llm?.usage
		if (!latestUsage) return { contextWindow }
		return { usage: latestUsage, contextWindow }
	}

	private getViewRuntime(activeSession?: ChatSession): ChatboxViewRuntime {
		if (activeSession) {
			return this.runtimeStates.get(activeSession.id)
		}
		return {
			runState: 'idle',
			draft: {
				text: '',
				userContext: [] as UserContextItem[],
			},
			scheduler: createMasterTurnScheduler(),
		}
	}

	private resolveViewSelection(
		activeSession?: ChatSession,
	): ViewSelectionState {
		const fallbackSelection = resolveInitialSelection(
			this.plugin.settings.ai.providers,
			this.plugin.settings.ai.defaultModel,
		)
		const emptyStateSelection = this.selection.getEmptyStateSelection()
		const providerId = activeSession
			? activeSession.model?.providerId
			: emptyStateSelection.providerId || fallbackSelection.providerId
		const modelId = activeSession
			? activeSession.model?.modelId
			: emptyStateSelection.modelId || fallbackSelection.modelId
		const selectedProvider = getProviderById(
			this.plugin.settings.ai.providers,
			providerId,
		)
		const selectedModel = getModelById(selectedProvider, modelId)

		return {
			selectedProviderId: selectedProvider?.id,
			selectedModelId: selectedModel?.id,
		}
	}

	private buildProviderOptions(): ChatProviderOption[] {
		return listProviders(this.plugin.settings.ai.providers).map((provider) => ({
			id: provider.id,
			name: provider.name || i18n.t('settings.ai.unnamedProvider'),
			models: listModels(provider).map((model) => ({
				id: model.id,
				name: model.name || i18n.t('settings.ai.unnamedModel'),
			})),
		}))
	}

	private bindViewActions(): ChatboxActionHandlers {
		return {
			onNewSession: () => void this.createSession(),
			onCompressContext: () => this.compressContext(),
			onSwitchSession: (sessionId: string) =>
				void this.switchSession(sessionId),
			onExportSession: (sessionId, modalMountTarget) =>
				this.exportSession(sessionId, modalMountTarget),
			onDeleteSession: (sessionId: string) => this.deleteSession(sessionId),
			onSelectProvider: (providerId: string) => this.selectProvider(providerId),
			onSelectModel: (modelId: string) => this.selectModel(modelId),
			onSendMessage: (
				text: string,
				activeContextItems?: UserContextItem[],
				sessionId?: string,
			) => this.sendMessage(text, activeContextItems, sessionId),
			onUpdateInputDraft: (text: string, sessionId?: string) =>
				this.updateInputDraft(text, sessionId),
			onAddUserContext: (item: UserContextItem, sessionId?: string) =>
				this.addUserContext(item, sessionId),
			onRemoveUserContext: (index: number, sessionId?: string) =>
				this.removeUserContext(index, sessionId),
			onResolvePendingContextItem: (
				id: string,
				replacement: UserContextItem | null,
				sessionId?: string,
			) => this.resolvePendingContextItem(id, replacement, sessionId),
			onDropContextItem: (_path: string) => {
				// overridden by the view layer which has access to app.vault
			},
			onStopActiveRun: () => this.stopActiveSessionRun(),
			onCancelPendingSubmission: (id: string) =>
				this.cancelPendingSubmission(id),
			onDeleteMessage: (messageId: string) => this.deleteMessage(messageId),
			onRegenerateMessage: (messageId: string) => {
				void this.regenerateMessage(messageId)
			},
			onRecallMessage: (
				messageId: string,
				options?: { restoreFiles?: boolean; sessionId?: string },
			) => this.recallMessage(messageId, options),
			onRecallHasReversibleOps: (messageId: string) =>
				this.messageOps.recallMessageHasReversibleOps(messageId),
			onToggleSessionMcpServer: (serverName: string) =>
				void this.toggleSessionMcpServer(serverName),
		}
	}

	selectProvider(providerId: string) {
		this.selection.selectProvider(providerId)
	}

	selectModel(modelId: string) {
		this.selection.selectModel(modelId)
	}

	/**
	 * K9 pass-through: the UI captures `activeSessionId` synchronously and
	 * resumes with it after an `await`. An explicit id is routed to the captured
	 * session; `undefined` keeps the legacy late-bound behaviour for synchronous
	 * call sites.
	 */
	addUserContext(item: UserContextItem, sessionId?: string) {
		this.userContextManager.addUserContext(item, sessionId)
	}

	removeUserContext(index: number, sessionId?: string) {
		this.userContextManager.removeUserContext(index, sessionId)
	}

	resolvePendingContextItem(
		id: string,
		replacement: UserContextItem | null,
		sessionId?: string,
	) {
		this.userContextManager.resolvePendingContextItem(
			id,
			replacement,
			sessionId,
		)
	}

	updateInputDraft(text: string, sessionId?: string) {
		this.userContextManager.updateInputDraft(text, sessionId)
	}

	deleteMessage(messageId: string) {
		this.messageOps.deleteMessage(messageId)
	}

	async recallMessage(
		messageId: string,
		options?: { restoreFiles?: boolean; sessionId?: string },
	): Promise<RecallMessageResult | void> {
		return this.messageOps.recallMessage(messageId, {
			restoreFiles: options?.restoreFiles,
			session: options?.sessionId,
		})
	}

	async regenerateMessage(messageId: string) {
		await this.messageOps.regenerateMessage(messageId)
	}
}
