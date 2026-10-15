import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'

export type HashInput = ArrayBuffer | ArrayBufferView

function toBytes(data: HashInput): Uint8Array {
	if (data instanceof ArrayBuffer) return new Uint8Array(data)
	return new Uint8Array(
		data.buffer as ArrayBuffer,
		data.byteOffset,
		data.byteLength,
	)
}

export function sha256Fallback(data: HashInput): ArrayBuffer {
	const digest = nobleSha256(toBytes(data))
	return new Uint8Array(digest).buffer
}
