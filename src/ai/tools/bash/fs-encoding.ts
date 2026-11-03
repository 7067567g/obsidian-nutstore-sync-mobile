import { fromUint8Array } from 'js-base64'
import type { BufferEncoding, FileContent } from 'just-bash/browser'

export type ReadFileOptions = { encoding?: BufferEncoding | null }
export type WriteFileOptions = { encoding?: BufferEncoding }

function getEncoding(
	options?: ReadFileOptions | WriteFileOptions | BufferEncoding | null,
) {
	if (!options) {
		return 'utf8'
	}
	return typeof options === 'string' ? options : (options.encoding ?? 'utf8')
}

export function decodeContent(
	content: Uint8Array,
	options?: ReadFileOptions | BufferEncoding,
) {
	const encoding = getEncoding(options)
	if (encoding === 'base64') {
		return fromUint8Array(content, false)
	}
	if (encoding === 'hex') {
		return Array.from(content)
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('')
	}
	if (encoding === 'binary' || encoding === 'latin1') {
		const chunkSize = 0x8000
		let result = ''
		for (let i = 0; i < content.length; i += chunkSize) {
			result += String.fromCharCode(
				...content.subarray(i, Math.min(i + chunkSize, content.length)),
			)
		}
		return result
	}
	return new TextDecoder('utf-8').decode(content)
}

export function encodeContent(
	content: FileContent,
	options?: WriteFileOptions | BufferEncoding,
) {
	if (content instanceof Uint8Array) {
		return content
	}

	const encoding = getEncoding(options)
	if (encoding === 'base64') {
		if (typeof Buffer !== 'undefined') {
			return Uint8Array.from(Buffer.from(content, 'base64'))
		}
		const decoded = atob(content)
		return Uint8Array.from(decoded, (char) => char.charCodeAt(0))
	}
	if (encoding === 'hex') {
		const bytes = new Uint8Array(content.length / 2)
		for (let i = 0; i < content.length; i += 2) {
			bytes[i / 2] = Number.parseInt(content.slice(i, i + 2), 16)
		}
		return bytes
	}
	if (encoding === 'binary' || encoding === 'latin1') {
		const bytes = new Uint8Array(content.length)
		for (let i = 0; i < content.length; i++) {
			bytes[i] = content.charCodeAt(i) & 0xff
		}
		return bytes
	}

	return new TextEncoder().encode(content)
}

export function toArrayBuffer(content: Uint8Array) {
	return content.buffer.slice(
		content.byteOffset,
		content.byteOffset + content.byteLength,
	) as ArrayBuffer
}
