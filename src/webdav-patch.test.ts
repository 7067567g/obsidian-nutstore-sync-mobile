/**
 * Regression test for the P-006 fix in `src/webdav-patch.ts` (WS8-B1).
 *
 * The patched `request` handler built a `Response` with the raw `requestUrl`
 * status. The Fetch `Response` constructor only accepts 200–599, so 1xx
 * informational statuses threw `RangeError` (and >= 600 threw inside
 * `getReasonPhrase`). It now maps out-of-range statuses into the valid range.
 *
 * The module registers its handler as a side effect of being imported, so the
 * dependencies (`obsidian`, `webdav`, `~/obsidian-capabilities`,
 * `./utils/request-url`) are mocked and the captured handler is driven directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestUrl = vi.hoisted(() => vi.fn())
const patch = vi.hoisted(() => vi.fn())
const getPatcher = vi.hoisted(() => vi.fn(() => ({ patch })))

vi.mock('~/obsidian-capabilities', () => ({ VALID_REQURL: true }))
vi.mock('obsidian', () => ({
	Platform: { isIosApp: false, isAndroidApp: false },
}))
vi.mock('webdav', () => ({ getPatcher, RequestOptionsWithState: {} }))
vi.mock('./utils/request-url', () => ({ default: requestUrl }))

import './webdav-patch'

type Handler = (args: unknown) => Promise<Response>

// Captured once at import time (the side-effect registration). `patch` is not
// cleared so this reference stays valid across tests.
const handler = patch.mock.calls[0]?.[1] as Handler

function requestUrlResponse(status: number) {
	return { status, headers: {}, arrayBuffer: new ArrayBuffer(0) }
}

function requestOptions() {
	return {
		url: 'https://dav.example.com/dav/x',
		method: 'PROPFIND',
		headers: {},
		data: undefined,
	}
}

describe('webdav-patch request handler status mapping (P-006 / WS8-B1)', () => {
	beforeEach(() => {
		requestUrl.mockReset()
	})

	it('registers a `request` patch when VALID_REQURL is true', () => {
		expect(getPatcher).toHaveBeenCalled()
		expect(patch).toHaveBeenCalledWith('request', expect.any(Function))
	})

	it('maps informational status 101 to a valid Response (200)', async () => {
		requestUrl.mockResolvedValue(requestUrlResponse(101))
		const response = await handler(requestOptions())
		expect(response.status).toBe(200)
	})

	it('maps informational status 103 to a valid Response (200)', async () => {
		requestUrl.mockResolvedValue(requestUrlResponse(103))
		const response = await handler(requestOptions())
		expect(response.status).toBe(200)
	})

	it('maps out-of-range status 600 to 500 without throwing', async () => {
		requestUrl.mockResolvedValue(requestUrlResponse(600))
		const response = await handler(requestOptions())
		expect(response.status).toBe(500)
	})

	it('passes a normal 2xx status through unchanged', async () => {
		requestUrl.mockResolvedValue(requestUrlResponse(200))
		const response = await handler(requestOptions())
		expect(response.status).toBe(200)
	})
})
