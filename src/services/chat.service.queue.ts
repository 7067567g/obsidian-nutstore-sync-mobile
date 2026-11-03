import { getModelById, getProviderById } from '~/ai/catalog/config'
import type { UserContextItem } from '~/ai/chat/context/user-context'
import { extractErrorMessage } from '~/ai/chat/error-utils'
import { buildAgentMessages } from '~/ai/chat/messages/ui-message'
import {
	ContextCompressionFailedError,
	resolveSummaryContext,
	runContextCompression,
} from '~/ai/chat/runtime/context-compression'
import { isSessionExecutionPending } from '~/ai/chat/runtime/runtime-state'
import { isAbortError } from '~/ai/transport/abort'
import i18n from '~/i18n'
import { ChatServiceLifecycle } from './chat.service.lifecycle'

export class ChatServiceQueue extends ChatServiceLifecycle {
	async toggleSessionMcpServer(serverName: string) {
		await this.initialize()
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}
		const disabled = new Set(session.disabledMcpServers ?? [])
		if (disabled.has(serverName)) {
			disabled.delete(serverName)
		} else {
			disabled.add(serverName)
		}
		session.disabledMcpServers = disabled.size > 0 ? [...disabled] : undefined
		this.notify()
		this.store.persistSessionSoon(session)
	}

	async sendMessage(
		text: string,
		activeContextItems: UserContextItem[] = [],
		sessionId?: string,
	): Promise<boolean> {
		await this.initialize()
		const normalizedText = text.trim()
		// K9: a caller-captured session id must never be re-resolved after the
		// `await` above. If the captured session is gone, abort instead of
		// leaking the message into whatever session is active now.
		const captured = this.resolveCapturedSession(sessionId)
		if (sessionId !== undefined && !captured) {
			return false
		}
		const session =
			captured || this.getLoadedActiveSession() || (await this.createSession())
		if (!session) {
			return false
		}
		const runtime = this.runtimeStates.get(session.id)
		const userContext = this.userContextManager.dedupeUserContextItems([
			...runtime.draft.userContext,
			...activeContextItems,
		])
		if (!normalizedText && userContext.length === 0) {
			return false
		}

		if (!this.selection.validateSessionSelection(session)) {
			return false
		}

		const turnId = this.sessionProcessor.enqueueUserSubmission(session.id, {
			text: normalizedText,
			userContext,
		})
		if (!turnId) return false
		runtime.draft = {
			text: '',
			userContext: [],
		}
		this.notify()
		return true
	}

	async compressContext() {
		await this.initialize()
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}

		const runtime = this.runtimeStates.get(session.id)
		if (isSessionExecutionPending(runtime)) {
			return
		}
		if (!this.selection.validateSessionSelection(session)) {
			return
		}

		const agent = this.messageFactory.getActiveAgent(session)
		this.compactionCoordinator.cancel(session.id, agent.id)
		runtime.runState = 'compressing'
		this.notify()

		const abortController = new AbortController()
		runtime.manualCompressionAbortController = abortController
		let task!: Promise<void>
		task = Promise.resolve().then(async () => {
			try {
				if (agent.timeline.length > 0) {
					const provider = this.selection.getProviderOrThrow(session)
					await this.plugin.nutstoreLlmGatewayService.ensureProviderReady(
						provider,
					)
					if (abortController.signal.aborted) {
						return
					}
					const model = this.selection.getModelOrThrow(provider, session)
					const isCurrentSelection = () =>
						session.model?.providerId === provider.id &&
						session.model?.modelId === model.id
					const result = await runContextCompression({
						provider,
						model,
						session,
						agent,
						backend:
							this.plugin.settings.ai.compressionBackend ?? 'deterministic',
						store: this.store,
						messageFactory: this.messageFactory,
						...(await resolveSummaryContext(
							agent,
							session,
							model,
							this.toolExecutor,
							this.plugin.app,
						)),
						buildMessages: (messages, tools) =>
							buildAgentMessages(
								agent,
								tools,
								this.userContextManager,
								messages,
							),
						isCancelled: () =>
							abortController.signal.aborted ||
							this.state.deletedSessionIds.has(session.id) ||
							!isCurrentSelection(),
						abortSignal: abortController.signal,
					})
					if (result !== 'committed' && result !== 'cancelled') {
						throw new ContextCompressionFailedError(
							i18n.t('chatbox.errors.contextCompressionFailed'),
						)
					}
				}
			} catch (error) {
				if (isAbortError(error) && abortController.signal.aborted) {
					return
				}
				const provider = getProviderById(
					this.plugin.settings.ai.providers,
					session.model?.providerId,
				)
				const model = getModelById(provider, session.model?.modelId)
				this.messageFactory.reportFatalError(
					session,
					extractErrorMessage(error, i18n.t('chatbox.requestFailed')),
					{
						providerId: provider?.id,
						providerName: provider?.name,
						modelId: model?.id,
						modelName: model?.name,
					},
					agent,
				)
				await this.store.persistSession(session)
			} finally {
				if (runtime.manualCompressionAbortController === abortController) {
					runtime.manualCompressionAbortController = undefined
				}
				if (runtime.processing === task) runtime.processing = undefined
				runtime.runState = 'idle'
				this.notify()
				if (runtime.scheduler.queued.length > 0) {
					void this.sessionProcessor.start(session.id)
				}
			}
		})

		runtime.processing = task
		await task
	}

	/**
	 * K9: resolve a caller-captured session id against the live store; returns
	 * undefined when the session was removed, so callers can abort a late write.
	 */
	private resolveCapturedSession(sessionId?: string) {
		if (sessionId === undefined) return undefined
		if (this.state.deletedSessionIds.has(sessionId)) return undefined
		return this.state.loadedSessions.get(sessionId)
	}

	cancelPendingSubmission(turnId: string): boolean {
		const session = this.getLoadedActiveSession()
		if (!session) return false
		return this.sessionProcessor.cancelQueuedSubmission(session.id, turnId)
	}

	stopActiveSessionRun() {
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}

		void this.stopSessionRun(session)
	}
}
