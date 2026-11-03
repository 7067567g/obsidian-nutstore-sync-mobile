/**
 * Regression tests for A06 (`src/ai/transport/obsidian-fetch.ts`).
 *
 * `obsidianFetch` forwards the raw `requestUrl` status into `new Response`.
 * The Fetch `Response` constructor only accepts 200–599, so 0/101/103/600 used
 * to throw `RangeError`; and `getReasonPhrase` throws "Status code does not
 * exist" for codes missing from the `http-status-codes` table (0/499/520/599/
 * 600). The fix clamps the status into [200, 599] and makes the reason phrase
 * lookup fault-tolerant. A mocked `requestUrl` keeps this test free of an
 * Obsidian runtime.
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

describe('obsidianFetch non-standard status codes (A06)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('status 0 is clamped to 200 without throwing', async () => {
		requestUrl.mockResolvedValue(makeResponse(0))
		const response = await obsidianFetch('https://example.com/')
		expect(response).toBeInstanceOf(Response)
		expect(response.status).toBe(200)
	})

	it('informational status 101 is clamped to 200 without throwing', async () => {
		requestUrl.mockResolvedValue(makeResponse(101))
		const response = await obsidianFetch('https://example.com/')
		expect(response.status).toBe(200)
	})

	it('informational status 103 is clamped to 200 without throwing', async () => {
		requestUrl.mockResolvedValue(makeResponse(103))
		const response = await obsidianFetch('https://example.com/')
		expect(response.status).toBe(200)
	})

	it('non-IANA status 499 keeps its code without throwing', async () => {
		requestUrl.mockResolvedValue(makeResponse(499))
		const response = await obsidianFetch('https://example.com/')
		expect(response.status).toBe(499)
	})

	it('non-IANA status 520 keeps its code without throwing', async () => {
		requestUrl.mockResolvedValue(makeResponse(520))
		const response = await obsidianFetch('https://example.com/')
		expect(response.status).toBe(520)
	})

	it('boundary status 599 keeps its code without throwing', async () => {
		requestUrl.mockResolvedValue(makeResponse(599))
		const response = await obsidianFetch('https://example.com/')
		expect(response.status).toBe(599)
	})

	it('out-of-range status 600 is clamped to 500 without throwing', async () => {
		requestUrl.mockResolvedValue(makeResponse(600))
		const response = await obsidianFetch('https://example.com/')
		expect(response.status).toBe(500)
	})

	it('normal status 200 passes through unchanged', async () => {
		requestUrl.mockResolvedValue(makeResponse(200))
		const response = await obsidianFetch('https://example.com/')
		expect(response.status).toBe(200)
		expect(response.statusText).toBe('OK')
	})

	it('root cause: the platform Response constructor rejects 1xx and >=600', () => {
		expect(() => new Response(null, { status: 101 })).toThrow(RangeError)
		expect(() => new Response(null, { status: 600 })).toThrow(RangeError)
		expect(() => new Response(null, { status: 599 })).not.toThrow()
	})
})
