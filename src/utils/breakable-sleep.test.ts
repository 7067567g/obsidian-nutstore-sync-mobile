import { describe, expect, it, vi } from 'vitest'
import { of, Subject, throwError } from 'rxjs'
import breakableSleep from './breakable-sleep'

describe('breakableSleep', () => {
	it('resolves when the source emits synchronously during subscribe', async () => {
		await expect(breakableSleep(of(1), 10_000)).resolves.toBeUndefined()
	})

	it('rejects when the source errors synchronously during subscribe', async () => {
		await expect(
			breakableSleep(
				throwError(() => new Error('cancelled')),
				10_000,
			),
		).rejects.toThrow('cancelled')
	})

	it('resolves when the source emits later', async () => {
		const subject = new Subject<void>()
		const promise = breakableSleep(subject, 10_000)
		window.setTimeout(() => subject.next(), 5)
		await expect(promise).resolves.toBeUndefined()
	})

	it('resolves after the timeout when the source never emits', async () => {
		vi.useFakeTimers()
		try {
			const promise = breakableSleep(new Subject<void>(), 1234)
			await vi.advanceTimersByTimeAsync(1234)
			await expect(promise).resolves.toBeUndefined()
		} finally {
			vi.useRealTimers()
		}
	})
})
