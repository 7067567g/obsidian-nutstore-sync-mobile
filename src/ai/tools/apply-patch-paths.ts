import { normalizePath } from 'obsidian'
import { posix as pathPosix } from 'path-browserify'
import {
	AGENTS_MOUNT_POINT,
	SETTINGS_FILE_PATH,
	VAULT_MOUNT_POINT,
} from '~/ai/tools/bash/mount-points'
import { invalidPatch } from './apply-patch-parse'

export function readBinaryText(buffer: Uint8Array): string {
	return new TextDecoder('utf-8').decode(buffer)
}

export function resolveVirtualPath(rawPath: string): string {
	const trimmed = rawPath.trim()
	if (!trimmed) {
		invalidPatch(`empty path`)
	}
	const normalized = pathPosix.normalize(trimmed)

	if (normalized.startsWith('/')) {
		return normalized
	}
	const rel = normalizePath(pathPosix.normalize(trimmed))
	if (!rel || rel === '.' || rel === '..' || rel.startsWith('../')) {
		invalidPatch(`path escapes the vault: "${rawPath}"`)
	}
	return pathPosix.resolve(VAULT_MOUNT_POINT, rel)
}

/**
 * Key under which a virtual path is tracked as "read". Vault and adapter
 * mounts (bash reports them via their vault-relative onRead), while the
 * settings file is tracked by its full virtual path.
 */
export function toReadKey(virtualPath: string): string {
	const normalized = pathPosix.normalize(virtualPath)
	if (
		normalized === SETTINGS_FILE_PATH ||
		normalized.startsWith(`${SETTINGS_FILE_PATH}/`)
	) {
		return normalized
	}
	return normalized.startsWith('/') ? normalized.slice(1) : normalized
}

/** User-facing path: vault-relative for vault (back-compat), virtual otherwise. */
export function toDisplayKey(virtualPath: string): string {
	const normalized = pathPosix.normalize(virtualPath)
	if (
		normalized === AGENTS_MOUNT_POINT ||
		normalized.startsWith(`${AGENTS_MOUNT_POINT}/`) ||
		normalized === SETTINGS_FILE_PATH ||
		normalized.startsWith(`${SETTINGS_FILE_PATH}/`)
	) {
		return normalized
	}
	return normalized.startsWith('/') ? normalized.slice(1) : normalized
}

export function assertUniqueVirtualPaths(paths: string[]) {
	const claimed = new Set<string>()
	for (const virtual of paths) {
		if (claimed.has(virtual)) {
			invalidPatch(`multiple operations target "${virtual}"`)
		}
		claimed.add(virtual)
	}
}
