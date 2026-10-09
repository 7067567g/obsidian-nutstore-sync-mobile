import { normalizePath, Vault } from 'obsidian'
import { dirname } from 'path-browserify'
import { mkdirsVault } from './mkdirs-vault'

export const ATOMIC_TEMP_MARKER = '.nutstore-sync-temp-'
export const ATOMIC_BACKUP_MARKER = '.nutstore-sync-backup-'

function siblingPath(normalizedPath: string, suffix: string) {
	const directory = dirname(normalizedPath)
	const name = normalizedPath.slice(
		directory === '.' ? 0 : directory.length + 1,
	)
	return normalizePath(
		`${directory === '.' ? '' : `${directory}/`}${name}${suffix}`,
	)
}

function uniqueSuffix() {
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function adapterExists(vault: Vault, path: string) {
	try {
		return await vault.adapter.exists(path)
	} catch {
		return false
	}
}

async function bestEffortRemove(vault: Vault, path: string) {
	try {
		if (await adapterExists(vault, path)) {
			await vault.adapter.remove(path)
		}
	} catch {
		/* best effort */
	}
}

/**
 * Atomically replace `targetPath` with an already-written sibling temp file.
 *
 * The previous target is renamed to a sibling backup first, so an interrupted
 * or failed rename can restore it. The target is never removed before the new
 * content is ready on disk.
 */
export async function atomicReplaceFromTemp(
	vault: Vault,
	tempPath: string,
	targetPath: string,
): Promise<void> {
	const normalizedTarget = normalizePath(targetPath)
	const normalizedTemp = normalizePath(tempPath)
	if (!(await adapterExists(vault, normalizedTemp))) {
		throw new Error(`Atomic replace temp file not found: ${normalizedTemp}`)
	}

	await mkdirsVault(vault, dirname(normalizedTarget))
	const backupPath = siblingPath(
		normalizedTarget,
		`${ATOMIC_BACKUP_MARKER}${uniqueSuffix()}`,
	)
	let backupCreated = false
	let installed = false

	try {
		if (await adapterExists(vault, normalizedTarget)) {
			await bestEffortRemove(vault, backupPath)
			await vault.adapter.rename(normalizedTarget, backupPath)
			backupCreated = true
		}
		await vault.adapter.rename(normalizedTemp, normalizedTarget)
		installed = true
	} catch (error) {
		if (!installed && backupCreated) {
			try {
				if (await adapterExists(vault, normalizedTarget)) {
					await vault.adapter.remove(normalizedTarget)
				}
				await vault.adapter.rename(backupPath, normalizedTarget)
				backupCreated = false
			} catch {
				// Preserve the original error; a manual recovery may be needed.
			}
		}
		throw error
	} finally {
		if (installed) {
			await bestEffortRemove(vault, backupPath)
			await bestEffortRemove(vault, normalizedTemp)
		}
	}
}

/**
 * Write `data` to a sibling temp file, then atomically replace the target.
 * This is the mobile-safe alternative to relying on adapter.write being atomic.
 */
export async function atomicReplaceContent(
	vault: Vault,
	targetPath: string,
	data: string | ArrayBuffer,
	kind: 'text' | 'binary',
): Promise<void> {
	const normalizedTarget = normalizePath(targetPath)
	await mkdirsVault(vault, dirname(normalizedTarget))
	const tempPath = siblingPath(
		normalizedTarget,
		`${ATOMIC_TEMP_MARKER}${uniqueSuffix()}`,
	)
	try {
		if (kind === 'binary') {
			await vault.adapter.writeBinary(tempPath, data as ArrayBuffer)
		} else {
			await vault.adapter.write(tempPath, data as string)
		}
		await atomicReplaceFromTemp(vault, tempPath, normalizedTarget)
	} finally {
		await bestEffortRemove(vault, tempPath)
	}
}
