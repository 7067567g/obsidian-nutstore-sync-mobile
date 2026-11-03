/**
 * Regression tests for A07 (`src/webdav-patch.ts`).
 *
 * The patched `request` handler builds a `Response` from the raw `requestUrl`
 * status. The Fetch `Response` constructor only accepts 200–599, so 0/1xx/600
 * threw `RangeError`; and `getReasonPhrase` throws "Status code does not exist"
 * for codes missing from the `http-status-codes` table (0/499/520/599/600).
 * The fix clamps the status into [200, 599] and makes the reason phrase lookup
 * fault-tolerant, so WebDAV traversal/read-write keeps working on non-standard
 * statuses.
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

describe('webdav-patch request handler status mapping (A07)', () => {
	beforeEach(() => {
		requestUrl.mockReset()
	})

	it('registers a `request` patch when VALID_REQURL is true', () => {
		expect(getPatcher).toHaveBeenCalled()
		expect(patch).toHaveBeenCalledWith('request', expect.any(Function))
	})

	it('status 0 is clamped to 200 without throwing', async () => {
		requestUrl.mockResolvedValue(requestUrlResponse(0))
		const response = await handler(requestOptions())
		expect(response.status).toBe(200)
	})

	it('informational status 101 is clamped to 200 without throwing', async () => {
		requestUrl.mockResolvedValue(requestUrlResponse(101))
		const response = await handler(requestOptions())
		expect(response.status).toBe(200)
	})

	it('informational status 103 is clamped to 200 without throwing', async () => {
		requestUrl.mockResolvedValue(requestUrlResponse(103))
		const response = await handler(requestOptions())
		expect(response.status).toBe(200)
	})

	it('non-IANA status 499 keeps its code without throwing', async () => {
		requestUrl.mockResolvedValue(requestUrlResponse(499))
		const response = await handler(requestOptions())
		expect(response.status).toBe(499)
	})

	it('non-IANA status 520 keeps its code without throwing', async () => {
		requestUrl.mockResolvedValue(requestUrlResponse(520))
		const response = await handler(requestOptions())
		expect(response.status).toBe(520)
	})

	it('boundary status 599 keeps its code without throwing', async () => {
		requestUrl.mockResolvedValue(requestUrlResponse(599))
		const response = await handler(requestOptions())
		expect(response.status).toBe(599)
	})

	it('out-of-range status 600 is clamped to 500 without throwing', async () => {
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

describe('webdav-patch traversal/read/write survive non-standard statuses (A07)', () => {
	beforeEach(() => {
		requestUrl.mockReset()
	})

	it('PROPFIND traversal with status 520 still returns a Response', async () => {
		requestUrl.mockResolvedValue(requestUrlResponse(520))
		const response = await handler({ ...requestOptions(), method: 'PROPFIND' })
		expect(response).toBeInstanceOf(Response)
		expect(response.status).toBe(520)
	})

	it('GET read with status 499 still returns a Response', async () => {
		requestUrl.mockResolvedValue(requestUrlResponse(499))
		const response = await handler({ ...requestOptions(), method: 'GET' })
		expect(response).toBeInstanceOf(Response)
		expect(response.status).toBe(499)
	})

	it('PUT write with status 600 still returns a Response (clamped to 500)', async () => {
		requestUrl.mockResolvedValue(requestUrlResponse(600))
		const response = await handler({ ...requestOptions(), method: 'PUT' })
		expect(response).toBeInstanceOf(Response)
		expect(response.status).toBe(500)
	})
})
