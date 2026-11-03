import { App, Notice, Vault, normalizePath } from 'obsidian'
import { dirname } from 'path-browserify'
import { WebDAVClient } from 'webdav'
import DeleteConfirmModal from '~/components/DeleteConfirmModal'
import i18n from '~/i18n'
import { SyncRecord } from '~/storage/sync-record'
import { stdRemotePath } from '~/utils/std-remote-path'
import { statVaultItem } from '~/utils/stat-vault-item'
import type { SyncLogger } from './log'
import MkdirRemoteTask from './tasks/mkdir-remote.task'
import PushTask from './tasks/push.task'
import RemoveLocalTask from './tasks/remove-local.task'
import { BaseTask } from './tasks/task.interface'

export interface AutoSyncDeleteConfirmOptions {
	app: App
	vault: Vault
	webdav: WebDAVClient
	remoteBaseDir: string
	syncRecord: SyncRecord
	logger: SyncLogger
	tasks: BaseTask[]
	confirmedTasks: BaseTask[]
}

/**
 * Auto-sync `RemoveLocalTask` guard: ask the user which deletes to keep, plan
 * the re-upload (mkdir + push) tasks for the rest, and reassemble the task
 * list. Returns `confirmedTasks` unchanged when there is nothing to confirm.
 *
 * Verbatim move of the original inline block in `NutstoreSync.start`; only
 * `this.*` accesses were replaced by explicit host parameters.
 */
export async function resolveAutoSyncDeleteConfirm(
	options: AutoSyncDeleteConfirmOptions,
): Promise<BaseTask[]> {
	const {
		app,
		vault,
		webdav,
		remoteBaseDir,
		syncRecord,
		logger,
		tasks,
		confirmedTasks,
	} = options

	const removeLocalTasks = confirmedTasks.filter(
		(t) => t instanceof RemoveLocalTask,
	)
	if (removeLocalTasks.length === 0) {
		return confirmedTasks
	}

	new Notice(i18n.t('deleteConfirm.warningNotice'), 3000)

	const { tasksToDelete, tasksToReupload } = await new DeleteConfirmModal(
		app,
		removeLocalTasks,
	).openAndWait()

	// Create corresponding Push/Mkdir tasks for each task to reupload
	const reuploadMap = new Map<RemoveLocalTask, PushTask | MkdirRemoteTask>()
	const mkdirTasksMap = new Map<string, MkdirRemoteTask>()
	const pushTasks: PushTask[] = []
	// Cache paths that we've confirmed exist remotely
	const remoteExistsCache = new Set<string>()

	/**
	 * Helper function to mark a path and all its parents as existing
	 */
	const markPathAndParentsAsExisting = (remotePath: string) => {
		let current = remotePath
		while (current && current !== '.' && current !== '' && current !== '/') {
			if (remoteExistsCache.has(current)) {
				break // Already marked, all parents must be marked too
			}
			remoteExistsCache.add(current)
			current = stdRemotePath(dirname(current))
		}
	}

	/**
	 * Helper function to ensure parent directory exists or create mkdir task
	 */
	const ensureParentDir = async (localPath: string, remotePath: string) => {
		const parentLocalPath = normalizePath(dirname(localPath))
		const parentRemotePath = stdRemotePath(dirname(remotePath))

		// Root path or vault root, no need to check
		if (
			parentLocalPath === '.' ||
			parentLocalPath === '' ||
			parentLocalPath === '/'
		) {
			return
		}

		// Already collected in new tasks, no need to check remote
		if (mkdirTasksMap.has(parentRemotePath)) {
			return
		}

		// Check if already exists in original tasks (from decider)
		const existsInOriginalTasks = tasks.some(
			(t) => t instanceof MkdirRemoteTask && t.remotePath === parentRemotePath,
		)
		if (existsInOriginalTasks) {
			return
		}

		// Already exists in confirmed tasks, no need to check remote
		const existsInConfirmedTasks = confirmedTasks.some(
			(t) => t instanceof MkdirRemoteTask && t.remotePath === parentRemotePath,
		)
		if (existsInConfirmedTasks) {
			return
		}

		// Already confirmed to exist remotely
		if (remoteExistsCache.has(parentRemotePath)) {
			return
		}

		// Check if parent directory exists remotely using webdav.stat
		try {
			await webdav.stat(parentRemotePath)
			// Directory exists, mark it and all parents as existing
			markPathAndParentsAsExisting(parentRemotePath)
		} catch (e) {
			logger.error(e)
			// Directory doesn't exist, create mkdir task
			// No need to check parent's parent since createDirectory uses recursive: true
			const mkdirTask = new MkdirRemoteTask({
				vault: vault,
				webdav: webdav,
				remoteBaseDir: remoteBaseDir,
				remotePath: parentRemotePath,
				localPath: parentLocalPath,
				syncRecord: syncRecord,
				logger: logger,
			})
			mkdirTasksMap.set(parentRemotePath, mkdirTask)
		}
	}

	for (const task of tasksToReupload) {
		const stat = await statVaultItem(vault, task.localPath)
		if (!stat) {
			// File doesn't exist, skip
			continue
		}

		// Ensure parent directory exists
		await ensureParentDir(task.localPath, task.remotePath)

		if (stat.isDir) {
			// Directory → MkdirRemoteTask
			const mkdirTask = new MkdirRemoteTask(task.options)
			reuploadMap.set(task, mkdirTask)
			mkdirTasksMap.set(task.remotePath, mkdirTask)
		} else {
			// File → PushTask
			const pushTask = new PushTask(task.options)
			reuploadMap.set(task, pushTask)
			pushTasks.push(pushTask)
		}
	}

	const mkdirTasks = Array.from(mkdirTasksMap.values())

	// Create set of tasks to delete
	const deleteTaskSet = new Set(tasksToDelete)

	// Remove parent directory delete tasks for reupload files
	// If we reupload /a/b/c/file.png, we shouldn't delete /a, /a/b, or /a/b/c
	for (const reuploadTask of tasksToReupload) {
		let currentPath = normalizePath(reuploadTask.localPath)
		// Check all parent paths
		while (
			currentPath &&
			currentPath !== '.' &&
			currentPath !== '' &&
			currentPath !== '/'
		) {
			currentPath = normalizePath(dirname(currentPath))
			if (currentPath === '.' || currentPath === '' || currentPath === '/') {
				break
			}
			// Find and remove parent directory delete tasks
			for (const deleteTask of deleteTaskSet) {
				if (deleteTask.localPath === currentPath) {
					deleteTaskSet.delete(deleteTask)
					break
				}
			}
		}
	}

	// Replace task list, putting mkdir tasks first
	const otherTasks: BaseTask[] = []
	const deleteTasks: RemoveLocalTask[] = []

	for (const t of confirmedTasks) {
		if (!(t instanceof RemoveLocalTask)) {
			otherTasks.push(t)
			continue
		}
		// If in delete list, keep RemoveLocalTask
		if (deleteTaskSet.has(t)) {
			deleteTasks.push(t)
			continue
		}
		// If in reupload list, already in mkdirTasks/pushTasks
		// If not in any list (user cancelled), skip
	}

	// Reassemble task list: mkdir → other tasks → push → delete
	return [...mkdirTasks, ...otherTasks, ...pushTasks, ...deleteTasks]
}
