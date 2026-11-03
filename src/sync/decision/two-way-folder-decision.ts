import { isPluginSelfPath } from '~/utils/config-dir-rules'
import { hasInvalidChar } from '~/utils/has-invalid-char'
import remotePathToAbsolute from '~/utils/remote-path-to-absolute'
import { remotePathToLocalPath } from '~/utils/remote-path-to-local-path'
import { FsWalkResult } from '~/fs/fs.interface'
import type { StatModel } from '~/model/stat.model'
import { hasFolderContentChanged } from '~/sync/core/has-folder-content-changed'
import { SkipReason } from '~/sync/tasks/skipped.task'
import { BaseTask } from '~/sync/tasks/task.interface'
import {
	getIgnoredPathsInFolder,
	hasIgnoredInFolder,
} from '~/sync/utils/has-ignored-in-folder'
import { SyncDecisionInput } from './sync-decision.interface'

export interface TwoWayFolderDecisionContext {
	input: SyncDecisionInput
	localStats: FsWalkResult[]
	remoteStats: FsWalkResult[]
	localStatsFiltered: StatModel[]
	remoteStatsFiltered: StatModel[]
	localStatsMap: Map<string, StatModel>
	remoteStatsMap: Map<string, StatModel>
	tasks: BaseTask[]
	removeRemoteFolderTasks: BaseTask[]
	removeLocalFolderTasks: BaseTask[]
	mkdirLocalTasks: BaseTask[]
	mkdirRemoteTasks: BaseTask[]
	noopFolderTasks: BaseTask[]
}

/**
 * Folder phase `remote -> local` of `twoWayDecider` (verbatim move: create or
 * remove local folders, collect no-op folder tasks).
 */
export function decideRemoteFolders(ctx: TwoWayFolderDecisionContext): void {
	const {
		input,
		tasks,
		remoteStats,
		remoteStatsFiltered,
		localStatsMap,
		removeRemoteFolderTasks,
		mkdirLocalTasks,
		noopFolderTasks,
	} = ctx
	const { logger, remoteBaseDir, syncRecords, taskFactory } = input

	// * sync folder: remote -> local
	for (const remote of remoteStatsFiltered) {
		if (!remote.isDir) {
			continue
		}
		const localPath = remotePathToLocalPath(remoteBaseDir, remote.path)
		const local = localStatsMap.get(localPath)
		const record = syncRecords.get(localPath)
		if (local) {
			if (!local.isDir) {
				throw new Error(
					`Folder conflict: remote path ${remote.path} is a folder but local path ${localPath} is a file`,
				)
			}
			if (!record) {
				noopFolderTasks.push(
					taskFactory.createNoopTask({
						localPath: localPath,
						remotePath: remote.path,
						remoteBaseDir,
					}),
				)
				continue
			}
		} else if (record) {
			const remoteChanged = hasFolderContentChanged(
				remote.path,
				remoteStatsFiltered,
				syncRecords,
				'remote',
			)

			if (remoteChanged) {
				logger.debug({
					reason: 'remote folder content changed',
					remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
					localPath: localPath,
					conditions: {
						remoteChanged,
						localExists: !!local,
						recordExists: !!record,
					},
				})

				mkdirLocalTasks.push(
					taskFactory.createMkdirLocalTask({
						localPath,
						remotePath: remote.path,
						remoteBaseDir,
					}),
				)
				continue
			}

			if (hasIgnoredInFolder(remote.path, remoteStats)) {
				const ignoredPaths = getIgnoredPathsInFolder(remote.path, remoteStats)
				logger.debug({
					reason: 'skip removing remote folder (contains ignored items)',
					remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
					localPath: localPath,
					conditions: {
						hasIgnoredItems: true,
						localExists: !!local,
						recordExists: !!record,
					},
					ignoredPaths,
				})
				tasks.push(
					taskFactory.createSkippedTask({
						localPath,
						remotePath: remote.path,
						remoteBaseDir,
						reason: SkipReason.FolderContainsIgnoredItems,
						ignoredPaths,
					}),
				)
				continue
			}

			logger.debug({
				reason: 'remote folder is removable (no content changes)',
				remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
				localPath: localPath,
				conditions: {
					removable: true,
					localExists: !!local,
					recordExists: !!record,
				},
			})
			removeRemoteFolderTasks.push(
				taskFactory.createRemoveRemoteTask({
					localPath: remote.path,
					remotePath: remote.path,
					remoteBaseDir,
				}),
			)
			continue
		} else {
			logger.debug({
				reason: 'remote folder does not exist locally',
				remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
				localPath: localPath,
				conditions: {
					localExists: !!local,
					recordExists: !!record,
				},
			})

			mkdirLocalTasks.push(
				taskFactory.createMkdirLocalTask({
					localPath,
					remotePath: remote.path,
					remoteBaseDir,
				}),
			)

			continue
		}
	}
}

/**
 * Folder phase `local -> remote` of `twoWayDecider` (verbatim move: create or
 * remove remote folders, collect no-op folder tasks).
 */
export function decideLocalFolders(ctx: TwoWayFolderDecisionContext): void {
	const {
		input,
		tasks,
		localStats,
		localStatsFiltered,
		remoteStatsMap,
		removeLocalFolderTasks,
		mkdirRemoteTasks,
		noopFolderTasks,
	} = ctx
	const { logger, settings, remoteBaseDir, syncRecords, taskFactory } = input

	// * sync folder: local -> remote
	for (const local of localStatsFiltered) {
		if (!local.isDir) {
			continue
		}
		const remote = remoteStatsMap.get(local.path)
		const record = syncRecords.get(local.path)
		if (remote) {
			if (!record) {
				noopFolderTasks.push(
					taskFactory.createNoopTask({
						localPath: local.path,
						remotePath: remote.path,
						remoteBaseDir,
					}),
				)
				continue
			}
		} else {
			if (record) {
				if (isPluginSelfPath(local.path, settings.configDir)) {
					logger.debug({
						reason: 'plugin self-folder missing remotely — preserve local',
						remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
						localPath: local.path,
					})
					continue
				}
				const localChanged = hasFolderContentChanged(
					local.path,
					localStatsFiltered,
					syncRecords,
					'local',
				)

				if (localChanged) {
					logger.debug({
						reason: 'local folder content changed',
						remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
						localPath: local.path,
						conditions: {
							localChanged,
							remoteExists: !!remote,
							recordExists: !!record,
						},
					})
					if (hasInvalidChar(local.path)) {
						tasks.push(
							taskFactory.createFilenameErrorTask({
								localPath: local.path,
								remotePath: local.path,
								remoteBaseDir,
							}),
						)
					} else {
						mkdirRemoteTasks.push(
							taskFactory.createMkdirRemoteTask({
								localPath: local.path,
								remotePath: local.path,
								remoteBaseDir,
							}),
						)
					}
					continue
				}

				if (hasIgnoredInFolder(local.path, localStats)) {
					const ignoredPaths = getIgnoredPathsInFolder(local.path, localStats)
					logger.debug({
						reason: 'skip removing local folder (contains ignored items)',
						remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
						localPath: local.path,
						conditions: {
							hasIgnoredItems: true,
							remoteExists: !!remote,
							recordExists: !!record,
						},
						ignoredPaths,
					})
					tasks.push(
						taskFactory.createSkippedTask({
							localPath: local.path,
							remotePath: local.path,
							remoteBaseDir,
							reason: SkipReason.FolderContainsIgnoredItems,
							ignoredPaths,
						}),
					)
					continue
				}

				logger.debug({
					reason: 'local folder is removable (no content changes)',
					remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
					localPath: local.path,
					conditions: {
						removable: true,
						remoteExists: !!remote,
						recordExists: !!record,
					},
				})
				removeLocalFolderTasks.push(
					taskFactory.createRemoveLocalTask({
						localPath: local.path,
						remotePath: local.path,
						remoteBaseDir,
						recursive: true,
					}),
				)
			} else {
				logger.debug({
					reason: 'local folder does not exist remotely',
					remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
					localPath: local.path,
					conditions: {
						remoteExists: !!remote,
						recordExists: !!record,
					},
				})
				if (hasInvalidChar(local.path)) {
					tasks.push(
						taskFactory.createFilenameErrorTask({
							localPath: local.path,
							remotePath: local.path,
							remoteBaseDir,
						}),
					)
				} else {
					mkdirRemoteTasks.push(
						taskFactory.createMkdirRemoteTask({
							localPath: local.path,
							remotePath: local.path,
							remoteBaseDir,
						}),
					)
				}
				continue
			}
			continue
		}
		if (!remote.isDir) {
			throw new Error(
				`Folder conflict: local path ${local.path} is a folder but remote path ${remote.path} is a file`,
			)
		}
	}
}
