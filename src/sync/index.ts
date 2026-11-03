import { chunk } from 'lodash-es'
import { Notice, Platform, Vault } from 'obsidian'
import { Subscription } from 'rxjs'
import { WebDAVClient } from 'webdav'
import FailedTasksModal, { FailedTaskInfo } from '~/components/FailedTasksModal'
import TaskListConfirmModal from '~/components/TaskListConfirmModal'
import {
	CompletedTask,
	emitEndSync,
	emitPreparingSync,
	emitSyncCancelled,
	emitSyncPreparationProgress,
	emitStartSync,
	emitSyncError,
	emitSyncProgress,
	type SyncPreparationProgress,
	onCancelSync,
} from '~/events'
import IFileSystem from '~/fs/fs.interface'
import { LocalVaultFileSystem } from '~/fs/local-vault'
import { NutstoreFileSystem } from '~/fs/nutstore'
import i18n from '~/i18n'
import CacheService from '~/services/cache-v1.service'
import { SyncPolicy } from '~/settings'
import { syncRecordKV } from '~/storage'
import { SyncRecord } from '~/storage/sync-record'
import { createSyncLogger, formatSyncLogPrefix, type SyncLogger } from './log'
import { computeEffectiveFilterRules } from '~/utils/config-dir-rules'
import { getDBKey } from '~/utils/get-db-key'
import getTaskName from '~/utils/get-task-name'
import { is503Error } from '~/utils/is-503-error'
import {
	getNutstoreDavEndpoint,
	getNutstoreNsdavEndpoint,
} from '~/utils/nutstore-endpoints'
import { stdRemotePath } from '~/utils/std-remote-path'
import NutstorePlugin from '~/index'
import ReceiveOnlySyncDecider, {
	ReceiveOnlyRevertLocalChangesSyncDecider,
} from './decision/receive-only.decider'
import SendOnlySyncDecider, {
	SendOnlyOverrideChangesSyncDecider,
} from './decision/send-only.decider'
import TwoWaySyncDecider from './decision/two-way.decider'
import CleanRecordTask from './tasks/clean-record.task'
import ConflictResolveTask from './tasks/conflict-resolve.task'
import MkdirLocalTask from './tasks/mkdir-local.task'
import MkdirRemoteTask from './tasks/mkdir-remote.task'
import NoopTask from './tasks/noop.task'
import PullTask from './tasks/pull.task'
import PushTask from './tasks/push.task'
import RemoveLocalTask from './tasks/remove-local.task'
import RemoveRemoteTask from './tasks/remove-remote.task'
import SkippedTask from './tasks/skipped.task'
import { BaseTask, TaskResult } from './tasks/task.interface'
import { mergeMkdirTasks } from './utils/merge-mkdir-tasks'
import { mergeRemoveRemoteTasks } from './utils/merge-remove-remote-tasks'
import { resolveAutoSyncDeleteConfirm } from './delete-confirm'
import {
	didTaskReloadPluginSettings,
	execTasks,
	handle503Error,
	updateMtimeInRecord as updateMtimeInRecordImpl,
} from './task-execution'
import {
	countRecordUpdateOperations,
	type UpdateMtimeProgress,
} from './utils/update-records'

export enum SyncStartMode {
	MANUAL_SYNC = 'manual_sync',
	AUTO_SYNC = 'auto_sync',
}

class SyncCancelledError extends Error {
	constructor() {
		super(i18n.t('sync.cancelled'))
		this.name = 'SyncCancelledError'
	}
}

export interface SyncStartResult {
	ended: boolean
	ranTasks: boolean
	shouldReloadSettings: boolean
}

export class NutstoreSync {
	remoteFs: IFileSystem
	localFS: IFileSystem
	isCancelled: boolean = false
	private preparationProgressEnabled = false

	private emitPreparationProgress(progress: SyncPreparationProgress): void {
		if (this.preparationProgressEnabled) {
			emitSyncPreparationProgress(progress)
		}
	}

	private throwIfCancelled(): void {
		if (this.isCancelled) {
			throw new SyncCancelledError()
		}
	}

	private subscriptions: Subscription[] = []
	private currentLogPrefix = '[[Sync]]'
	private currentLogger: SyncLogger = createSyncLogger(this.currentLogPrefix)

	constructor(
		private plugin: NutstorePlugin,
		private options: {
			vault: Vault
			token: string
			remoteAccountId: string
			remoteBaseDir: string
			webdav: WebDAVClient
		},
	) {
		this.options = Object.freeze(this.options)
		const filterRules = computeEffectiveFilterRules(plugin)
		this.remoteFs = new NutstoreFileSystem({
			...this.options,
			settings: plugin.settings,
			filterRules,
			onTraversalProgress: (traversal) => {
				this.emitPreparationProgress({
					phase:
						traversal.phase === 'complete' ? 'analyzing' : 'traversingRemote',
					traversal,
				})
			},
			throwIfCancelled: () => this.throwIfCancelled(),
		})
		this.localFS = new LocalVaultFileSystem({
			vault: this.options.vault,
			syncRecord: new SyncRecord(
				getDBKey(
					this.vault.getName(),
					this.remoteBaseDir,
					this.options.remoteAccountId,
					getNutstoreDavEndpoint(plugin.settings),
				),
				syncRecordKV,
			),
			filterRules,
			settings: plugin.settings,
		})
		this.subscriptions.push(
			onCancelSync().subscribe(() => {
				this.isCancelled = true
			}),
		)
	}

	async start({
		mode,
		syncPolicy = this.localSettings.syncPolicy,
	}: {
		mode: SyncStartMode
		syncPolicy?: SyncPolicy
	}): Promise<SyncStartResult> {
		this.currentLogPrefix = formatSyncLogPrefix({
			mode,
			policy: syncPolicy,
		})
		this.currentLogger = createSyncLogger(this.currentLogPrefix)
		try {
			const showNotice = mode === SyncStartMode.MANUAL_SYNC
			this.preparationProgressEnabled = showNotice
			let preparingEmitted = false
			const emitPreparingOnce = () => {
				if (preparingEmitted) {
					return
				}
				emitPreparingSync({ showNotice })
				preparingEmitted = true
			}
			if (showNotice) {
				emitPreparingOnce()
			}

			const settings = this.settings
			const webdav = this.webdav
			const remoteBaseDir = stdRemotePath(this.options.remoteBaseDir)
			this.logger.info('[Sync] Endpoint:', {
				loginMode: settings.loginMode,
				dav: getNutstoreDavEndpoint(settings),
				nsdav: getNutstoreNsdavEndpoint(settings),
				remoteBaseDir,
			})
			const syncRecord = new SyncRecord(
				getDBKey(
					this.vault.getName(),
					this.remoteBaseDir,
					this.options.remoteAccountId,
					getNutstoreDavEndpoint(settings),
				),
				syncRecordKV,
			)
			const cacheService = new CacheService(this.plugin)

			this.emitPreparationProgress({ phase: 'checkingRemote' })
			let remoteBaseDirExits = await webdav.exists(remoteBaseDir)

			if (!remoteBaseDirExits) {
				await syncRecord.drop()
			}

			while (!remoteBaseDirExits) {
				if (this.isCancelled) {
					emitSyncCancelled()
					return {
						ended: false,
						ranTasks: false,
						shouldReloadSettings: false,
					}
				}
				try {
					await webdav.createDirectory(this.options.remoteBaseDir, {
						recursive: true,
					})
					break
				} catch (e) {
					if (is503Error(e as Error)) {
						await handle503Error(60000)
						if (this.isCancelled) {
							emitSyncCancelled()
							return {
								ended: false,
								ranTasks: false,
								shouldReloadSettings: false,
							}
						}
						remoteBaseDirExits = await webdav.exists(remoteBaseDir)
					} else {
						throw e
					}
				}
			}

			this.emitPreparationProgress({ phase: 'loadingState' })
			await cacheService.restoreRemoteTraversalCacheIfMissing(this.logger)
			const decider = (() => {
				switch (syncPolicy) {
					case SyncPolicy.SendOnly:
						return new SendOnlySyncDecider(this, syncRecord)
					case SyncPolicy.SendOnlyOverrideChanges:
						return new SendOnlyOverrideChangesSyncDecider(this, syncRecord)
					case SyncPolicy.ReceiveOnly:
						return new ReceiveOnlySyncDecider(this, syncRecord)
					case SyncPolicy.ReceiveOnlyRevertLocalChanges:
						return new ReceiveOnlyRevertLocalChangesSyncDecider(
							this,
							syncRecord,
						)
					case SyncPolicy.TwoWay:
					default:
						return new TwoWaySyncDecider(this, syncRecord)
				}
			})()
			this.emitPreparationProgress({ phase: 'analyzing' })
			const tasks = await decider.decide()
			if (!this.isCancelled) {
				this.emitPreparationProgress({ phase: 'savingCache' })
				await cacheService.saveRemoteTraversalCache(
					this.logger,
					() => this.isCancelled,
				)
			}
			this.throwIfCancelled()

			this.logger.info('[Sync] Decision:', {
				push: tasks.filter((t) => t instanceof PushTask).length,
				pull: tasks.filter((t) => t instanceof PullTask).length,
				conflict: tasks.filter((t) => t instanceof ConflictResolveTask).length,
				mkdirRemote: tasks.filter((t) => t instanceof MkdirRemoteTask).length,
				mkdirLocal: tasks.filter((t) => t instanceof MkdirLocalTask).length,
				removeLocal: tasks.filter((t) => t instanceof RemoveLocalTask).length,
				removeRemote: tasks.filter((t) => t instanceof RemoveRemoteTask).length,
				noop: tasks.filter((t) => t instanceof NoopTask).length,
				skipped: tasks.filter((t) => t instanceof SkippedTask).length,
				total: tasks.length,
			})

			if (tasks.length === 0) {
				if (preparingEmitted) {
					emitEndSync({ showNotice, failedCount: 0 })
					return {
						ended: true,
						ranTasks: false,
						shouldReloadSettings: false,
					}
				}
				emitEndSync({ showNotice: false, failedCount: 0 })
				return {
					ended: false,
					ranTasks: false,
					shouldReloadSettings: false,
				}
			}

			emitPreparingOnce()

			const noopTasks = tasks.filter((t) => t instanceof NoopTask)
			const skippedTasks = tasks.filter((t) => t instanceof SkippedTask)
			let confirmedTasks = tasks.filter(
				(t) => !(t instanceof NoopTask || t instanceof SkippedTask),
			)

			const firstTaskIdxNeedingConfirmation = confirmedTasks.findIndex(
				(t) => !(t instanceof CleanRecordTask),
			)

			if (this.isCancelled) {
				emitSyncCancelled()
				return {
					ended: false,
					ranTasks: false,
					shouldReloadSettings: false,
				}
			}

			if (
				showNotice &&
				settings.confirmBeforeSync &&
				firstTaskIdxNeedingConfirmation > -1
			) {
				this.plugin.progressService.closeProgressModal()
				const confirmExec = await new TaskListConfirmModal(
					this.app,
					confirmedTasks,
				).openAndWait()
				if (confirmExec.confirm) {
					confirmedTasks = confirmExec.tasks
					this.plugin.progressService.showProgressModal()
				} else {
					emitSyncCancelled()
					return {
						ended: false,
						ranTasks: false,
						shouldReloadSettings: false,
					}
				}
			}

			// Check for RemoveLocalTask during auto-sync and ask for confirmation
			if (
				mode === SyncStartMode.AUTO_SYNC &&
				settings.confirmBeforeDeleteInAutoSync
			) {
				confirmedTasks = await resolveAutoSyncDeleteConfirm({
					app: this.app,
					vault: this.vault,
					webdav,
					remoteBaseDir: this.remoteBaseDir,
					syncRecord,
					logger: this.logger,
					tasks,
					confirmedTasks,
				})
			}

			const confirmedTasksUniq = Array.from(
				new Set([...confirmedTasks, ...noopTasks, ...skippedTasks]),
			)

			// Merge mkdir tasks with parent-child relationships to reduce API calls
			const mkdirTasks = confirmedTasksUniq.filter(
				(t) => t instanceof MkdirRemoteTask,
			)
			const removeRemoteTasks = confirmedTasksUniq.filter(
				(t) => t instanceof RemoveRemoteTask,
			)
			const otherTasks = confirmedTasksUniq.filter(
				(t) => !(t instanceof MkdirRemoteTask || t instanceof RemoveRemoteTask),
			)
			const mergedMkdirTasks = mergeMkdirTasks(mkdirTasks)
			const mergedRemoveRemoteTasks = mergeRemoveRemoteTasks(removeRemoteTasks)
			const optimizedTasks = [
				...mergedRemoveRemoteTasks,
				...mergedMkdirTasks,
				...otherTasks,
			]

			if (confirmedTasks.length > 500 && Platform.isDesktopApp) {
				new Notice(i18n.t('sync.suggestUseClientForManyTasks'), 5000)
			}

			const totalDisplayableTasks = optimizedTasks.filter(
				(t) => !(t instanceof NoopTask || t instanceof CleanRecordTask),
			)

			// Emit start sync event after all confirmations are done
			emitStartSync({ showNotice })
			if (totalDisplayableTasks.length > 0) {
				emitSyncProgress(totalDisplayableTasks.length, [], null)
			}
			const chunkSize = 200
			const taskChunks = chunk(optimizedTasks, chunkSize)
			const allTasksResult: TaskResult[] = []
			let shouldReloadSettings = false
			const updateMtimeProgress: UpdateMtimeProgress = {
				total: countRecordUpdateOperations(optimizedTasks),
				completed: 0,
			}

			// Track all completed tasks across all chunks
			const allCompletedTasks: CompletedTask[] = []

			for (const taskChunk of taskChunks) {
				const chunkResult = await execTasks(
					this,
					taskChunk,
					totalDisplayableTasks,
					allCompletedTasks,
				)
				allTasksResult.push(...chunkResult)
				shouldReloadSettings ||= taskChunk.some((task, index) =>
					didTaskReloadPluginSettings(
						this.plugin,
						this.vault,
						task,
						chunkResult[index],
					),
				)
				await this.updateMtimeInRecord(
					taskChunk,
					chunkResult,
					updateMtimeProgress,
				)

				if (this.isCancelled) {
					break
				}
			}

			if (this.isCancelled) {
				emitSyncCancelled()
				return {
					ended: false,
					ranTasks: false,
					shouldReloadSettings: false,
				}
			}

			const failedCount = allTasksResult.filter((r) => !r.success).length
			this.logger.info(
				`[Sync] Completed: ${allTasksResult.length - failedCount} success, ${failedCount} failed`,
			)
			this.logger.debug('tasks result', allTasksResult, 'failed:', failedCount)

			if (mode === SyncStartMode.MANUAL_SYNC && failedCount > 0) {
				const failedTasksInfo: FailedTaskInfo[] = []
				for (let i = 0; i < allTasksResult.length; i++) {
					const result = allTasksResult[i]
					if (!result.success && result.error) {
						const task = result.error.task
						failedTasksInfo.push({
							taskName: getTaskName(task),
							localPath: task.options.localPath,
							errorMessage: result.error.message,
						})
					}
				}
				new FailedTasksModal(this.app, failedTasksInfo).open()
			}

			emitEndSync({ failedCount, showNotice })
			return { ended: true, ranTasks: true, shouldReloadSettings }
		} catch (error) {
			if (error instanceof SyncCancelledError) {
				emitSyncCancelled()
				this.logger.info('Sync cancelled')
			} else {
				emitSyncError(error as Error)
				this.logger.error('Sync error:', error)
			}
			return {
				ended: false,
				ranTasks: false,
				shouldReloadSettings: false,
			}
		} finally {
			this.preparationProgressEnabled = false
			this.currentLogPrefix = '[[Sync]]'
			this.currentLogger = createSyncLogger(this.currentLogPrefix)
			this.subscriptions.forEach((sub) => sub.unsubscribe())
		}
	}

	async updateMtimeInRecord(
		tasks: BaseTask[],
		results: TaskResult[],
		progress: UpdateMtimeProgress,
	) {
		return updateMtimeInRecordImpl(
			this.plugin,
			this.vault,
			this.remoteBaseDir,
			tasks,
			results,
			this.logger,
			progress,
		)
	}

	get app() {
		return this.plugin.app
	}

	get webdav() {
		return this.options.webdav
	}

	get vault() {
		return this.options.vault
	}

	get remoteBaseDir() {
		return this.options.remoteBaseDir
	}

	get settings() {
		return this.plugin.settings
	}

	get localSettings() {
		return this.plugin.localSettings
	}

	get logger() {
		return this.currentLogger
	}
}
