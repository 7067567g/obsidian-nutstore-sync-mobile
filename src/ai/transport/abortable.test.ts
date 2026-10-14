import { describe, expect, it } from 'vitest'
import { raceWithAbort } from './abortable'

describe('raceWithAbort', () => {
	it('resolves with the promise value when not aborted', async () => {
		const controller = new AbortController()
		await expect(
			raceWithAbort(Promise.resolve(42), controller.signal),
		).resolves.toBe(42)
	})

	it('returns the original promise when there is no signal', async () => {
		const original = Promise.resolve('ok')
		await expect(raceWithAbort(original)).resolves.toBe('ok')
	})

	it('propagates rejection from the wrapped promise', async () => {
		const controller = new AbortController()
		await expect(
			raceWithAbort(Promise.reject(new Error('failed')), controller.signal),
		).rejects.toThrow('failed')
	})

	it('rejects with the abort reason when aborted before settling', async () => {
		const controller = new AbortController()
		const pending = new Promise<string>(() => undefined)
		const raced = raceWithAbort(pending, controller.signal)
		const reason = new Error('aborted')
		controller.abort(reason)

		await expect(raced).rejects.toBe(reason)
	})

	it('throws synchronously for an already-aborted signal', () => {
		const controller = new AbortController()
		controller.abort()

		expect(() =>
			raceWithAbort(Promise.resolve(1), controller.signal),
		).toThrow()
	})
})
