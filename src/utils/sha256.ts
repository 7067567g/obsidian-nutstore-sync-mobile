import { fromUint8Array } from 'js-base64'
import { sha256Fallback } from './sha256-fallback'

export async function sha256(data: BufferSource) {
	const subtle = typeof crypto === 'undefined' ? undefined : crypto.subtle
	if (typeof subtle?.digest === 'function') {
		return subtle.digest('SHA-256', data)
	}
	return sha256Fallback(data)
}

export async function sha256Hex(data: BufferSource) {
	const hashBuffer = await sha256(data)
	const hashArray = Array.from(new Uint8Array(hashBuffer))
	const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
	return hashHex
}

export async function sha256Base64(data: BufferSource) {
	const hashBuffer = await sha256(data)
	const hashBase64 = fromUint8Array(new Uint8Array(hashBuffer), false)
	return hashBase64
}
