/**
 * Regression test for the P-006 fix in `obsidianFetch` (WS3-B2 / WS8-B1).
 *
 * `obsidianFetch` builds a `Response` with the raw `requestUrl` status. The
 * Fetch `Response` constructor only accepts 200–599, so informational statuses
 * (101/103) used to throw `RangeError`; statuses >= 600 failed even earlier
 * because `getReasonPhrase` has no entry. It now maps out-of-range statuses into
 * the valid range so the request no longer fails. A mocked `requestUrl` keeps
 * this test free of an Obsidian runtime.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestUrl = vi.hoisted(() => vi.fn())

vi.mock('~/utils/request-url', () => ({ default: requestUrl }))

import { obsidianFetch } from './obsidian-fetch'

function makeResponse(status: number) {
	return {
		status,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
	}
}

describe('obsidianFetch status range mock (R-001 / WS3-B2 / WS8-B1)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('maps informational status 101 to a valid Response (200) without throwing', async () => {
		requestUrl.mockResolvedValue(makeResponse(101))
		const response = await obsidianFetch('https://example.com/')
		expect(response).toBeInstanceOf(Response)
		expect(response.status).toBe(200)
	})

	it('maps informational status 103 to a valid Response (200) without throwing', async () => {
		requestUrl.mockResolvedValue(makeResponse(103))
		const response = await obsidianFetch('https://example.com/')
		expect(response.status).toBe(200)
	})

	it('maps out-of-range status 600 to 500 without throwing', async () => {
		requestUrl.mockResolvedValue(makeResponse(600))
		const response = await obsidianFetch('https://example.com/')
		expect(response.status).toBe(500)
	})

	it('root cause is the platform Response constructor (200–599 only)', () => {
		expect(() => new Response(null, { status: 101 })).toThrow(RangeError)
		expect(() => new Response(null, { status: 103 })).toThrow(RangeError)
		expect(() => new Response(null, { status: 600 })).toThrow(RangeError)
		expect(() => new Response(null, { status: 599 })).not.toThrow()
	})
})
