import {
	Gunzip,
	Inflate,
	deflateSync as fflateDeflateSync,
	gunzipSync as fflateGunzipSync,
	gzipSync as fflateGzipSync,
	inflateSync as fflateInflateSync,
} from 'fflate/browser'

export const constants = {
	Z_BEST_COMPRESSION: 9,
	Z_BEST_SPEED: 1,
	Z_DEFAULT_COMPRESSION: -1,
}

interface CompressionOptions {
	level?: number
}

interface DecompressionOptions {
	maxOutputLength?: number
}

function compressionLevel(level: number | undefined) {
	if (level === undefined || level === constants.Z_DEFAULT_COMPRESSION) {
		return undefined
	}
	if (!Number.isInteger(level) || level < 0 || level > 9) {
		throw new RangeError('The "level" option must be between -1 and 9.')
	}
	return level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
}

function concat(chunks: Uint8Array[], length: number) {
	const output = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		output.set(chunk, offset)
		offset += chunk.length
	}
	return output
}

export function gzipSync(input: Uint8Array, options: CompressionOptions = {}) {
	return fflateGzipSync(input, { level: compressionLevel(options.level) })
}

function assertMaxOutputLength(maxOutputLength: number) {
	if (!Number.isSafeInteger(maxOutputLength) || maxOutputLength < 0) {
		throw new RangeError(
			'The "maxOutputLength" option must be a non-negative integer.',
		)
	}
}

/**
 * Collects decompressed chunks while enforcing `maxOutputLength`. The stream
 * callback throws as soon as the next chunk would exceed the limit, so a
 * decompression bomb is rejected instead of being fully materialized.
 */
function createLimitedCollector(maxOutputLength: number) {
	const chunks: Uint8Array[] = []
	let outputLength = 0
	return {
		onChunk(chunk: Uint8Array) {
			if (outputLength + chunk.length > maxOutputLength) {
				throw new RangeError(
					`Decompressed data exceeds the maximum size of ${maxOutputLength} bytes.`,
				)
			}
			chunks.push(chunk)
			outputLength += chunk.length
		},
		finish: () => concat(chunks, outputLength),
	}
}

export function gunzipSync(
	input: Uint8Array,
	options: DecompressionOptions = {},
) {
	if (options.maxOutputLength === undefined) {
		return fflateGunzipSync(input)
	}

	assertMaxOutputLength(options.maxOutputLength)
	const collector = createLimitedCollector(options.maxOutputLength)
	const gunzip = new Gunzip((chunk) => collector.onChunk(chunk))
	gunzip.push(input, true)
	return collector.finish()
}

export function deflateSync(
	input: Uint8Array,
	options: CompressionOptions = {},
) {
	return fflateDeflateSync(input, { level: compressionLevel(options.level) })
}

export function inflateSync(
	input: Uint8Array,
	options: DecompressionOptions = {},
) {
	if (options.maxOutputLength === undefined) {
		return fflateInflateSync(input)
	}

	assertMaxOutputLength(options.maxOutputLength)
	const collector = createLimitedCollector(options.maxOutputLength)
	const inflate = new Inflate((chunk) => collector.onChunk(chunk))
	inflate.push(input, true)
	return collector.finish()
}
