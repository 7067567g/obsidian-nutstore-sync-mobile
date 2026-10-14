/**
 * Regression test for the P-006 fix in `getDelta` (WS-7).
 *
 * The original code dereferenced `result.response` / `result.response.delta`
 * after parsing the response XML, but only guarded `result.response.cursor`
 * with optional chaining. A response without a `<response>` node (error
 * payload) therefore threw `TypeError`. It now normalises to an empty delta.
 * A mocked `requestUrl` keeps the test free of a real server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NutstoreSettings } from '~/settings'

const requestUrl = vi.hoisted(() => vi.fn())

vi.mock('~/utils/request-url', () => ({ default: requestUrl }))
vi.mock('~/utils/ns-api', () => ({
	NSAPI: () => 'https://ns.example.com/delta',
}))
// Bypass Bottleneck so the tests are deterministic and fast.
vi.mock('~/utils/api-limiter', () => ({
	apiLimiter: { wrap: <T>(fn: T) => fn },
}))

import { getDelta } from './delta'

const settings = {} as NutstoreSettings

function makeResponse(xml: string) {
	return { status: 200, text: xml, headers: {} }
}

describe('getDelta response guard mock (R-001 / WS-7)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('returns an empty delta when the payload has no <response> node', async () => {
		requestUrl.mockResolvedValue(
			makeResponse('<?xml version="1.0" encoding="utf-8"?><error/>'),
		)

		const result = await getDelta({ folderName: 'f', settings, token: 't' })

		expect(result.response).toEqual({
			reset: false,
			cursor: '',
			hasMore: false,
			delta: { entry: [] },
		})
	})

	it('parses a valid delta payload and HTML-decodes entry paths', async () => {
		requestUrl.mockResolvedValue(
			makeResponse(
				`<?xml version="1.0" encoding="utf-8"?>
<response>
  <cursor>5</cursor>
  <hasMore>false</hasMore>
  <delta>
    <entry>
      <path>a&amp;b.md</path>
      <size>3</size>
      <isDeleted>false</isDeleted>
      <isDir>false</isDir>
      <modified>2026-01-01T00:00:00Z</modified>
      <revision>1</revision>
    </entry>
  </delta>
</response>`,
			),
		)

		const result = await getDelta({ folderName: 'f', settings, token: 't' })

		expect(result.response.cursor).toBe('5')
		expect(result.response.delta.entry).toHaveLength(1)
		expect(result.response.delta.entry[0].path).toBe('a&b.md')
	})

	it('defaults to an empty entry list when <delta> is absent', async () => {
		requestUrl.mockResolvedValue(
			makeResponse(
				'<?xml version="1.0" encoding="utf-8"?><response><cursor>9</cursor></response>',
			),
		)

		const result = await getDelta({ folderName: 'f', settings, token: 't' })

		expect(result.response.delta.entry).toEqual([])
	})
})
