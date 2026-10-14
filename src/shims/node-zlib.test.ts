import { describe, expect, it } from 'vitest'
import {
	constants,
	deflateSync,
	gunzipSync,
	gzipSync,
	inflateSync,
} from './node-zlib'

function bytes(text: string) {
	return new TextEncoder().encode(text)
}

describe('node:zlib shim', () => {
	it('round-trips gzip and deflate payloads', () => {
		const input = bytes('hello 世界 hello 世界')
		expect(new TextDecoder().decode(gunzipSync(gzipSync(input)))).toBe(
			'hello 世界 hello 世界',
		)
		expect(new TextDecoder().decode(inflateSync(deflateSync(input)))).toBe(
			'hello 世界 hello 世界',
		)
	})

	it('honours an explicit compression level', () => {
		const input = bytes('a'.repeat(4096))
		const best = gzipSync(input, { level: constants.Z_BEST_COMPRESSION })
		const speed = gzipSync(input, { level: constants.Z_BEST_SPEED })
		expect(best.length).toBeLessThanOrEqual(speed.length)
		expect(new TextDecoder().decode(gunzipSync(best))).toBe('a'.repeat(4096))
	})

	it('rejects out-of-range compression levels', () => {
		expect(() => gzipSync(bytes('x'), { level: 10 })).toThrow(RangeError)
		expect(() => gzipSync(bytes('x'), { level: -2 })).toThrow(RangeError)
	})

	it('enforces maxOutputLength when gunzipping', () => {
		const payload = 'a'.repeat(4096)
		const compressed = gzipSync(bytes(payload))
		expect(() => gunzipSync(compressed, { maxOutputLength: 10 })).toThrow(
			RangeError,
		)
		expect(
			new TextDecoder().decode(
				gunzipSync(compressed, { maxOutputLength: 4096 }),
			),
		).toBe(payload)
	})

	it('rejects an invalid maxOutputLength', () => {
		const compressed = gzipSync(bytes('x'))
		expect(() => gunzipSync(compressed, { maxOutputLength: -1 })).toThrow(
			RangeError,
		)
		expect(() => gunzipSync(compressed, { maxOutputLength: 1.5 })).toThrow(
			RangeError,
		)
	})
})
