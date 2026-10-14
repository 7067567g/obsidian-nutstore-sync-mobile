/**
 * R-001 / P-004 mock evidence (no real device required).
 *
 * `obsidianFetch` (WS3-B2) and `src/webdav-patch.ts` (WS8-B1) both build a
 * `Response` with the raw `requestUrl` status. The Fetch `Response` constructor
 * only accepts 200–599, so informational statuses (101/103) throw `RangeError`;
 * statuses >= 600 fail even earlier because `getReasonPhrase` has no entry.
 * Either way the whole request fails. These tests pin the current behaviour with
 * a mocked `requestUrl` so the defect is verifiable without an Obsidian runtime.
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

	it('throws RangeError for informational status 101', async () => {
		requestUrl.mockResolvedValue(makeResponse(101))
		await expect(obsidianFetch('https://example.com/')).rejects.toThrow(
			RangeError,
		)
	})

	it('throws RangeError for informational status 103', async () => {
		requestUrl.mockResolvedValue(makeResponse(103))
		await expect(obsidianFetch('https://example.com/')).rejects.toThrow(
			RangeError,
		)
	})

	it('fails for out-of-range status 600 (no reason phrase defined)', async () => {
		requestUrl.mockResolvedValue(makeResponse(600))
		await expect(obsidianFetch('https://example.com/')).rejects.toThrow(
			/Status code does not exist/,
		)
	})

	it('root cause is the platform Response constructor (200–599 only)', () => {
		expect(() => new Response(null, { status: 101 })).toThrow(RangeError)
		expect(() => new Response(null, { status: 103 })).toThrow(RangeError)
		expect(() => new Response(null, { status: 600 })).toThrow(RangeError)
		expect(() => new Response(null, { status: 599 })).not.toThrow()
	})
})
