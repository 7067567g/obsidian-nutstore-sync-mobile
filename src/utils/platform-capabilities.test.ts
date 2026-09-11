import { describe, expect, it } from 'vitest'
import { detectPlatformCapabilities } from './platform-capabilities'

describe('platform capabilities', () => {
	it('reports adapter append capabilities without throwing', () => {
		const report = detectPlatformCapabilities({
			adapter: {
				append: () => Promise.resolve(),
				appendBinary: undefined,
			},
		})
		expect(report.adapterAppend).toBe(true)
		expect(report.adapterAppendBinary).toBe(false)
		expect(report.requestUrl).toBe(true)
	})
})
