import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestUrl = vi.hoisted(() => vi.fn())
const sleep = vi.hoisted(() => vi.fn(async () => undefined))
const loggerError = vi.hoisted(() => vi.fn())

vi.mock('~/utils/request-url', () => ({ default: requestUrl }))
vi.mock('~/utils/sleep', () => ({ default: sleep }))
vi.mock('~/utils/logger', () => ({ default: { error: loggerError } }))
vi.mock('~/utils/nutstore-endpoints', () => ({
	getNutstoreDavEndpoint: () => 'https://dav.jianguoyun.com/dav',
}))

import { getDirectoryContents } from './webdav'

function multistatus(entries: string) {
	return (
		'<?xml version="1.0" encoding="utf-8"?>' +
		`<multistatus xmlns="DAV:">${entries}</multistatus>`
	)
}

function directoryEntry(href: string) {
	return (
		'<response><href>' +
		href +
		'</href><propstat><prop><displayname>dir</displayname>' +
		'<resourcetype><collection/></resourcetype></prop>' +
		'<status>HTTP/1.1 200 OK</status></propstat></response>'
	)
}

function fileEntry(href: string) {
	return (
		'<response><href>' +
		href +
		'</href><propstat><prop><displayname>a.txt</displayname>' +
		'<resourcetype/><getlastmodified>Wed, 01 Jan 2025 00:00:00 GMT</getlastmodified>' +
		'<getcontentlength>3</getcontentlength><getcontenttype>text/plain</getcontenttype>' +
		'</prop><status>HTTP/1.1 200 OK</status></propstat></response>'
	)
}

function ok(text: string, headers: Record<string, string> = {}) {
	return { status: 207, text, headers }
}

const FIRST_PAGE = multistatus(
	directoryEntry('/dav/folder/') + fileEntry('/dav/folder/a.txt'),
)
const SECOND_PAGE = multistatus(
	directoryEntry('/dav/folder/') + fileEntry('/dav/folder/b.txt'),
)

describe('getDirectoryContents pagination (A11) and 503 retry (A14)', () => {
	beforeEach(() => {
		requestUrl.mockReset()
		sleep.mockClear()
		loggerError.mockClear()
	})

	it('follows a relative rel=next Link header', async () => {
		requestUrl.mockResolvedValueOnce(
			ok(FIRST_PAGE, { link: '</dav/folder?page=2>; rel="next"' }),
		)
		requestUrl.mockResolvedValueOnce(ok(SECOND_PAGE))

		const contents = await getDirectoryContents({} as never, 'token', 'folder')

		expect(contents.map((item) => item.filename)).toEqual([
			'/folder/a.txt',
			'/folder/b.txt',
		])
		expect(requestUrl).toHaveBeenCalledTimes(2)
		expect(requestUrl).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				url: 'https://dav.jianguoyun.com/dav/folder',
			}),
		)
		expect(requestUrl).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				url: 'https://dav.jianguoyun.com/dav/folder?page=2',
			}),
		)
	})

	it('keeps absolute rel=next links unchanged', async () => {
		requestUrl.mockResolvedValueOnce(
			ok(FIRST_PAGE, {
				link: '<https://mirror.example.com/dav/folder?page=2>; rel="next"',
			}),
		)
		requestUrl.mockResolvedValueOnce(ok(SECOND_PAGE))

		await getDirectoryContents({} as never, 'token', 'folder')

		expect(requestUrl).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				url: 'https://mirror.example.com/dav/folder?page=2',
			}),
		)
	})

	it('retries after a wrapped 503 error instead of aborting', async () => {
		requestUrl.mockRejectedValueOnce(
			Object.assign(new Error('503: Service Unavailable'), {
				res: { status: 503, text: 'Service Unavailable' },
			}),
		)
		requestUrl.mockResolvedValueOnce(ok(FIRST_PAGE))

		const contents = await getDirectoryContents({} as never, 'token', 'folder')

		expect(requestUrl).toHaveBeenCalledTimes(2)
		expect(sleep).toHaveBeenCalledWith(60_000)
		expect(loggerError).toHaveBeenCalled()
		expect(contents.map((item) => item.filename)).toEqual(['/folder/a.txt'])
	})
})
