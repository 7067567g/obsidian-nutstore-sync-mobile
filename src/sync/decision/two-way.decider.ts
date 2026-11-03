import remotePathToAbsolute from '~/utils/remote-path-to-absolute'
import { shouldCreateCleanRecordTask } from '~/sync/core/record-cleanup'
import { BaseTask } from '~/sync/tasks/task.interface'
import BaseSyncDecider from './base.decider'
import { pushFileTooLargeTask, resolveMaxFileSize } from './size-guard'
import { SyncDecisionInput } from './sync-decision.interface'
import {
	decideFileWithRecord,
	decideFileWithoutRecord,
	TwoWayFileDecisionContext,
} from './two-way-file-decision'
import {
	decideLocalFolders,
	decideRemoteFolders,
	TwoWayFolderDecisionContext,
} from './two-way-folder-decision'

export default class TwoWaySyncDecider extends BaseSyncDecider {
	async decide(): Promise<BaseTask[]> {
		const input = await this.buildDecisionInput()
		return twoWayDecider(input)
	}
}

/**
 * Two-way decider, split into a collect / decide / persist pipeline:
 *
 * 1. collect: resolve the size budget and index the walked local/remote stats;
 * 2. decide: files (`two-way-file-decision`) then folders
 *    (`two-way-folder-decision`);
 * 3. persist: clean orphaned records and prepend the sorted folder tasks.
 *
 * The decision result object and task ordering are unchanged from the original
 * single-function implementation.
 */
export async function twoWayDecider(
	input: SyncDecisionInput,
): Promise<BaseTask[]> {
	const {
		logger,
		settings,
		localStats,
		remoteStats,
		syncRecords,
		remoteBaseDir,
		taskFactory,
	} = input

	// * collect
	const maxFileSize = resolveMaxFileSize(settings)

	const localStatsFiltered = localStats
		.filter((item) => !item.ignored)
		.map((item) => item.stat)
	const remoteStatsFiltered = remoteStats
		.filter((item) => !item.ignored)
		.map((item) => item.stat)

	const localStatsMap = new Map(
		localStatsFiltered.map((item) => [item.path, item]),
	)
	const remoteStatsMap = new Map(
		remoteStatsFiltered.map((item) => [item.path, item]),
	)
	const mixedPath = new Set([...localStatsMap.keys(), ...remoteStatsMap.keys()])

	const tasks: BaseTask[] = []
	const removeRemoteFolderTasks: BaseTask[] = []
	const removeLocalFolderTasks: BaseTask[] = []
	const mkdirLocalTasks: BaseTask[] = []
	const mkdirRemoteTasks: BaseTask[] = []
	const noopFolderTasks: BaseTask[] = []

	const removeRemoteFile = (p: string, remoteSize: number): boolean => {
		const taskOptions = {
			remotePath: p,
			localPath: p,
			remoteBaseDir,
		}
		if (remoteSize > maxFileSize) {
			pushFileTooLargeTask(tasks, taskFactory, taskOptions, maxFileSize, {
				remoteSize,
			})
			return false
		}
		tasks.push(taskFactory.createRemoveRemoteTask(taskOptions))
		return true
	}

	const removeLocalFile = (p: string, localSize: number): boolean => {
		const taskOptions = {
			remotePath: p,
			localPath: p,
			remoteBaseDir,
		}
		if (localSize > maxFileSize) {
			pushFileTooLargeTask(tasks, taskFactory, taskOptions, maxFileSize, {
				localSize,
			})
			return false
		}
		tasks.push(taskFactory.createRemoveLocalTask(taskOptions))
		return true
	}

	// * decide: files
	const fileCtx: TwoWayFileDecisionContext = {
		input,
		maxFileSize,
		tasks,
		removeRemoteFile,
		removeLocalFile,
	}
	for (const p of mixedPath) {
		const remote = remoteStatsMap.get(p)
		const local = localStatsMap.get(p)
		const record = syncRecords.get(p)
		if (local?.isDir || remote?.isDir) {
			continue
		}
		if (record) {
			await decideFileWithRecord(fileCtx, p, local, remote, record)
		} else {
			decideFileWithoutRecord(fileCtx, p, local, remote, record)
		}
	}

	// * decide: clean orphaned records (both local and remote deleted)
	for (const [recordPath, record] of syncRecords) {
		if (shouldCreateCleanRecordTask(recordPath, localStats, remoteStats)) {
			logger.debug({
				reason: 'cleaning orphaned sync record (both local and remote deleted)',
				remotePath: remotePathToAbsolute(remoteBaseDir, recordPath),
				localPath: recordPath,
				conditions: {
					localExists: false,
					remoteExists: false,
					recordExists: !!record,
				},
			})

			tasks.push(
				taskFactory.createCleanRecordTask({
					remotePath: recordPath,
					localPath: recordPath,
					remoteBaseDir,
				}),
			)
		}
	}

	// * decide: folders
	const folderCtx: TwoWayFolderDecisionContext = {
		input,
		localStats,
		remoteStats,
		localStatsFiltered,
		remoteStatsFiltered,
		localStatsMap,
		remoteStatsMap,
		tasks,
		removeRemoteFolderTasks,
		removeLocalFolderTasks,
		mkdirLocalTasks,
		mkdirRemoteTasks,
		noopFolderTasks,
	}
	decideRemoteFolders(folderCtx)
	decideLocalFolders(folderCtx)

	// * persist
	removeRemoteFolderTasks.sort(
		(a, b) => b.remotePath.length - a.remotePath.length,
	)
	removeLocalFolderTasks.sort((a, b) => b.localPath.length - a.localPath.length)
	const allFolderTasks = [
		...removeRemoteFolderTasks,
		...removeLocalFolderTasks,
		...mkdirLocalTasks,
		...mkdirRemoteTasks,
		...noopFolderTasks,
	]

	tasks.splice(0, 0, ...allFolderTasks)

	return tasks
}
