import { deflateSync as deflate, inflateSync as inflate } from 'fflate/browser'
import { toUint8Array } from 'js-base64'
import type {
	ReversibleCompressedContent,
	ReversibleFileSnapshot,
	ReversibleSkippedSnapshot,
} from '~/ai/chat/types'

function toArrayBuffer(content: Uint8Array) {
	return content.buffer.slice(
		content.byteOffset,
		content.byteOffset + content.byteLength,
	) as ArrayBuffer
}

export function createCompressedFileContent(
	content: ArrayBuffer | Uint8Array | string,
): ReversibleCompressedContent {
	const bytes =
		typeof content === 'string'
			? new TextEncoder().encode(content)
			: content instanceof Uint8Array
				? content
				: new Uint8Array(content)
	const compressed = deflate(bytes, { level: 9 })
	return {
		compress: 'deflate',
		blob: new Blob([toArrayBuffer(compressed)], {
			type: 'application/octet-stream',
		}),
	}
}

export function createSkippedFileSnapshot(
	size: number,
	reason: ReversibleSkippedSnapshot['reason'],
): ReversibleFileSnapshot {
	return {
		kind: 'file',
		skipped: { size, reason },
	}
}

export function isSkippedFileSnapshot(
	content: ReversibleFileSnapshot,
): content is ReversibleFileSnapshot & {
	skipped: ReversibleSkippedSnapshot
} {
	return content.skipped !== undefined
}

function isBlobLike(value: unknown): value is Blob {
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as Blob).arrayBuffer === 'function' &&
		typeof (value as Blob).slice === 'function' &&
		typeof (value as Blob).size === 'number'
	)
}

export function hasCompressedFileContent(
	content: ReversibleFileSnapshot,
): content is ReversibleFileSnapshot & {
	contentCompressed: ReversibleCompressedContent
} {
	return (
		content.contentCompressed?.compress === 'deflate' &&
		isBlobLike(content.contentCompressed.blob)
	)
}

export async function decodeReversibleFileSnapshot(
	content: ReversibleFileSnapshot,
) {
	if (isSkippedFileSnapshot(content)) {
		throw new Error(
			`Reversible snapshot content was not retained (${content.skipped.size} bytes, ${content.skipped.reason})`,
		)
	}
	if (
		content.contentCompressed?.compress === 'deflate' &&
		!isBlobLike(content.contentCompressed.blob)
	) {
		throw new Error(
			'Reversible snapshot declares deflate compression but does not carry a Blob; refusing to decode as base64',
		)
	}
	if (hasCompressedFileContent(content)) {
		const compressed = await content.contentCompressed.blob.arrayBuffer()
		const inflated = inflate(new Uint8Array(compressed))
		return toArrayBuffer(inflated)
	}
	const bytes = toUint8Array(content.contentBase64 || '')
	return toArrayBuffer(bytes)
}
