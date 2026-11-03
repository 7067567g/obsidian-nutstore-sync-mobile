import { isAbsolute } from 'path-browserify'
import type { TraverseWebDAVCache } from '~/storage'
import { stdRemotePath } from './std-remote-path'

function normalizeAbsolutePrefix(path: string): string {
	return stdRemotePath(path).slice(0, -1)
}

function belongsToRemoteBaseDir(path: string, remoteBaseDir: string): boolean {
	// WS-5 / H9-F3 (K15 validator): a cache key that is not absolute cannot be
	// proven to belong to the configured remote base dir, so fail closed.
	// Treating it as "belongs to any base" let a relative-keyed cache bypass the
	// scope check on the import/restore path.
	if (!isAbsolute(path)) {
		return false
	}

	const normalizedPath = normalizeAbsolutePrefix(path)
	const normalizedBaseDir = normalizeAbsolutePrefix(remoteBaseDir)
	return (
		normalizedPath === normalizedBaseDir ||
		normalizedPath.startsWith(`${normalizedBaseDir}/`)
	)
}

export function isTraversalCacheCompatible(
	cache: TraverseWebDAVCache,
	remoteBaseDir: string,
): boolean {
	for (const path of cache.queue ?? []) {
		if (!belongsToRemoteBaseDir(path, remoteBaseDir)) {
			return false
		}
	}

	for (const [dirPath, stats] of Object.entries(cache.nodes ?? {})) {
		if (!belongsToRemoteBaseDir(dirPath, remoteBaseDir)) {
			return false
		}

		for (const stat of stats) {
			if (!belongsToRemoteBaseDir(stat.path, remoteBaseDir)) {
				return false
			}
		}
	}

	return true
}
