import { ensureChatRootNomedia } from './ai/chat/session/session-files'
import { toBase64 } from 'js-base64'
import { Menu, normalizePath, Notice, Plugin } from 'obsidian'
import { createSelectedTextContextItem } from './ai/chat/context/user-context'
import { registerChatboxAiIcon } from './assets/icons/obsidian-nutstore-ai-icon'
import { SyncRibbonManager } from './components/SyncRibbonManager'
import { DiagnosticsLogFile } from './diagnostics/log-file'
import {
	exportDiagnosticsPackage,
	exportPerfSnapshot,
} from './diagnostics/report'
import {
	ABNORMAL_START_NOTICE_THRESHOLD,
	markBackgrounded,
	markCleanExit,
	markStartup,
	readStartupState,
	type StartupState,
} from './diagnostics/startup-state'
import { runSelfCheck } from './diagnostics/self-check'
import type { DiagnosticsSelfCheckReport } from './diagnostics/self-check'
import { emitCancelSync } from './events'
import i18n from './i18n'
import AIConflictResolverService from './services/ai-conflict-resolver.service'
import ChatService from './services/chat.service'
import CommandService from './services/command.service'
import EventsService from './services/events.service'
import GcService from './services/gc.service'
import I18nService from './services/i18n.service'
import LoggerService from './services/logger.service'
import McpService from './services/mcp.service'
import ModelsPresetService from './services/models-preset.service'
import NutstoreLlmGatewayService from './services/nutstore-llm-gateway.service'
import { ProgressService } from './services/progress.service'
import ProtocolService from './services/protocol.service'
import RealtimeSyncService from './services/realtime-sync.service'
import ScheduledSyncService from './services/scheduled-sync.service'
import { BaseService } from './services/service.interface'
import SettingsService from './services/settings.service'
import { StatusService } from './services/status.service'
import SyncExecutorService from './services/sync-executor.service'
import { WebDAVService } from './services/webdav.service'
import {
	NutstoreLocalSettings,
	NutstoreSettings,
	NutstoreSettingTab,
} from './settings'
import { decryptOAuthResponse } from './utils/decrypt-ticket-response'
import logger from './utils/logger'
import { stdRemotePath } from './utils/std-remote-path'
import ChatboxView, { CHATBOX_VIEW_TYPE } from './views/chatbox.view'

export default class NutstorePlugin extends Plugin {
	declare public settings: NutstoreSettings

	public isSyncing: boolean = false
	public localSettings!: NutstoreLocalSettings
	public settingTab!: NutstoreSettingTab
	public diagnosticsLogFile = new DiagnosticsLogFile(this.app)
	public selfCheckReport: DiagnosticsSelfCheckReport | null = null
	public startupState: StartupState | null = null
	private lastPerfSnapshotAt = 0

	public commandService = new CommandService(this)
	public eventsService = new EventsService(this)
	public i18nService = new I18nService(this)
	public loggerService = new LoggerService(this)
	public mcpService = new McpService(this)
	public modelsPresetService = new ModelsPresetService(this)
	public nutstoreLlmGatewayService = new NutstoreLlmGatewayService(this)
	public protocolService = new ProtocolService(this)
	public progressService = new ProgressService(this)
	public ribbonService = new SyncRibbonManager(this)
	public statusService = new StatusService(this)
	public webDAVService = new WebDAVService(this)
	public settingsService = new SettingsService(this)
	public syncExecutorService = new SyncExecutorService(this)
	public gcService = new GcService(this)
	public chatService = new ChatService(this)
	public aiConflictResolverService = new AIConflictResolverService(this)
	public realtimeSyncService = new RealtimeSyncService(
		this,
		this.syncExecutorService,
	)
	public scheduledSyncService = new ScheduledSyncService(
		this,
		this.syncExecutorService,
	)

	private get services(): BaseService[] {
		return [
			this.loggerService,
			this.modelsPresetService,
			this.nutstoreLlmGatewayService,
			this.webDAVService,
			this.syncExecutorService,
			this.gcService,
			this.settingsService,
			this.i18nService,
			this.statusService,
			this.progressService,
			this.eventsService,
			this.commandService,
			this.ribbonService,
			this.protocolService,
			this.realtimeSyncService,
			this.mcpService,
			this.chatService,
			this.aiConflictResolverService,
			this.scheduledSyncService,
		]
	}

	async onload() {
		registerChatboxAiIcon()
		const loadedServices: BaseService[] = []
		for (const service of this.services) {
			try {
				await service.onload()
				loadedServices.push(service)
			} catch (error) {
				logger.error('Failed to load service', error)
				// Roll back only the services that finished loading, newest first,
				// so a partially started plugin does not leak listeners/timers.
				await Promise.all(
					[...loadedServices].reverse().map((loaded) =>
						Promise.resolve()
							.then(() => loaded.onunload())
							.catch((rollbackError) => {
								logger.warn(
									'Failed to roll back service after onload failure',
									rollbackError,
								)
							}),
					),
				)
				throw error
			}
		}
		this.settingTab = new NutstoreSettingTab(this.app, this)
		this.addSettingTab(this.settingTab)
		this.registerView(CHATBOX_VIEW_TYPE, (leaf) => new ChatboxView(leaf, this))
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor, view) => {
				if (!editor.somethingSelected()) return
				menu.addItem((item) => {
					item
						.setTitle(
							i18n.language.startsWith('zh') ? '坚果云同步' : 'Nutstore Sync',
						)
						.setIcon('cloud')
					item.setSubmenu()
					const submenu = item.submenu
					if (!submenu) return
					submenu.addItem((subItem) => {
						subItem
							.setTitle(i18n.t('chatbox.addToContext'))
							.setIcon('message-square-plus')
							.onClick(async () => {
								const sel = editor.listSelections()[0]
								if (!sel) return
								const file = (
									view as {
										file?: { path: string; basename: string } | null
									}
								).file
								if (!file) return
								this.chatService.addUserContext(
									createSelectedTextContextItem({
										type: 'selection',
										filePath: file.path,
										range: {
											from: { line: sel.anchor.line, ch: sel.anchor.ch },
											to: { line: sel.head.line, ch: sel.head.ch },
										},
										selectedText: editor.getSelection(),
									}),
								)
								await this.commandService.openChatbox()
							})
					})
				})
			}),
		)

		await this.chatService.handleSettingsChanged()
		const previousStartup = await readStartupState(this.app)
		if (previousStartup?.lastExitClean === false) {
			try {
				await this.chatService.initialize()
			} catch (error) {
				logger.warn(
					'Failed to initialize chat service for recovery detection',
					error,
				)
			}
		}
		const recoveredToolCalls =
			this.chatService.consumeStartupRecoveredToolCalls()
		void ensureChatRootNomedia(this.app.vault).catch((error) => {
			logger.warn('Failed to ensure chat root .nomedia', error)
		})
		await this.runStartupBreadcrumb(recoveredToolCalls)
		void this.chatService.recoverPendingWrites().catch((error) => {
			logger.warn('Failed to recover pending chat writes', error)
		})
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.hidden) {
				void this.chatService.flushPendingSessions()
				this.schedulePerfSnapshot('visibility')
				this.recordBackgrounded()
			}
		})
		this.registerDomEvent(window, 'pagehide', () => {
			void this.chatService.flushPendingSessions()
			this.schedulePerfSnapshot('pagehide')
			this.recordBackgrounded()
		})
		const opsGcTimer = window.setTimeout(() => {
			void this.chatService.runOpsGcReport()
		}, 5000)
		this.register(() => window.clearTimeout(opsGcTimer))
		void this.runDiagnosticsSelfCheck()
	}

	private schedulePerfSnapshot(reason: 'visibility' | 'pagehide') {
		const now = Date.now()
		if (now - this.lastPerfSnapshotAt < 10_000) return
		this.lastPerfSnapshotAt = now
		void exportPerfSnapshot(this, { reason }).catch((error) => {
			logger.warn('Failed to export runtime perf snapshot', error)
		})
	}

	/**
	 * BOOT-01: leave a durable "was backgrounded" marker before Android may kill
	 * the process. The next start then treats the kill as ordinary instead of
	 * incrementing the crash-loop counter.
	 */
	private recordBackgrounded() {
		void markBackgrounded(this.app).catch((error) => {
			logger.warn('Failed to record background breadcrumb', error)
		})
	}

	private async runStartupBreadcrumb(recoveredToolCalls: number) {
		try {
			const state = await markStartup(this.app, this.manifest.version)
			this.startupState = state
			if (state.consecutiveAbnormalStarts >= ABNORMAL_START_NOTICE_THRESHOLD) {
				logger.info('Plugin restarted without a clean exit', {
					...state,
					recoveredToolCalls,
				})
				if (recoveredToolCalls > 0) {
					new Notice(i18n.t('startup.repeatedAbnormalStarts'))
				}
			}
		} catch (error) {
			logger.warn('Failed to record startup breadcrumb', error)
		}
	}

	private async runDiagnosticsSelfCheck() {
		try {
			const report = await runSelfCheck(this)
			this.selfCheckReport = report
			logger.info('Diagnostics self-check', report)
			await this.diagnosticsLogFile.flush()
			await exportDiagnosticsPackage(this, { reason: 'startup' })
		} catch (error) {
			logger.error('Diagnostics self-check failed', error)
		}
	}

	onunload(): void {
		this.settingTab?.unload()
		emitCancelSync()
		// Obsidian does not await `onunload`. Start the critical flush +
		// breadcrumb chain synchronously and keep service teardown independent
		// so a stalled or throwing service can never truncate chat flush or
		// `markCleanExit`.
		void this.finalizeOnUnload()
		void this.disposeServicesOnUnload()
		void exportPerfSnapshot(this, { reason: 'unload' }).catch((error) => {
			logger.warn('Failed to export unload perf snapshot', error)
		})
	}

	private async finalizeOnUnload() {
		try {
			await this.chatService.onunload()
		} catch (error) {
			logger.error('Failed to flush chat sessions on unload', error)
		}
		try {
			await this.diagnosticsLogFile.flush()
		} catch (error) {
			logger.warn('Failed to flush diagnostics log on unload', error)
		}
		try {
			await markCleanExit(this.app)
		} catch (error) {
			logger.warn('Failed to write clean-exit breadcrumb', error)
		}
	}

	private async disposeServicesOnUnload() {
		await Promise.all(
			[...this.services]
				.reverse()
				.filter((service) => service !== this.chatService)
				.map((service) =>
					Promise.resolve()
						.then(() => service.onunload())
						.catch((error) => {
							logger.error('Failed to unload service', error)
						}),
				),
		)
	}

	toggleSyncUI(isSyncing: boolean) {
		this.isSyncing = isSyncing
		this.ribbonService.update()
	}

	async getDecryptedOAuthInfo() {
		return decryptOAuthResponse(this.settings.oauthResponseText)
	}

	async getToken() {
		let token
		if (this.settings.loginMode === 'sso') {
			let oauth
			try {
				oauth = await this.getDecryptedOAuthInfo()
			} catch {
				throw new Error(i18n.t('sync.error.ssoTokenInvalid'))
			}
			token = `${oauth.username}:${oauth.access_token}`
		} else {
			token = `${this.settings.account}:${this.settings.credential}`
		}
		return toBase64(token)
	}

	async getRemoteAccountId() {
		if (this.settings.loginMode === 'sso') {
			return (await this.getDecryptedOAuthInfo()).username.trim()
		}
		return this.settings.account.trim()
	}

	/**
	 * 检查账号配置是否完整
	 * @returns true 表示配置完整，false 表示未配置或配置不完整
	 */
	isAccountConfigured(): boolean {
		if (this.settings.loginMode === 'sso') {
			// SSO 模式：检查是否有 OAuth 响应数据
			return (
				!!this.settings.oauthResponseText &&
				this.settings.oauthResponseText.trim() !== ''
			)
		} else {
			// 手动模式：检查账号和凭证是否都已填写
			return (
				!!this.settings.account &&
				this.settings.account.trim() !== '' &&
				!!this.settings.credential &&
				this.settings.credential.trim() !== ''
			)
		}
	}

	get remoteBaseDir() {
		let remoteDir = normalizePath(this.settings.remoteDir.trim())
		if (remoteDir === '' || remoteDir === '/') {
			remoteDir = this.app.vault.getName()
		}
		return stdRemotePath(remoteDir)
	}
}
