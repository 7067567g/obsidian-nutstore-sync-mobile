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

async function bestEffortRemove(vault: Vault, path: string): Promise<boolean> {
	try {
		if (await adapterExists(vault, path)) {
			await vault.adapter.remove(path)
		}
		return true
	} catch {
		return false
	}
}

/**
 * R2b / S4: targets whose previous atomic replace could not clean up its backup
 * (failed restore or failed removal). Only these paths pay for a directory
 * listing on the next write; a fresh process has an empty set and relies on the
 * startup scan (`recoverOrphanedBackups`) instead of scanning on every write.
 */
const pendingOrphanRecovery = new WeakMap<Vault, Set<string>>()

function markPendingOrphanRecovery(vault: Vault, target: string) {
	let targets = pendingOrphanRecovery.get(vault)
	if (!targets) {
		targets = new Set()
		pendingOrphanRecovery.set(vault, targets)
	}
	targets.add(target)
}

/**
 * Consume the "marker" for a target. Returns true only when a previous write for
 * this exact target left a backup behind, so the hot path can skip the scan.
 */
function consumePendingOrphanRecovery(vault: Vault, target: string): boolean {
	const targets = pendingOrphanRecovery.get(vault)
	if (!targets?.has(target)) return false
	targets.delete(target)
	return true
}

/**
 * Restore (or drop) backup siblings left behind by a crash between the
 * target→backup and temp→target renames. Callers can invoke this on startup
 * for a directory: an orphan backup whose target is missing is renamed back
 * into place, a backup whose target is present is treated as stale and
 * removed. Returns the number of targets restored.
 *
 * All failures are swallowed — recovery is best effort and must never block
 * plugin startup.
 */
export async function recoverOrphanedBackups(
	vault: Vault,
	directory: string,
): Promise<number> {
	const normalizedDirectory = normalizePath(directory)
	let files: string[]
	try {
		const listed = await vault.adapter.list(normalizedDirectory)
		files = listed.files ?? []
	} catch {
		return 0
	}
	let recovered = 0
	for (const file of files) {
		const normalizedFile = normalizePath(file)
		const slash = normalizedFile.lastIndexOf('/')
		const parent = slash >= 0 ? normalizedFile.slice(0, slash) : ''
		if (parent !== normalizedDirectory) continue
		const name = normalizedFile.slice(slash + 1)
		const markerIndex = name.lastIndexOf(ATOMIC_BACKUP_MARKER)
		if (markerIndex <= 0) continue
		const targetName = name.slice(0, markerIndex)
		if (!targetName) continue
		const targetPath = normalizePath(
			`${parent ? `${parent}/` : ''}${targetName}`,
		)
		try {
			if (await adapterExists(vault, targetPath)) {
				await bestEffortRemove(vault, normalizedFile)
			} else {
				await vault.adapter.rename(normalizedFile, targetPath)
				recovered += 1
			}
		} catch {
			/* best effort recovery */
		}
	}
	return recovered
}

/**
 * Self-healing variant scoped to one target path. Before installing a new
 * copy we reconcile leftover backups for the same target: restore one when
 * the target is missing (crash window), drop the rest as stale.
 */
async function recoverOrphanedBackupsForTarget(
	vault: Vault,
	normalizedTarget: string,
): Promise<void> {
	const directory = dirname(normalizedTarget)
	let files: string[]
	try {
		const listed = await vault.adapter.list(normalizePath(directory))
		files = listed.files ?? []
	} catch {
		return
	}
	const prefix = `${normalizedTarget}${ATOMIC_BACKUP_MARKER}`
	const backups = files
		.map((file) => normalizePath(file))
		.filter((file) => file.startsWith(prefix) && file.length > prefix.length)
	if (backups.length === 0) return
	const targetExists = await adapterExists(vault, normalizedTarget)
	let restored = false
	for (const backup of backups) {
		try {
			if (!targetExists && !restored) {
				await vault.adapter.rename(backup, normalizedTarget)
				restored = true
			} else {
				await vault.adapter.remove(backup)
			}
		} catch {
			/* best effort recovery */
		}
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

	// R2b / S4: heal an orphaned backup from a previous crash only when this
	// process recorded one (failed restore/cleanup for this target) — the
	// unconditional `list` here was paid by every write. A fresh process relies
	// on the one-shot startup scan (`recoverPendingTemps` → this module's
	// `recoverOrphanedBackups`).
	if (consumePendingOrphanRecovery(vault, normalizedTarget)) {
		await recoverOrphanedBackupsForTarget(vault, normalizedTarget)
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
				// Preserve the original error; the next write for this target runs
				// the targeted recovery scan because of this marker.
				markPendingOrphanRecovery(vault, normalizedTarget)
			}
		}
		throw error
	} finally {
		if (installed) {
			const removed = await bestEffortRemove(vault, backupPath)
			await bestEffortRemove(vault, normalizedTemp)
			if (!removed) markPendingOrphanRecovery(vault, normalizedTarget)
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
