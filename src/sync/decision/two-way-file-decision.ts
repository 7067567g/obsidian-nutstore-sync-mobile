import { isPluginSelfPath } from '~/utils/config-dir-rules'
import { hasInvalidChar } from '~/utils/has-invalid-char'
import { isSameTime } from '~/utils/is-same-time'
import remotePathToAbsolute from '~/utils/remote-path-to-absolute'
import type { StatModel } from '~/model/stat.model'
import { getFileChanges, getRemoteFileChanged } from '~/sync/core/file-changes'
import { areLooseEqualFiles } from '~/sync/core/loose-equality'
import { SkipReason } from '~/sync/tasks/skipped.task'
import { BaseTask } from '~/sync/tasks/task.interface'
import {
	SyncDecisionInput,
	SyncRecordItem,
	TaskOptions,
} from './sync-decision.interface'

type FileStat = Extract<StatModel, { isDir: false }>

export interface TwoWayFileDecisionContext {
	input: SyncDecisionInput
	maxFileSize: number
	tasks: BaseTask[]
	removeRemoteFile: (p: string, remoteSize: number) => boolean
	removeLocalFile: (p: string, localSize: number) => boolean
}

/**
 * Decide one path that already has a sync record (the original `if (record)`
 * branch of `twoWayDecider`); every `continue` of the enclosing loop is now a
 * `return` from this function.
 */
export async function decideFileWithRecord(
	ctx: TwoWayFileDecisionContext,
	p: string,
	local: FileStat | undefined,
	remote: FileStat | undefined,
	record: SyncRecordItem,
): Promise<void> {
	const { input, maxFileSize, tasks, removeRemoteFile, removeLocalFile } = ctx
	const { logger, settings, remoteBaseDir, taskFactory } = input
	const options: TaskOptions = { remotePath: p, localPath: p, remoteBaseDir }

	if (remote) {
		const remoteChanged = getRemoteFileChanged(remote, record.remote)
		if (local) {
			const { localChanged } = await getFileChanges(
				input,
				local,
				remote,
				record,
			)
			if (remoteChanged) {
				if (localChanged) {
					logger.debug({
						reason: 'both local and remote files changed',
						remotePath: remotePathToAbsolute(remoteBaseDir, p),
						localPath: p,
						conditions: {
							remoteChanged,
							localChanged,
							recordExists: !!record,
							remoteExists: !!remote,
							localExists: !!local,
						},
					})
					if (remote.size > maxFileSize || local.size > maxFileSize) {
						tasks.push(
							taskFactory.createSkippedTask({
								...options,
								reason: SkipReason.FileTooLarge,
								maxSize: maxFileSize,
								remoteSize: remote.size,
								localSize: local.size,
							}),
						)
						return
					}

					if (hasInvalidChar(local.path)) {
						tasks.push(taskFactory.createFilenameErrorTask(options))
					} else {
						tasks.push(
							taskFactory.createConflictResolveTask({
								...options,
								record,
								strategy: settings.conflictStrategy,
								localStat: local,
								remoteStat: remote,
								mobileAppDownloadFileChunkSize:
									settings.mobileAppDownloadFileChunkSize,
							}),
						)
					}

					return
				} else {
					logger.debug({
						reason: 'remote file changed',
						remotePath: remotePathToAbsolute(remoteBaseDir, p),
						localPath: p,
						conditions: {
							remoteChanged,
							recordExists: !!record,
							remoteExists: !!remote,
							localExists: !!local,
						},
					})
					if (remote.size > maxFileSize || local.size > maxFileSize) {
						tasks.push(
							taskFactory.createSkippedTask({
								...options,
								reason: SkipReason.FileTooLarge,
								maxSize: maxFileSize,
								remoteSize: remote.size,
								localSize: local.size,
							}),
						)
						return
					}
					tasks.push(
						taskFactory.createPullTask({
							...options,
							remoteSize: remote.size,
							mobileAppDownloadFileChunkSize:
								settings.mobileAppDownloadFileChunkSize,
						}),
					)
					return
				}
			} else {
				if (localChanged) {
					logger.debug({
						reason: 'local file changed',
						remotePath: remotePathToAbsolute(remoteBaseDir, p),
						localPath: p,
						conditions: {
							localChanged,
							recordExists: !!record,
							remoteExists: !!remote,
							localExists: !!local,
						},
					})
					if (local.size > maxFileSize || remote.size > maxFileSize) {
						tasks.push(
							taskFactory.createSkippedTask({
								...options,
								reason: SkipReason.FileTooLarge,
								maxSize: maxFileSize,
								remoteSize: remote.size,
								localSize: local.size,
							}),
						)
						return
					}
					if (hasInvalidChar(local.path)) {
						tasks.push(taskFactory.createFilenameErrorTask(options))
					} else {
						tasks.push(taskFactory.createPushTask(options))
					}
					return
				}
			}
		} else {
			if (remoteChanged) {
				logger.debug({
					reason: 'remote file changed and local file does not exist',
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
					localPath: p,
					conditions: {
						remoteChanged,
						recordExists: !!record,
						remoteExists: !!remote,
						localExists: !!local,
					},
				})
				if (remote.size > maxFileSize) {
					tasks.push(
						taskFactory.createSkippedTask({
							...options,
							reason: SkipReason.FileTooLarge,
							maxSize: maxFileSize,
							remoteSize: remote.size,
						}),
					)
					return
				}
				tasks.push(
					taskFactory.createPullTask({
						...options,
						remoteSize: remote.size,
						mobileAppDownloadFileChunkSize:
							settings.mobileAppDownloadFileChunkSize,
					}),
				)
				return
			} else {
				logger.debug({
					reason: 'remote file is removable',
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
					localPath: p,
					conditions: {
						recordExists: !!record,
						remoteExists: !!remote,
						localExists: !!local,
					},
				})
				removeRemoteFile(p, remote.size)
				return
			}
		}
	} else if (local) {
		if (isPluginSelfPath(p, settings.configDir)) {
			logger.debug({
				reason: 'plugin self-path missing remotely — preserve local',
				remotePath: remotePathToAbsolute(remoteBaseDir, p),
				localPath: p,
			})
			return
		}
		const localChanged = !isSameTime(local.mtime, record.local.mtime)
		if (localChanged) {
			logger.debug({
				reason: 'local file changed and remote file does not exist',
				remotePath: remotePathToAbsolute(remoteBaseDir, p),
				localPath: p,
				conditions: {
					localChanged,
					recordExists: !!record,
					remoteExists: !!remote,
					localExists: !!local,
				},
			})
			if (local.size > maxFileSize) {
				tasks.push(
					taskFactory.createSkippedTask({
						...options,
						reason: SkipReason.FileTooLarge,
						localSize: local.size,
						maxSize: maxFileSize,
					}),
				)
				return
			}
			if (hasInvalidChar(local.path)) {
				tasks.push(taskFactory.createFilenameErrorTask(options))
			} else {
				tasks.push(taskFactory.createPushTask(options))
			}
			return
		} else {
			logger.debug({
				reason: 'local file is removable',
				remotePath: remotePathToAbsolute(remoteBaseDir, p),
				localPath: p,
				conditions: {
					recordExists: !!record,
					remoteExists: !!remote,
					localExists: !!local,
				},
			})
			removeLocalFile(p, local.size)
			return
		}
	}
}

/**
 * Decide one path without a sync record (the original `else` branch of
 * `twoWayDecider`); every `continue` of the enclosing loop is now a `return`
 * from this function.
 */
export function decideFileWithoutRecord(
	ctx: TwoWayFileDecisionContext,
	p: string,
	local: FileStat | undefined,
	remote: FileStat | undefined,
	record: SyncRecordItem | undefined,
): void {
	const { maxFileSize, tasks } = ctx
	const { logger, settings, remoteBaseDir, taskFactory } = ctx.input
	const options: TaskOptions = { remotePath: p, localPath: p, remoteBaseDir }

	if (remote) {
		if (local) {
			if (areLooseEqualFiles(settings.syncMode, local, remote)) {
				tasks.push(taskFactory.createNoopTask(options))
				return
			}
			logger.debug({
				reason: 'both local and remote files exist without a record',
				remotePath: remotePathToAbsolute(remoteBaseDir, p),
				localPath: p,
				conditions: {
					recordExists: !!record,
					remoteExists: !!remote,
					localExists: !!local,
				},
			})

			if (remote.size > maxFileSize || local.size > maxFileSize) {
				tasks.push(
					taskFactory.createSkippedTask({
						...options,
						reason: SkipReason.FileTooLarge,
						remoteSize: remote.size,
						localSize: local.size,
						maxSize: maxFileSize,
					}),
				)
				return
			}

			if (hasInvalidChar(local.path)) {
				tasks.push(taskFactory.createFilenameErrorTask(options))
			} else {
				tasks.push(
					taskFactory.createConflictResolveTask({
						...options,
						strategy: settings.conflictStrategy,
						localStat: local,
						remoteStat: remote,
						mobileAppDownloadFileChunkSize:
							settings.mobileAppDownloadFileChunkSize,
					}),
				)
			}

			return
		} else {
			logger.debug({
				reason: 'remote file exists without a local file',
				remotePath: remotePathToAbsolute(remoteBaseDir, p),
				localPath: p,
				conditions: {
					recordExists: !!record,
					remoteExists: !!remote,
					localExists: !!local,
				},
			})

			if (remote.size > maxFileSize) {
				tasks.push(
					taskFactory.createSkippedTask({
						...options,
						reason: SkipReason.FileTooLarge,
						remoteSize: remote.size,
						maxSize: maxFileSize,
					}),
				)
				return
			}
			tasks.push(
				taskFactory.createPullTask({
					...options,
					remoteSize: remote.size,
					mobileAppDownloadFileChunkSize:
						settings.mobileAppDownloadFileChunkSize,
				}),
			)
			return
		}
	} else {
		if (local) {
			logger.debug({
				reason: 'local file exists without a remote file',
				remotePath: remotePathToAbsolute(remoteBaseDir, p),
				localPath: p,
				conditions: {
					recordExists: !!record,
					remoteExists: !!remote,
					localExists: !!local,
				},
			})

			if (local.size > maxFileSize) {
				tasks.push(
					taskFactory.createSkippedTask({
						...options,
						reason: SkipReason.FileTooLarge,
						localSize: local.size,
						maxSize: maxFileSize,
					}),
				)
				return
			}
			if (hasInvalidChar(local.path)) {
				tasks.push(taskFactory.createFilenameErrorTask(options))
			} else {
				tasks.push(taskFactory.createPushTask(options))
			}
			return
		}
	}
}
