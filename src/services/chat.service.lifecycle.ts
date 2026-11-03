import { Notice } from 'obsidian'
import type { UserContextItem } from '~/ai/chat/context/user-context'
import { exportSessionToMarkdownFile } from '~/ai/chat/messages/export-session'
import { deriveTitle } from '~/ai/chat/messages/message-utils'
import { removeSessionSpill } from '~/ai/chat/runtime/tool-output-retention'
import { formatOpsGcReport, type OpsGcReport } from '~/ai/chat/session/ops-gc'
import type { ChatModalMountTarget } from '~/ai/chat/ui/modal-mount'
import SessionExportModal from '~/components/SessionExportModal'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import { ChatServiceCore } from './chat.service.core'

export class ChatServiceLifecycle extends ChatServiceCore {
	/**
	 * #102 lifecycle report. Startup stays report-only: retention deletion is
	 * never triggered here, so a settings mistake cannot erase user data on boot.
	 */
	async runOpsGcReport(): Promise<OpsGcReport> {
		const report = await this.store.collectOperationGcReport({
			retention: {
				policy: this.plugin.settings.retention,
				deleteExpired: false,
			},
		})
		logger.info('Ops GC report', report)
		logger.info('Ops GC summary', formatOpsGcReport(report))
		return report
	}

	async recoverPendingWrites() {
		await this.store.recoverPendingWrites()
	}

	consumeStartupRecoveredToolCalls() {
		return this.store.consumeStartupRecoveredToolCalls()
	}

	async flushPendingSessions() {
		await this.store.flushAll().catch((error) => {
			logger.error('Failed to flush chat sessions', error)
		})
	}

	protected async teardownOnUnload() {
		for (const [sessionId, session] of this.state.loadedSessions) {
			this.compactionCoordinator.cancel(sessionId)
			this.taskManager.cancelAllNonTerminalAgents(session)
			this.taskManager.cleanupSessionAgentTracking(session)
			this.runtimeStates.resetExecution(sessionId)
		}
		// Flush the coalesced write-behind queues before marking sessions deleted,
		// so the final state (including cancellation events) reaches disk.
		await this.store.flushAll().catch((error) => {
			logger.error('Failed to flush chat sessions on unload', error)
		})
		for (const sessionId of this.state.loadedSessions.keys()) {
			this.state.deletedSessionIds.add(sessionId)
		}
	}

	async initialize() {
		if (this.state.initialization) {
			return this.state.initialization
		}

		this.state.initialization = this.initializeInternal()
			.then(() => {
				this.state.initialized = true
				this.notify()
			})
			.catch((error) => {
				this.state.initialization = undefined
				throw error
			})
		return this.state.initialization
	}

	private async initializeInternal() {
		const initialSession = await this.store.loadInitialSession()
		if (initialSession) {
			this.taskManager.restoreMasterTaskContinuations(initialSession)
		}

		if (this.state.sessionIndex.length === 0) {
			const session = await this.createEmptySession()
			this.state.activeSessionId = session.id
			this.state.loadedSessions.set(session.id, session)
			this.store.upsertSessionIndexItem(session)
			await this.store.persistSession(session)
			await this.store.persistMetaAndIndex()
			return
		}
	}

	subscribe(listener: () => void) {
		return this.notifier.subscribe(listener)
	}

	async handleSettingsChanged() {
		this.selection.syncPendingSelectionWithSettings()
		if (!this.state.initialization) {
			this.notify()
			return
		}

		await this.initialize()
		const persisted: Promise<unknown>[] = []
		for (const session of this.state.loadedSessions.values()) {
			if (this.selection.sanitizeSessionSelection(session)) {
				persisted.push(this.store.persistSession(session))
			}
		}

		if (persisted.length > 0) {
			await Promise.all(persisted)
		}
		this.notify()
	}

	async ensureSession() {
		await this.initialize()
	}

	async createSession() {
		await this.initialize()
		const activeSession = this.getLoadedActiveSession()
		if (activeSession && this.isUntitledEmptyActiveSession(activeSession)) {
			return activeSession
		}
		const session = await this.createEmptySession()
		// Any in-flight switch is now stale: this new session owns `active`.
		this.state.switchGeneration += 1
		this.state.loadedSessions.set(session.id, session)
		this.state.activeSessionId = session.id
		this.store.upsertSessionIndexItem(session, i18n.t('chatbox.newChat'), true)
		this.runtimeStates.get(session.id)
		this.notify()
		this.store.persistSessionSoon(session)
		void this.store.persistMetaAndIndex().catch((error) => {
			logger.error('Failed to persist chat session index', error)
		})
		return session
	}

	async createDraftSession(text: string, userContext: UserContextItem[] = []) {
		const session = await this.createSession()
		for (const item of userContext) {
			this.userContextManager.addUserContext(item)
		}
		this.userContextManager.updateInputDraft(text)
		this.notify()
		return session
	}

	async switchSession(sessionId: string) {
		await this.initialize()
		if (!this.state.sessionIndex.some((item) => item.id === sessionId)) {
			return
		}

		// Last click wins (H3): tag this attempt and re-check after every await
		// so a slow cold load cannot overwrite a newer switch's active session.
		const generation = ++this.state.switchGeneration
		const session = await this.store.loadSessionById(sessionId)
		if (generation !== this.state.switchGeneration) {
			return
		}
		this.state.activeSessionId = sessionId
		this.taskManager.restoreMasterTaskContinuations(session)
		await this.store.persistMetaAndIndex()
		if (generation !== this.state.switchGeneration) {
			return
		}
		this.notify()
	}

	async deleteSession(sessionId: string) {
		await this.initialize()
		if (!this.state.sessionIndex.some((item) => item.id === sessionId)) {
			return
		}

		this.compactionCoordinator.cancel(sessionId)
		const session = this.state.loadedSessions.get(sessionId)
		if (session) {
			await this.stopSessionRun(session, { waitForWorker: true })
			this.taskManager.cancelAllNonTerminalAgents(session)
			this.taskManager.cleanupSessionAgentTracking(session)
		}

		// N2/K3: mark the id deleted only for the duration of the commit. The
		// backend delete is the commit point; if it fails, roll the mark back so
		// the session keeps being writable instead of being poisoned forever.
		this.state.deletedSessionIds.add(sessionId)
		try {
			await this.store.deleteSession(sessionId)
		} catch (error) {
			this.state.deletedSessionIds.delete(sessionId)
			logger.error(`Failed to delete chat session ${sessionId}`, error)
			throw error
		}

		// Commit succeeded: mutate the index/active only now, so a failing delete
		// can never leave a half-committed index or a stale deleted id (N2).
		this.state.sessionIndex = this.state.sessionIndex.filter(
			(item) => item.id !== sessionId,
		)
		this.state.loadedSessions.delete(sessionId)
		this.state.runtimeBySessionId.delete(sessionId)
		this.state.autoApproveRequestsBySessionId.delete(sessionId)
		if (this.state.activeSessionId === sessionId) {
			// Deleting the active session commits a new active id; a switch that
			// is still loading must not resurrect the deleted one (H3).
			this.state.switchGeneration += 1
			const nextActiveSessionId = this.state.sessionIndex[0]?.id
			this.state.activeSessionId = nextActiveSessionId
			if (nextActiveSessionId) {
				// N3: a transient read failure of the fallback must not abort the
				// delete; degrade to "no loaded active session" and let a later
				// switch retry the read.
				await this.store.loadSessionById(nextActiveSessionId).catch((error) => {
					logger.warn(
						`Failed to load next active chat session ${nextActiveSessionId}`,
						error,
					)
					this.state.activeSessionId = undefined
				})
			}
		}

		await removeSessionSpill(this.plugin.app.vault, sessionId).catch(
			(error) => {
				logger.warn('Failed to remove session spill directory', error)
			},
		)
		await this.store.persistMetaAndIndex()
		this.notify()
		new Notice(i18n.t('chatbox.sessionDeleted'))
	}

	async exportSession(
		sessionId: string,
		modalMountTarget?: ChatModalMountTarget,
	) {
		await this.initialize()
		if (!this.state.sessionIndex.some((item) => item.id === sessionId)) {
			new Notice(i18n.t('chatbox.errors.sessionNotFound'))
			return
		}

		const options = await SessionExportModal.open(
			this.plugin.app,
			modalMountTarget ?? this.getChatModalMountTarget(),
		)
		if (!options) {
			return
		}

		try {
			const session = await this.store.loadSessionById(sessionId)
			const title =
				this.state.sessionIndex.find((item) => item.id === sessionId)?.title ||
				deriveTitle(session)
			const file = await exportSessionToMarkdownFile({
				vault: this.plugin.app.vault,
				manifestId: this.plugin.manifest.id,
				manifestVersion: this.plugin.manifest.version,
				session,
				title,
				includeToolMessages: options.includeToolMessages,
			})
			const leaf = this.plugin.app.workspace.getLeaf('tab')
			await leaf.openFile(file)
			new Notice(i18n.t('chatbox.exportSaved', { fileName: file.path }))
		} catch (error) {
			new Notice(i18n.t('chatbox.exportFailed'))
			logger.error('Failed to export chat session:', error)
		}
	}

	setChatModalHost(rootEl?: HTMLElement) {
		this.state.chatModalHostEl = rootEl?.isConnected ? rootEl : undefined
	}

	getChatModalMountTarget() {
		return this.toolExecutor.getChatModalMountTarget()
	}
}
