import { StatModel } from '~/model/stat.model'
import { traverseWebDAVKV } from '~/storage'
import logger from './logger'
import { isTraversalCacheCompatible } from './traversal-cache-compat'

export type LoadedTraversalState =
	| { kind: 'empty' }
	| { kind: 'incompatible' }
	| {
			kind: 'loaded'
			rootCursor: string
			queue: string[]
			nodes: Record<string, StatModel[]>
	  }

/**
 * Load a persisted traversal cache.
 *
 * `empty` means there was nothing to load (caller keeps its current fields);
 * `incompatible` means the cached directory did not match and the cache was
 * cleared (caller must reset its in-memory state).
 */
export async function loadTraversalState(
	kvKey: string,
	remoteBaseDir: string,
): Promise<LoadedTraversalState> {
	const cache = await traverseWebDAVKV.get(kvKey)
	if (!cache) {
		return { kind: 'empty' }
	}
	if (!isTraversalCacheCompatible(cache, remoteBaseDir)) {
		logger.warn(
			'Discarding incompatible traversal cache for current remote directory',
		)
		await traverseWebDAVKV.unset(kvKey)
		return { kind: 'incompatible' }
	}
	return {
		kind: 'loaded',
		rootCursor: cache.rootCursor || '',
		queue: cache.queue || [],
		nodes: cache.nodes || {},
	}
}

/**
 * Persist the current traversal state.
 */
export async function saveTraversalState(
	kvKey: string,
	rootCursor: string,
	queue: string[],
	nodes: Record<string, StatModel[]>,
): Promise<void> {
	await traverseWebDAVKV.set(kvKey, {
		rootCursor,
		queue,
		nodes,
	})
}

/**
 * Drop the persisted traversal cache (force re-traversal).
 */
export async function clearTraversalState(kvKey: string): Promise<void> {
	await traverseWebDAVKV.unset(kvKey)
}

/**
 * Check if cache is valid (traversal completed, queue empty).
 */
export async function isTraversalStateValid(kvKey: string): Promise<boolean> {
	const cache = await traverseWebDAVKV.get(kvKey)
	if (!cache) {
		return false
	}
	return cache.queue.length === 0
}
