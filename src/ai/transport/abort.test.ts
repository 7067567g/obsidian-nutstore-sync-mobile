import { describe, expect, it } from 'vitest'
import { createAbortError, isAbortError, throwIfAborted } from './abort'

describe('createAbortError', () => {
	it('creates an identifiable AbortError', () => {
		const error = createAbortError('stopped')
		expect(error.name).toBe('AbortError')
		expect(error.message).toBe('stopped')
		expect(isAbortError(error)).toBe(true)
	})
})

describe('isAbortError', () => {
	it('rejects non-abort values', () => {
		expect(isAbortError(new Error('boom'))).toBe(false)
		expect(isAbortError('AbortError')).toBe(false)
		expect(isAbortError(undefined)).toBe(false)
	})
})

describe('throwIfAborted', () => {
	it('is a no-op for live or missing signals', () => {
		expect(() => throwIfAborted(undefined)).not.toThrow()
		expect(() => throwIfAborted(new AbortController().signal)).not.toThrow()
	})

	it('rethrows the abort reason when it is an Error', () => {
		const controller = new AbortController()
		const reason = new Error('cancelled')
		controller.abort(reason)

		expect(() => throwIfAborted(controller.signal)).toThrow(reason)
	})

	it('wraps a non-Error abort reason in an AbortError', () => {
		const controller = new AbortController()
		controller.abort('cancelled')

		try {
			throwIfAborted(controller.signal)
			expect.unreachable('expected throwIfAborted to throw')
		} catch (error) {
			expect(isAbortError(error)).toBe(true)
			expect((error as Error).message).toBe('cancelled')
		}
	})
})
