import type { App } from 'obsidian'
import type { ReversibleToolOp } from '~/ai/chat/types'
import {
	getParentVaultPaths,
	getPathDepth,
	isVaultFile,
	isVaultFolder,
	normalizeReversibleToolOpRecord,
} from './reversible-op-utils'
import {
	decodeReversibleFileSnapshot,
	isSkippedFileSnapshot,
} from './reversible-content'
import logger from '~/utils/logger'
import {
	createVaultFileSystem,
	type VaultFileSystemManager,
} from '~/ai/tools/vault-filesystem'
import type {
	SettingsSnapshotFn,
	SettingsUpdater,
} from '~/ai/tools/tool-context'
import { posix as pathPosix } from 'path-browserify'
import { normalizeLegacyVirtualPath } from '~/ai/tools/bash/mount-points'

export interface RecallRestoreOptions {
	fileSystemManager?: VaultFileSystemManager
	settingsIo?: {
		getSettingsSnapshot: SettingsSnapshotFn
		updateSettings: SettingsUpdater
	}
}

export async function restoreVirtualReversibleOperations(
	app: App,
	operations: ReversibleToolOp[],
	options: {
		fileSystemManager?: VaultFileSystemManager
		settingsIo?: {
			getSettingsSnapshot: SettingsSnapshotFn
			updateSettings: SettingsUpdater
		}
	} = {},
) {
	const fs = await createVaultFileSystem(app, {
		fileSystemManager: options.fileSystemManager,
		getSettingsSnapshot: options.settingsIo?.getSettingsSnapshot,
		updateSettings: options.settingsIo?.updateSettings,
		// D-005: user-initiated virtual recall restore runs outside a tool call
		// and therefore has no permission guard. The write path must declare
		// explicitly that the user already approved this restore.
		unguardedWrite: 'user-recall',
	})
	const earliest = new Map<string, ReversibleToolOp>()
	for (const operation of operations) {
		const normalizedPath = normalizeLegacyVirtualPath(operation.vaultPath)
		if (!earliest.has(normalizedPath)) {
			earliest.set(normalizedPath, operation)
		}
	}
	for (const [path, operation] of [...earliest.entries()].reverse()) {
		if (operation.operation === 'create') {
			if (await fs.exists(path)) await fs.rm(path, { recursive: true })
			continue
		}
		if (operation.before.kind === 'dir') {
			await fs.mkdir(path, { recursive: true })
			continue
		}
		if (isSkippedFileSnapshot(operation.before)) {
			logger.warn(
				`Recall restore skipped ${path}: snapshot content was not retained`,
			)
			continue
		}
		await fs.mkdir(pathPosix.dirname(path), { recursive: true })
		await fs.writeFile(
			path,
			new Uint8Array(await decodeReversibleFileSnapshot(operation.before)),
		)
	}
}

export async function restoreFilesForRecall(
	app: App,
	operations: ReversibleToolOp[],
	options: RecallRestoreOptions = {},
) {
	const normalizedOperations = operations
		.map(normalizeReversibleToolOpRecord)
		.filter((op): op is ReversibleToolOp => !!op)
	if (normalizedOperations.length === 0) {
		return
	}
	const virtualOperations = normalizedOperations.filter((operation) =>
		operation.vaultPath.startsWith('/'),
	)
	if (virtualOperations.length > 0) {
		await restoreVirtualFilesForRecall(app, virtualOperations, options)
	}
	const legacyOperations = normalizedOperations.filter(
		(operation) => !operation.vaultPath.startsWith('/'),
	)
	if (legacyOperations.length === 0) return

	const earliestByPath = new Map<string, (typeof legacyOperations)[number]>()
	for (const operation of legacyOperations) {
		if (!earliestByPath.has(operation.vaultPath)) {
			earliestByPath.set(operation.vaultPath, operation)
		}
	}

	const deletePaths = new Set<string>()
	const restoreDirs = new Set<string>()
	const restoreFiles = new Map<
		string,
		Extract<ReversibleToolOp, { operation: 'update' }>['before']
	>()

	for (const operation of earliestByPath.values()) {
		if (operation.operation === 'create') {
			deletePaths.add(operation.vaultPath)
			continue
		}
		if (operation.operation === 'update') {
			if (isSkippedFileSnapshot(operation.before)) {
				logger.warn(
					`Recall restore skipped ${operation.vaultPath}: snapshot content was not retained`,
				)
				continue
			}
			restoreFiles.set(operation.vaultPath, operation.before)
			continue
		}
		if (operation.before.kind === 'dir') {
			restoreDirs.add(operation.vaultPath)
			continue
		}
		if (isSkippedFileSnapshot(operation.before)) {
			logger.warn(
				`Recall restore skipped ${operation.vaultPath}: snapshot content was not retained`,
			)
			continue
		}
		restoreFiles.set(operation.vaultPath, operation.before)
	}

	logger.info(
		`Recall restore start: ${normalizedOperations.length} recorded ops, ` +
			`${deletePaths.size} deletes, ${restoreDirs.size} directories, ${restoreFiles.size} files.`,
	)

	for (const path of [...deletePaths].sort((left, right) => {
		const depthDelta = getPathDepth(right) - getPathDepth(left)
		return depthDelta !== 0 ? depthDelta : left.localeCompare(right)
	})) {
		await deleteVaultPathIfExists(app, path)
	}

	const requiredDirs = new Set<string>(restoreDirs)
	for (const filePath of restoreFiles.keys()) {
		for (const parentPath of getParentVaultPaths(filePath)) {
			requiredDirs.add(parentPath)
		}
	}

	for (const path of [...requiredDirs].sort((left, right) => {
		const depthDelta = getPathDepth(left) - getPathDepth(right)
		return depthDelta !== 0 ? depthDelta : left.localeCompare(right)
	})) {
		await ensureVaultDirectory(app, path)
	}

	for (const filePath of [...restoreFiles.keys()].sort((left, right) => {
		const depthDelta = getPathDepth(left) - getPathDepth(right)
		return depthDelta !== 0 ? depthDelta : left.localeCompare(right)
	})) {
		const snapshot = restoreFiles.get(filePath)
		if (snapshot) {
			await writeVaultFile(app, filePath, snapshot)
		}
	}

	logger.info('Recall restore completed.')
}

async function restoreVirtualFilesForRecall(
	app: App,
	operations: ReversibleToolOp[],
	options: RecallRestoreOptions,
) {
	await restoreVirtualReversibleOperations(app, operations, {
		fileSystemManager: options.fileSystemManager,
		settingsIo: options.settingsIo,
	})
}

async function deleteVaultPathIfExists(app: App, path: string) {
	const target = app.vault.getAbstractFileByPath(path)
	if (!target) {
		return
	}
	if (isVaultFolder(target) && target.children.length > 0) {
		logger.info(`Recall restore skip non-empty dir: ${path}`)
		return
	}
	logger.info(`Recall restore delete: ${path}`)
	await app.fileManager.trashFile(target)
}

async function ensureVaultDirectory(app: App, path: string) {
	if (!path) {
		return
	}
	const target = app.vault.getAbstractFileByPath(path)
	if (target) {
		if (isVaultFolder(target)) {
			return
		}
		throw new Error(`Unable to restore ${path}: a file already exists there.`)
	}
	logger.info(`Recall restore mkdir: ${path}`)
	await app.vault.createFolder(path)
}

async function writeVaultFile(
	app: App,
	path: string,
	content: Extract<ReversibleToolOp, { operation: 'update' }>['before'],
) {
	if (isSkippedFileSnapshot(content)) {
		logger.warn(
			`Recall restore skipped ${path}: snapshot content was not retained`,
		)
		return
	}
	const data = await decodeReversibleFileSnapshot(content)
	const existing = app.vault.getAbstractFileByPath(path)
	if (existing && isVaultFolder(existing)) {
		throw new Error(
			`Unable to restore ${path}: a directory already exists there.`,
		)
	}
	if (existing && isVaultFile(existing)) {
		logger.info(`Recall restore write: ${path} (overwrite)`)
		await app.vault.modifyBinary(existing as never, data)
		return
	}
	logger.info(`Recall restore write: ${path} (create)`)
	await app.vault.createBinary(path, data)
}
