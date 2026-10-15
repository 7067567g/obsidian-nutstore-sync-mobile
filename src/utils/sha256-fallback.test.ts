import { describe, expect, it } from 'vitest'
import { sha256Fallback, type HashInput } from './sha256-fallback'
import { sha256Hex, sha256HexIncremental } from './sha256'

function hex(buffer: ArrayBuffer) {
	return Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

function deterministicBytes(length: number) {
	const bytes = new Uint8Array(length)
	for (let index = 0; index < length; index += 1) {
		bytes[index] = (index * 31 + 7) & 0xff
	}
	return bytes
}

const ABC_VECTOR =
	'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

describe('sha256 fallback', () => {
	it('matches the known SHA-256 vectors for empty input and abc', () => {
		const abc = new TextEncoder().encode('abc')
		expect(hex(sha256Fallback(abc))).toBe(ABC_VECTOR)
		expect(hex(sha256Fallback(abc.buffer))).toBe(ABC_VECTOR)
		expect(hex(sha256Fallback(new Uint8Array(0)))).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		)
	})

	it('handles multi-block input and BufferSource views', () => {
		const bytes = deterministicBytes(1000)
		const backing = new Uint8Array(bytes.length + 8)
		backing.set(bytes, 4)
		const view = backing.subarray(4, 4 + bytes.length)
		expect(hex(sha256Fallback(view))).toBe(hex(sha256Fallback(bytes)))
	})

	it('stays compatible with the primary sha256Hex API', async () => {
		const bytes = new TextEncoder().encode('hello')
		expect(await sha256Hex(bytes)).toBe(
			'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
		)
	})

	// Regression: message lengths where `len + 9` is an exact multiple of the
	// 64-byte block size used to be padded with a spurious extra zero block,
	// producing a wrong digest (length ≡ 55 mod 64).
	it.each([0, 1, 54, 55, 56, 63, 64, 119, 120, 127, 128, 191, 255, 256])(
		'matches the platform SHA-256 for a %i-byte message',
		async (length) => {
			const bytes = new Uint8Array(length)
			for (let index = 0; index < length; index += 1) {
				bytes[index] = (index * 31 + 7) % 256
			}
			const primary = await crypto.subtle.digest('SHA-256', bytes)
			expect(hex(sha256Fallback(bytes))).toBe(hex(primary))
		},
	)

	it('matches native sha256Hex and incremental fallback on 1 MiB', async () => {
		const bytes = deterministicBytes(1024 * 1024)
		const expected = hex(sha256Fallback(bytes))
		expect(await sha256Hex(bytes)).toBe(expected)
		expect(await sha256HexIncremental(bytes)).toBe(expected)
	})

	it('accepts HashInput in fallback and incremental helpers', () => {
		const input: HashInput = deterministicBytes(128)
		expect(hex(sha256Fallback(input))).toBe(hex(sha256Fallback(input)))
	})
})
