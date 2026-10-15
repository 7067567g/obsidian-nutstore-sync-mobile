import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { fromUint8Array } from 'js-base64'
import { sha256Fallback, type HashInput } from './sha256-fallback'

/** Size above which the WebCrypto digest is preferred over the JS fallback. */
export const NATIVE_SHA256_THRESHOLD_BYTES = 256 * 1024

/** Chunk size used by the incremental noble fallback; yields between chunks. */
export const INCREMENTAL_SHA256_CHUNK_BYTES = 64 * 1024

function toBytes(data: HashInput): Uint8Array {
	if (data instanceof ArrayBuffer) return new Uint8Array(data)
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

function toHex(hashBuffer: ArrayBuffer) {
	const hashArray = Array.from(new Uint8Array(hashBuffer))
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

function subtleSha256(data: HashInput) {
	const subtle = typeof crypto === 'undefined' ? undefined : crypto.subtle
	if (typeof subtle?.digest !== 'function') return undefined
	return subtle.digest('SHA-256', data as BufferSource)
}

export async function sha256(data: HashInput) {
	const digest = subtleSha256(data)
	if (digest) return digest
	return sha256Fallback(data)
}

export async function sha256HexIncremental(data: HashInput) {
	const bytes = toBytes(data)
	const hasher = nobleSha256.create()
	let processed = 0
	for (
		let offset = 0;
		offset < bytes.length;
		offset += INCREMENTAL_SHA256_CHUNK_BYTES
	) {
		hasher.update(
			bytes.subarray(
				offset,
				Math.min(offset + INCREMENTAL_SHA256_CHUNK_BYTES, bytes.length),
			),
		)
		processed += INCREMENTAL_SHA256_CHUNK_BYTES
		if (processed % (INCREMENTAL_SHA256_CHUNK_BYTES * 16) === 0) {
			await new Promise<void>((resolve) => {
				window.setTimeout(resolve, 0)
			})
		}
	}
	return toHex(hasher.digest().buffer)
}

async function sha256HexBuffer(data: HashInput) {
	const bytes = toBytes(data)
	const digest = subtleSha256(bytes)
	if (bytes.byteLength >= NATIVE_SHA256_THRESHOLD_BYTES && digest) {
		return toHex(await digest)
	}
	if (bytes.byteLength >= NATIVE_SHA256_THRESHOLD_BYTES) {
		return sha256HexIncremental(bytes)
	}
	return toHex(sha256Fallback(bytes))
}

export async function sha256Hex(data: HashInput) {
	return sha256HexBuffer(data)
}

export async function sha256Base64(data: HashInput) {
	const hashBuffer = await sha256(data)
	const hashBase64 = fromUint8Array(new Uint8Array(hashBuffer), false)
	return hashBase64
}
