import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestUrl = vi.hoisted(() => vi.fn())

vi.mock('~/utils/request-url', () => ({ default: requestUrl }))
vi.mock('~/utils/ns-api', () => ({
	NSAPI: () => 'https://api.example.com/delta',
}))
vi.mock('~/utils/api-limiter', () => ({
	apiLimiter: { wrap: (fn: unknown) => fn },
}))

import { getDelta } from './delta'

function queueXml(xml: string) {
	requestUrl.mockResolvedValueOnce({ status: 200, text: xml, headers: {} })
}

async function callGetDelta() {
	return getDelta({
		folderName: 'root',
		settings: {} as never,
		token: 'token',
	})
}

describe('getDelta response normalisation (A10)', () => {
	beforeEach(() => {
		requestUrl.mockReset()
	})

	it('normalises a payload without <response> to an empty delta', async () => {
		queueXml('<?xml version="1.0" encoding="utf-8"?><error>nope</error>')
		const result = await callGetDelta()
		expect(result.response.reset).toBe(false)
		expect(result.response.cursor).toBe('')
		expect(result.response.hasMore).toBe(false)
		expect(result.response.delta.entry).toEqual([])
	})

	it('normalises a missing <entry> (reset-only delta) to an empty array', async () => {
		queueXml(
			'<?xml version="1.0" encoding="utf-8"?>' +
				'<response><reset>true</reset><cursor>c1</cursor>' +
				'<hasMore>false</hasMore><delta></delta></response>',
		)
		const result = await callGetDelta()
		expect(result.response.reset).toBe(true)
		expect(result.response.cursor).toBe('c1')
		expect(result.response.delta.entry).toEqual([])
	})

	it('wraps a single <entry> object into an array and decodes entities', async () => {
		queueXml(
			'<?xml version="1.0" encoding="utf-8"?>' +
				'<response><reset>false</reset><cursor>c2</cursor>' +
				'<hasMore>true</hasMore><delta><entry>' +
				'<path>/a&amp;b.md</path><size>5</size><isDeleted>false</isDeleted>' +
				'<isDir>false</isDir><modified>2025-01-01T00:00:00Z</modified>' +
				'<revision>3</revision></entry></delta></response>',
		)
		const result = await callGetDelta()
		expect(Array.isArray(result.response.delta.entry)).toBe(true)
		expect(result.response.delta.entry).toHaveLength(1)
		expect(result.response.delta.entry[0]?.path).toBe('/a&b.md')
		expect(result.response.delta.entry[0]?.revision).toBe(3)
	})

	it('keeps an array of <entry> elements', async () => {
		queueXml(
			'<?xml version="1.0" encoding="utf-8"?>' +
				'<response><reset>false</reset><cursor>c3</cursor>' +
				'<hasMore>false</hasMore><delta>' +
				'<entry><path>/a.md</path><revision>1</revision></entry>' +
				'<entry><path>/b.md</path><revision>2</revision></entry>' +
				'</delta></response>',
		)
		const result = await callGetDelta()
		expect(result.response.delta.entry.map((entry) => entry.path)).toEqual([
			'/a.md',
			'/b.md',
		])
	})
})
