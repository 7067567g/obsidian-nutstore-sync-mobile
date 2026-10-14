import { describe, expect, it } from 'vitest'
import { sha256Hex } from './sha256'
import { sha256Fallback } from './sha256-fallback'

function hex(buffer: ArrayBuffer) {
	return Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

describe('sha256 fallback', () => {
	it('matches the known SHA-256 vector for abc', () => {
		const bytes = new TextEncoder().encode('abc')
		expect(hex(sha256Fallback(bytes))).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		)
		expect(hex(sha256Fallback(bytes.buffer))).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		)
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
})
