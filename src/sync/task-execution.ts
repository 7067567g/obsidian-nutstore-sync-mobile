import { Notice, Vault, moment, normalizePath } from 'obsidian'
import { CompletedTask, emitSyncProgress, onCancelSync } from '~/events'
import i18n from '~/i18n'
import breakableSleep from '~/utils/breakable-sleep'
import getTaskName from '~/utils/get-task-name'
import { is503Error } from '~/utils/is-503-error'
import type NutstorePlugin from '~/index'
import type { SyncLogger } from './log'
import CleanRecordTask from './tasks/clean-record.task'
import ConflictResolveTask, {
	ConflictStrategy,
} from './tasks/conflict-resolve.task'
import NoopTask from './tasks/noop.task'
import PullTask from './tasks/pull.task'
import RemoveLocalTask from './tasks/remove-local.task'
import { BaseTask, TaskError, TaskResult } from './tasks/task.interface'
import {
	updateMtimeInRecord as updateMtimeInRecordUtil,
	UpdateMtimeProgress,
} from './utils/update-records'

/**
 * Host surface used by the task execution helpers. `NutstoreSync` satisfies it
 * structurally, so moving these methods out of the class is behaviour-neutral.
 */
export interface TaskExecutionHost {
	readonly isCancelled: boolean
	readonly logger: SyncLogger
}

/**
 * Verbatim move of `NutstoreSync.isPluginSettingsPath` with explicit host
 * parameters.
 */
export function isPluginSettingsPath(
	vault: Vault,
	pluginId: string,
	localPath: string,
): boolean {
	const pluginDir = normalizePath(`${vault.configDir}/plugins/${pluginId}`)
	return (
		localPath === `${pluginDir}/data.json` ||
		localPath === `${pluginDir}/data.local.json`
	)
}

/**
 * Verbatim move of `NutstoreSync.didTaskReloadPluginSettings` with explicit
 * host parameters.
 */
export function didTaskReloadPluginSettings(
	plugin: NutstorePlugin,
	vault: Vault,
	task: BaseTask,
	result?: TaskResult,
): boolean {
	if (
		!result?.success ||
		!isPluginSettingsPath(vault, plugin.manifest.id, task.localPath)
	) {
		return false
	}

	if (task instanceof PullTask || task instanceof RemoveLocalTask) {
		return true
	}

	if (task instanceof ConflictResolveTask) {
		return [
			ConflictStrategy.NoConflictMerge,
			ConflictStrategy.Diff3,
			ConflictStrategy.ServerPriority,
		].includes(task.options.strategy)
	}

	return false
}

/**
 * Verbatim move of `NutstoreSync.execTasks` with explicit host parameters.
 */
export async function execTasks(
	host: TaskExecutionHost,
	tasks: BaseTask[],
	totalDisplayableTasks: BaseTask[],
	allCompletedTasks: CompletedTask[],
): Promise<TaskResult[]> {
	const res: TaskResult[] = []
	// Filter out NoopTask and CleanRecordTask from total count for progress display
	const tasksToDisplay = tasks.filter(
		(t) => !(t instanceof NoopTask || t instanceof CleanRecordTask),
	)

	host.logger.debug(`Starting to execute sync tasks`, {
		totalTasks: tasks.length,
		displayedTasks: tasksToDisplay.length,
		totalDisplayableTasks: totalDisplayableTasks.length,
		alreadyCompleted: allCompletedTasks.length,
	})

	for (let i = 0; i < tasks.length; ++i) {
		const task = tasks[i]
		if (host.isCancelled) {
			break
		}

		const isDisplayable = !(
			task instanceof NoopTask || task instanceof CleanRecordTask
		)

		host.logger.debug(
			`Executing task [${i + 1}/${tasks.length}] ${task.localPath}`,
			{
				taskName: getTaskName(task),
				taskPath: task.localPath,
			},
		)

		if (isDisplayable) {
			emitSyncProgress(totalDisplayableTasks.length, allCompletedTasks, task)
		}

		const taskResult = await executeWithRetry(host, task)

		host.logger.debug(
			`Task completed [${i + 1}/${tasks.length}] ${task.localPath}`,
			{
				taskName: getTaskName(task),
				taskPath: task.localPath,
				result: taskResult,
			},
		)

		res[i] = taskResult
		if (isDisplayable) {
			allCompletedTasks.push({ task, success: taskResult.success })
			// Keep current=task so the header doesn't flicker between tasks
			emitSyncProgress(totalDisplayableTasks.length, allCompletedTasks, task)
		}
	}

	const successCount = res.filter((r) => r.success).length
	host.logger.debug(`All tasks execution completed`, {
		totalTasks: tasks.length,
		successCount: successCount,
		failedCount: tasks.length - successCount,
	})

	return res
}

/**
 * Automatically handle 503 errors and retry task execution.
 *
 * Verbatim move of `NutstoreSync.executeWithRetry` with explicit host
 * parameters.
 */
export async function executeWithRetry(
	host: TaskExecutionHost,
	task: BaseTask,
): Promise<TaskResult> {
	let retryCount = 0
	while (true) {
		if (host.isCancelled) {
			return {
				success: false,
				error: new TaskError(i18n.t('sync.cancelled'), task),
			}
		}
		const taskResult = await task.exec()
		if (!taskResult.success && is503Error(taskResult.error)) {
			retryCount++
			host.logger.warn(
				`[Sync] 503 on ${task.localPath}, retry #${retryCount} in 60s`,
			)
			await handle503Error(60000)
			if (host.isCancelled) {
				return {
					success: false,
					error: new TaskError(i18n.t('sync.cancelled'), task),
				}
			}
			continue
		}
		return taskResult
	}
}

/**
 * Verbatim move of `NutstoreSync.updateMtimeInRecord` with explicit host
 * parameters (the `batch_size` of 10 is unchanged).
 */
export async function updateMtimeInRecord(
	plugin: NutstorePlugin,
	vault: Vault,
	remoteBaseDir: string,
	tasks: BaseTask[],
	results: TaskResult[],
	logger: SyncLogger,
	progress: UpdateMtimeProgress,
): Promise<void> {
	return updateMtimeInRecordUtil(
		plugin,
		vault,
		remoteBaseDir,
		tasks,
		results,
		10,
		logger,
		progress,
	)
}

/**
 * Verbatim move of `NutstoreSync.handle503Error`.
 */
export async function handle503Error(waitMs: number): Promise<void> {
	const now = Date.now()
	const startAt = now + waitMs
	new Notice(
		i18n.t('sync.requestsTooFrequent', {
			time: moment(startAt).format('HH:mm:ss'),
		}),
	)
	await breakableSleep(onCancelSync(), startAt - now)
}
