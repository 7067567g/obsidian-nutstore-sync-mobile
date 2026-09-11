import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '~/ai/chat/domain'
import { SessionWriteQueue, type SessionWriteTask } from './session-write-queue'

function session(id: string) {
	return { id } as ChatSession
}

function task(
	id: string,
	isCurrent: () => boolean = () => true,
): SessionWriteTask {
	return {
		session: session(id),
		title: id,
		isCurrent,
	}
}

describe('SessionWriteQueue', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('coalesces a burst into one write with the latest task', async () => {
		const writes: SessionWriteTask[] = []
		const queue = new SessionWriteQueue(async (value) => {
			writes.push(value)
		}, 200)

		const first = queue.schedule(task('first'))
		const second = queue.schedule(task('second'))
		expect(writes).toHaveLength(0)

		vi.advanceTimersByTime(200)
		await Promise.all([first, second])

		expect(writes).toHaveLength(1)
		expect(writes[0].session.id).toBe('second')
		expect(writes[0].title).toBe('second')
	})

	it('does not reset the fixed window for later requests', async () => {
		const writes: SessionWriteTask[] = []
		const queue = new SessionWriteQueue(async (value) => {
			writes.push(value)
		}, 200)

		const first = queue.schedule(task('first'))
		vi.advanceTimersByTime(100)
		const second = queue.schedule(task('second'))
		vi.advanceTimersByTime(100)
		await Promise.all([first, second])

		expect(writes).toHaveLength(1)
		expect(writes[0].session.id).toBe('second')
	})

	it('flushes immediately and observes the serialized chain', async () => {
		const writes: string[] = []
		const queue = new SessionWriteQueue(async (value) => {
			await Promise.resolve()
			writes.push(value.session.id)
		}, 200)

		const promise = queue.schedule(task('one'))
		await queue.flush()
		await promise

		expect(writes).toEqual(['one'])
	})

	it('skips a write when the task is no longer current', async () => {
		const write = vi.fn(async () => undefined)
		const queue = new SessionWriteQueue(write, 200)
		const promise = queue.schedule(task('stale', () => false))

		await queue.flush()
		await promise

		expect(write).not.toHaveBeenCalled()
	})

	it('rejects the batch and lets a later schedule retry', async () => {
		const write = vi
			.fn<(value: SessionWriteTask) => Promise<void>>()
			.mockRejectedValueOnce(new Error('disk full'))
			.mockResolvedValueOnce(undefined)
		const queue = new SessionWriteQueue(write, 200)

		const first = queue.schedule(task('first'))
		const firstFlush = queue.flush()
		await expect(first).rejects.toThrow('disk full')
		await expect(firstFlush).rejects.toThrow('disk full')

		const second = queue.schedule(task('second'))
		const secondFlush = queue.flush()
		await secondFlush
		await second

		expect(write).toHaveBeenCalledTimes(2)
	})

	it('resolves pending waiters without writing when disposed', async () => {
		const write = vi.fn(async () => undefined)
		const queue = new SessionWriteQueue(write, 200)
		const promise = queue.schedule(task('pending'))

		await queue.dispose()
		await promise

		expect(write).not.toHaveBeenCalled()
	})
})
