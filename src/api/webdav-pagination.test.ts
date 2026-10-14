/**
 * Regression test for the P-006 fix in `getDirectoryContents` (WS-7).
 *
 * `rel="next"` Link values may be relative references (legal per RFC 8288). The
 * original code called `new URL(nextLink)` with no base URL, which threw
 * `TypeError: Invalid URL` and aborted the whole directory listing. It now
 * resolves against the current request URL. A mocked `requestUrl` keeps the
 * test free of a real DAV server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NutstoreSettings } from '~/settings'

const requestUrl = vi.hoisted(() => vi.fn())

vi.mock('~/utils/request-url', () => ({ default: requestUrl }))
vi.mock('~/utils/nutstore-endpoints', () => ({
	getNutstoreDavEndpoint: () => 'https://dav.example.com/dav',
}))

import { getDirectoryContents } from './webdav'

const settings = {} as NutstoreSettings
const DAV_XML = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response><href>/dav/</href><propstat><prop><displayname>dav</displayname><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>/dav/a.md</href><propstat><prop><displayname>a.md</displayname><resourcetype></resourcetype><getlastmodified>2026-01-01T00:00:00Z</getlastmodified><getcontentlength>3</getcontentlength><getcontenttype>text/markdown</getcontenttype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`

function makeResponse(xml: string, link?: string) {
	return {
		status: 200,
		text: xml,
		headers: link ? { link } : ({} as Record<string, string>),
	}
}

describe('getDirectoryContents pagination mock (R-001 / WS-7)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('resolves a relative rel="next" link against the current request URL', async () => {
		requestUrl
			.mockResolvedValueOnce(
				makeResponse(DAV_XML, '</dav/page2>; rel="next"'),
			)
			.mockResolvedValueOnce(makeResponse(DAV_XML))

		const contents = await getDirectoryContents(settings, 'token', '/')

		expect(requestUrl).toHaveBeenCalledTimes(2)
		expect(requestUrl.mock.calls[1][0].url).toBe(
			'https://dav.example.com/dav/page2',
		)
		expect(contents).toHaveLength(2)
	})

	it('follows an absolute rel="next" link and returns both pages', async () => {
		requestUrl
			.mockResolvedValueOnce(
				makeResponse(
					DAV_XML,
					'<https://dav.example.com/dav/page2>; rel="next"',
				),
			)
			.mockResolvedValueOnce(makeResponse(DAV_XML))

		const contents = await getDirectoryContents(settings, 'token', '/')

		expect(requestUrl).toHaveBeenCalledTimes(2)
		expect(contents).toHaveLength(2)
		expect(contents.map((item) => item.basename)).toEqual(['a.md', 'a.md'])
	})
})
