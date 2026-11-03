import { Notice } from 'obsidian'
import { UserContextManager } from '~/ai/chat/context/user-context-manager'
import type { ChatSession, ChatSessionIndexItem } from '~/ai/chat/domain'
import { MessageFactory } from '~/ai/chat/messages/message-factory'
import { MessageOps } from '~/ai/chat/messages/message-ops'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import { Notifier } from '~/ai/chat/notifier'
import { CHAT_INDEX_KEY, CHAT_META_KEY } from '~/ai/chat/prompts'
import { AgentRunner } from '~/ai/chat/runtime/agent-runner'
import { ChatState } from '~/ai/chat/runtime/chat-state'
import { ContextCompactionCoordinator } from '~/ai/chat/runtime/context-compaction-coordinator'
import { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import { Selection } from '~/ai/chat/runtime/selection'
import { SessionProcessor } from '~/ai/chat/runtime/session-processor'
import { TaskManager } from '~/ai/chat/runtime/task-manager'
import { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import {
	CHAT_SESSIONS_DIR,
	SessionsFileBackend,
} from '~/ai/chat/session/session-files'
import { SessionRecovery } from '~/ai/chat/session/session-recovery'
import {
	SessionStore,
	type SessionLegacyStore,
} from '~/ai/chat/session/session-store'
import type { AIProviderConfig } from '~/ai/core/types'
import { SkillRepository } from '~/ai/skills/repository'
import { createAbortError } from '~/ai/transport/abort'
import i18n from '~/i18n'
import { chatMetaKV, chatSessionKV, type ChatMetaRecord } from '~/storage'
import { createUniqueWordId } from '~/utils/create-id'
import type NutstorePlugin from '~/index'
import { BaseService } from './service.interface'

export class ChatServiceCore extends BaseService {
	protected readonly state = new ChatState()
	protected readonly notifier = new Notifier()
	protected readonly runtimeStates = new RuntimeStates(this.state)
	protected readonly selection: Selection
	protected readonly store: SessionStore
	protected readonly toolExecutor: ToolExecutor
	protected readonly taskManager: TaskManager
	protected readonly userContextManager: UserContextManager
	protected readonly messageFactory: MessageFactory
	protected readonly messageOps: MessageOps
	protected readonly sessionProcessor: SessionProcessor
	protected readonly compactionCoordinator: ContextCompactionCoordinator
	protected readonly skillRepository: SkillRepository

	constructor(protected plugin: NutstorePlugin) {
		super()
		this.skillRepository = new SkillRepository(plugin.app)
		this.selection = new Selection(
			() => plugin.settings.ai,
			this.state,
			() => this.notify(),
			(session) => this.store.persistSessionSoon(session),
		)
		const legacyStore = this.createLegacySessionStore()
		this.store = new SessionStore(
			this.state,
			this.selection,
			new SessionsFileBackend(plugin.app.vault, {
				maxInlineOperationBytes: () =>
					plugin.settings.ai.maxInlineOperationBytes,
				// H4/K16 (WS-7): the production backend revalidates cached
				// sessions against the on-disk mtime/size so external rewrites
				// (sync pull, import, second window) are picked up on switch-back.
				trackSessionFileVersions: true,
			}),
			legacyStore,
			new SessionRecovery(plugin.app.vault, CHAT_SESSIONS_DIR),
			(sessionId, session) => {
				this.runtimeStates.resetExecution(sessionId)
				this.taskManager?.cleanupSessionAgentTracking(session)
			},
		)
		this.toolExecutor = new ToolExecutor(
			plugin.app,
			() => plugin.settings.ai,
			this.state,
			this.runtimeStates,
			plugin.mcpService,
			{
				getSettingsSnapshot: () => plugin.settings,
				updateSettings: (patch) =>
					plugin.settingsService.applySettingsPatch(patch),
			},
		)
		this.userContextManager = new UserContextManager(
			this.state,
			this.runtimeStates,
			() => this.notify(),
		)
		this.messageFactory = new MessageFactory(
			plugin.app,
			() => this.notify(),
			this.skillRepository,
		)
		const ensureProviderReady = (provider: AIProviderConfig) =>
			plugin.nutstoreLlmGatewayService.ensureProviderReady(provider)
		const agentRunner = new AgentRunner(
			this.toolExecutor,
			this.store,
			this.messageFactory,
			() => this.notify(),
			plugin.app,
		)
		this.compactionCoordinator = new ContextCompactionCoordinator(
			this.store,
			this.messageFactory,
		)
		this.taskManager = new TaskManager(
			plugin.app,
			ensureProviderReady,
			this.state,
			this.selection,
			this.store,
			() => this.notify(),
			this.toolExecutor,
			this.messageFactory,
			agentRunner,
			this.compactionCoordinator,
			() => plugin.settings.ai.compressionBackend ?? 'deterministic',
		)
		this.toolExecutor.setDispatchTaskHandler((params, origin) =>
			this.taskManager.dispatchTask(params, origin),
		)
		const reportTransientError = (message: string) => new Notice(message)
		this.messageOps = new MessageOps(
			plugin.app,
			this.state,
			this.runtimeStates,
			this.store,
			() => this.notify(),
			reportTransientError,
			this.messageFactory,
			(session) => this.selection.validateSessionSelection(session),
			(sessionId, messageId) =>
				this.sessionProcessor.enqueueRegenerate(sessionId, messageId),
			this.skillRepository,
			{
				getSettingsSnapshot: () => plugin.settings,
				updateSettings: (patch) =>
					plugin.settingsService.applySettingsPatch(patch),
			},
			this.toolExecutor.getFileSystemManager(),
		)
		this.sessionProcessor = new SessionProcessor(
			ensureProviderReady,
			this.state,
			this.runtimeStates,
			this.store,
			() => this.notify(),
			this.selection,
			this.messageFactory,
			this.messageOps,
			this.userContextManager,
			agentRunner,
			this.compactionCoordinator,
			this.taskManager,
			reportTransientError,
			() => plugin.settings.ai.compressionBackend ?? 'deterministic',
		)
		this.taskManager.setMasterAgentInputHandler((sessionId, input, origin) =>
			this.sessionProcessor.enqueueAgentInput(sessionId, input, origin),
		)
	}

	protected notify() {
		this.notifier.notify()
	}

	protected getActiveSessionTitle() {
		return (
			this.state.sessionIndex.find(
				(item) => item.id === this.state.activeSessionId,
			)?.title || i18n.t('chatbox.newChat')
		)
	}

	private createLegacySessionStore(): SessionLegacyStore {
		return {
			listSessionKeys: async () => {
				try {
					return await chatSessionKV.keys()
				} catch {
					return []
				}
			},
			getSession: async (id) => {
				try {
					return await chatSessionKV.get(id)
				} catch {
					return undefined
				}
			},
			unsetSession: (id) => chatSessionKV.unset(id),
			getMeta: async () => {
				try {
					const [metaRaw, indexRaw] = await Promise.all([
						chatMetaKV.get(CHAT_META_KEY),
						chatMetaKV.get(CHAT_INDEX_KEY),
					])
					const meta = isChatMetaRecord(metaRaw) ? metaRaw : null
					const index = Array.isArray(indexRaw)
						? indexRaw.filter(isChatSessionIndexItem)
						: []
					return { meta, index }
				} catch {
					return { meta: null, index: [] }
				}
			},
		}
	}

	protected async stopSessionRun(
		session: ChatSession,
		options: { waitForWorker?: boolean } = {},
	) {
		const runtime = this.runtimeStates.get(session.id)
		if (await this.sessionProcessor.stopActiveTurn(session.id)) {
			if (options.waitForWorker) await runtime.processing
			return
		}
		const controller = runtime.manualCompressionAbortController
		if (!controller) return
		controller.abort(createAbortError('Stopped by user'))
		await runtime.processing
	}

	protected getLoadedActiveSession() {
		return this.state.activeSessionId
			? this.state.loadedSessions.get(this.state.activeSessionId)
			: undefined
	}

	protected isUntitledEmptyActiveSession(session: ChatSession) {
		const runtime = this.runtimeStates.get(session.id)
		return (
			this.getActiveSessionTitle() === i18n.t('chatbox.newChat') &&
			session.subagents.master.timeline.length === 0 &&
			runtime.draft.text.trim().length === 0 &&
			runtime.draft.userContext.length === 0 &&
			runtime.scheduler.queued.length === 0 &&
			!runtime.scheduler.active
		)
	}

	protected async createEmptySession(): Promise<ChatSession> {
		const { providerId, modelId } =
			this.selection.getInitialSelectionForNewSession()
		const now = Date.now()
		return {
			schemaVersion: 2,
			id: await createUniqueWordId('session', (id) =>
				this.state.sessionIndex.some((item) => item.id === id),
			),
			createdAt: now,
			updatedAt: now,
			model: providerId && modelId ? { providerId, modelId } : undefined,
			subagents: { master: createEmptyMasterAgent(now) },
		}
	}
}

function isChatMetaRecord(value: unknown): value is ChatMetaRecord {
	return (
		!!value &&
		typeof value === 'object' &&
		Array.isArray((value as ChatMetaRecord).orderedSessionIds)
	)
}

function isChatSessionIndexItem(value: unknown): value is ChatSessionIndexItem {
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as ChatSessionIndexItem).id === 'string' &&
		typeof (value as ChatSessionIndexItem).title === 'string' &&
		typeof (value as ChatSessionIndexItem).createdAt === 'number' &&
		typeof (value as ChatSessionIndexItem).updatedAt === 'number'
	)
}
