import { beforeEach, describe, expect, it, vi } from 'vitest'

const req = vi.hoisted(() => vi.fn())
const loggerError = vi.hoisted(() => vi.fn())

vi.mock('obsidian', () => ({ requestUrl: req }))
vi.mock('./logger', () => ({ default: { error: loggerError } }))
vi.mock('./ua', () => ({
	isNutstoreHost: (url: string) => url.includes('jianguoyun'),
	MOCK_USER_AGENT: 'mock-ua',
	NS_SYNC_USER_AGENT: 'ns-ua',
}))

import { is503Error } from './is-503-error'
import requestUrl, { RequestUrlError } from './request-url'

function response(status: number, text = '') {
	return { status, text, headers: {} }
}

describe('requestUrl wrapper 503 signalling (A14)', () => {
	beforeEach(() => {
		req.mockReset()
		loggerError.mockReset()
	})

	it('throws a RequestUrlError carrying res.status/res.text on 503', async () => {
		req.mockResolvedValueOnce(response(503, 'Service Unavailable'))

		const error = await requestUrl('https://dav.jianguoyun.com/dav/x').catch(
			(caught: unknown) => caught,
		)

		expect(error).toBeInstanceOf(RequestUrlError)
		const requestError = error as RequestUrlError
		expect(requestError.status).toBe(503)
		expect(requestError.res.status).toBe(503)
		expect(requestError.res.text).toBe('Service Unavailable')
		expect(is503Error(error as Error)).toBe(true)
	})

	it('resolves without throwing when the caller opts out with throw:false', async () => {
		req.mockResolvedValueOnce(response(503, 'Service Unavailable'))

		const res = await requestUrl({
			url: 'https://dav.jianguoyun.com/dav/x',
			throw: false,
		})

		expect(res.status).toBe(503)
		expect(loggerError).toHaveBeenCalled()
	})

	it('still throws for non-503 error statuses', async () => {
		req.mockResolvedValueOnce(response(400, 'Bad Request'))

		await expect(
			requestUrl('https://dav.jianguoyun.com/dav/x'),
		).rejects.toBeInstanceOf(RequestUrlError)
	})
})
