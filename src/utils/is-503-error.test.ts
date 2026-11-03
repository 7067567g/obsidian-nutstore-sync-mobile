import { describe, expect, it } from 'vitest'
import { is503Error } from './is-503-error'

describe('is503Error (A14)', () => {
	it('recognises the legacy webdav library message', () => {
		expect(
			is503Error(new Error('Invalid response: 503 Service Unavailable')),
		).toBe(true)
		expect(is503Error('Invalid response: 503 Service Unavailable')).toBe(true)
	})

	it('recognises a numeric 503 status on the error or its response', () => {
		expect(
			is503Error(Object.assign(new Error('boom'), { res: { status: 503 } })),
		).toBe(true)
		expect(is503Error(Object.assign(new Error('boom'), { status: 503 }))).toBe(
			true,
		)
	})

	it('recognises the wrapped `${status}: ${text}` message', () => {
		expect(is503Error(new Error('503: Service Unavailable'))).toBe(true)
		expect(is503Error('503: Service Unavailable')).toBe(true)
	})

	it('rejects other statuses and non-errors', () => {
		expect(is503Error(new Error('500: Internal Server Error'))).toBe(false)
		expect(
			is503Error(Object.assign(new Error('boom'), { res: { status: 500 } })),
		).toBe(false)
		expect(is503Error(new Error('Invalid response: 503'))).toBe(false)
		expect(is503Error(undefined)).toBe(false)
		expect(is503Error(null)).toBe(false)
	})
})
