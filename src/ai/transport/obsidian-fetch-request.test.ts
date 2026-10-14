/**
 * R-006 mock evidence (no real device required) for the `toRequestParts` body
 * decision in `obsidianFetch` (WS3-B4 待确认).
 *
 * When the input is a `Request` and `init.method` overrides it to GET/HEAD, the
 * body is still read because `toRequestParts` checks the *original*
 * `input.method`. These tests pin the current behaviour with a mocked
 * `requestUrl`; no Obsidian runtime is needed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestUrl = vi.hoisted(() => vi.fn())

vi.mock('~/utils/request-url', () => ({ default: requestUrl }))

import { obsidianFetch } from './obsidian-fetch'

describe('obsidianFetch body handling on method override (R-006 / WS3-B4)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('still reads the Request body when init.method overrides POST to GET', async () => {
		requestUrl.mockResolvedValue({
			status: 200,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
		})

		const request = new Request('https://example.com/x', {
			method: 'POST',
			body: 'hello',
		})
		await obsidianFetch(request, { method: 'GET' })

		const init = requestUrl.mock.calls[0][0] as {
			method: string
			body?: ArrayBuffer
		}
		expect(init.method).toBe('GET')
		// Candidate defect: a GET carries a body because the original method
		// (POST) drove the body decision.
		expect(init.body).toBeInstanceOf(ArrayBuffer)
		expect(init.body?.byteLength).toBeGreaterThan(0)
	})
})
