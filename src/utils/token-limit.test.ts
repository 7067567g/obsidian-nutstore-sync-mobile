import { describe, expect, it } from 'vitest'
import {
	MAX_TOKEN_LIMIT,
	formatTokenLimitInput,
	parseTokenLimitInput,
	tryParseTokenLimitInput,
} from './token-limit'

describe('token limit input', () => {
	it('parses plain numbers and human suffixes', () => {
		expect(parseTokenLimitInput('1000000')).toBe(1_000_000)
		expect(parseTokenLimitInput('1M')).toBe(1_000_000)
		expect(parseTokenLimitInput('1m')).toBe(1_000_000)
		expect(parseTokenLimitInput('256K')).toBe(256_000)
		expect(parseTokenLimitInput('1.5M')).toBe(1_500_000)
		expect(parseTokenLimitInput('1,000,000')).toBe(1_000_000)
		expect(parseTokenLimitInput(' 256 K ')).toBe(256_000)
	})

	it('treats zero as valid and caps excessive values', () => {
		expect(tryParseTokenLimitInput('0')).toBe(0)
		expect(tryParseTokenLimitInput('999999999')).toBe(MAX_TOKEN_LIMIT)
		expect(parseTokenLimitInput('')).toBe(0)
		expect(parseTokenLimitInput('abc')).toBe(0)
	})

	it('formats normalized values for display', () => {
		expect(formatTokenLimitInput(1_000_000)).toBe('1000000')
		expect(formatTokenLimitInput(0)).toBe('0')
	})
})
