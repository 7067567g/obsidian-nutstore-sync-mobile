import { describe, expect, it, vi } from 'vitest'
import useStorage, {
	isIndexedDbConnectionLostError,
	type StorageInterface,
} from './use-storage'

class MemoryStorage<T> implements StorageInterface<T> {
	private readonly map = new Map<string, T>()

	async setItem(key: string, value: T) {
		this.map.set(key, value)
		return value
	}

	async getItem(key: string) {
		return this.map.has(key) ? (this.map.get(key) as T) : null
	}

	async removeItem(key: string) {
		this.map.delete(key)
	}

	async keys() {
		return [...this.map.keys()]
	}

	async clear() {
		this.map.clear()
	}
}

describe('isIndexedDbConnectionLostError', () => {
	it('matches known connection-lost messages', () => {
		expect(
			isIndexedDbConnectionLostError(
				new Error('Connection to IndexedDB server lost. Refresh the page'),
			),
		).toBe(true)
		expect(
			isIndexedDbConnectionLostError(
				new Error('Internal error opening backing store for indexedDB.open'),
			),
		).toBe(true)
	})

	it('ignores unrelated errors and empty values', () => {
		expect(isIndexedDbConnectionLostError(new Error('quota exceeded'))).toBe(
			false,
		)
		expect(isIndexedDbConnectionLostError(undefined)).toBe(false)
		expect(isIndexedDbConnectionLostError(null)).toBe(false)
	})
})

describe('useStorage', () => {
	it('supports basic set/get/unset/keys/clear', async () => {
		const storage = useStorage<string>(new MemoryStorage<string>())
		await storage.set('a', '1')
		await storage.set('b', '2')
		expect(await storage.get('a')).toBe('1')
		expect((await storage.keys()).sort()).toEqual(['a', 'b'])
		await storage.unset('a')
		expect(await storage.get('a')).toBeNull()
		await storage.clear()
		expect(await storage.keys()).toEqual([])
	})

	it('retries with a fresh instance when an IndexedDB connection is lost', async () => {
		let calls = 0
		const getFreshInstance = vi.fn(() => {
			calls += 1
			if (calls === 1) {
				const failing: StorageInterface<string> = {
					setItem: vi.fn(),
					getItem: vi
						.fn()
						.mockRejectedValue(
							new Error('connection to IndexedDB server lost'),
						),
					removeItem: vi.fn(),
					keys: vi.fn(),
					clear: vi.fn(),
				}
				return failing
			}
			const healthy = new MemoryStorage<string>()
			void healthy.setItem('k', 'v')
			return healthy
		})

		const storage = useStorage<string>({ getFreshInstance, maxRetries: 1 })
		expect(await storage.get('k')).toBe('v')
		expect(getFreshInstance).toHaveBeenCalledTimes(2)
	})

	it('does not retry non-recoverable errors', async () => {
		const failing: StorageInterface<string> = {
			setItem: vi.fn(),
			getItem: vi.fn().mockRejectedValue(new Error('disk full')),
			removeItem: vi.fn(),
			keys: vi.fn(),
			clear: vi.fn(),
		}
		const getFreshInstance = vi.fn(() => failing)
		const storage = useStorage<string>({ getFreshInstance, maxRetries: 3 })
		await expect(storage.get('k')).rejects.toThrow('disk full')
		expect(getFreshInstance).toHaveBeenCalledTimes(1)
	})

	it('round-trips dump/restore', async () => {
		const storage = useStorage<number>(new MemoryStorage<number>())
		await storage.set('a', 1)
		await storage.set('b', 2)
		const dumped = await storage.dump()
		await storage.clear()
		await storage.restore(dumped)
		expect(await storage.get('a')).toBe(1)
		expect(await storage.get('b')).toBe(2)
	})
})
