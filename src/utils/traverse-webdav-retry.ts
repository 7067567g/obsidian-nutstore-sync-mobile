import { Mutex } from 'async-mutex'
import { is503Error } from './is-503-error'
import sleep from './sleep'
import { MaybePromise } from './types'

// Global mutex map: one lock per kvKey
const traversalLocks = new Map<string, Mutex>()

export function getTraversalLock(kvKey: string): Mutex {
	if (!traversalLocks.has(kvKey)) {
		traversalLocks.set(kvKey, new Mutex())
	}
	return traversalLocks.get(kvKey)!
}

export async function executeWithRetry<T>(
	func: () => MaybePromise<T>,
	options: {
		onRetry?: () => void
		throwIfCancelled?: () => void
	} = {},
): Promise<T> {
	while (true) {
		options.throwIfCancelled?.()
		try {
			return await func()
		} catch (err) {
			const normalizedError =
				err instanceof Error || typeof err === 'string'
					? err
					: new Error(String(err))
			if (is503Error(normalizedError)) {
				options.onRetry?.()
				for (let waited = 0; waited < 30_000; waited += 500) {
					options.throwIfCancelled?.()
					await sleep(500)
				}
			} else {
				throw err
			}
		}
	}
}
