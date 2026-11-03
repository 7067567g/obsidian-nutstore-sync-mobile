import { describe, expect, it } from 'vitest'
import { fromUint8Array } from 'js-base64'
import {
	createCompressedFileContent,
	createSkippedFileSnapshot,
	decodeReversibleFileSnapshot,
	hasCompressedFileContent,
	isSkippedFileSnapshot,
} from './reversible-content'

describe('reversible snapshot skipping', () => {
	it('marks an oversized snapshot as skipped and refuses to decode it', async () => {
		const snapshot = createSkippedFileSnapshot(10 * 1024 * 1024, 'too-large')
		expect(isSkippedFileSnapshot(snapshot)).toBe(true)
		expect(snapshot.skipped).toEqual({
			size: 10 * 1024 * 1024,
			reason: 'too-large',
		})
		expect(hasCompressedFileContent(snapshot)).toBe(false)
		await expect(decodeReversibleFileSnapshot(snapshot)).rejects.toThrow(
			'snapshot content was not retained',
		)
	})
})

describe('reversible compressed content (I-06 coverage gap)', () => {
	it('round-trips compressed text content', async () => {
		const snapshot = {
			kind: 'file' as const,
			contentCompressed: createCompressedFileContent('hello \u4e2d\u6587'),
		}
		expect(hasCompressedFileContent(snapshot)).toBe(true)
		const decoded = await decodeReversibleFileSnapshot(snapshot)
		expect(new TextDecoder().decode(new Uint8Array(decoded))).toBe(
			'hello \u4e2d\u6587',
		)
	})

	it('decodes legacy base64 content snapshots', async () => {
		const bytes = new TextEncoder().encode('legacy')
		const snapshot = {
			kind: 'file' as const,
			contentBase64: fromUint8Array(bytes),
		}
		expect(hasCompressedFileContent(snapshot)).toBe(false)
		const decoded = await decodeReversibleFileSnapshot(snapshot)
		expect(new TextDecoder().decode(new Uint8Array(decoded))).toBe('legacy')
	})

	it('decodes blob-like compressed content from another realm', async () => {
		const source = createCompressedFileContent('跨 realm')
		const bytes = new Uint8Array(await source.blob.arrayBuffer())
		const crossRealm: Record<string, unknown> = {
			size: bytes.byteLength,
			type: 'application/octet-stream',
			arrayBuffer: async () =>
				bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength,
				),
			slice: () => crossRealm,
		}
		const snapshot = {
			kind: 'file' as const,
			contentCompressed: { ...source, blob: crossRealm },
		} as never

		expect(hasCompressedFileContent(snapshot)).toBe(true)
		const decoded = await decodeReversibleFileSnapshot(snapshot)
		expect(new TextDecoder().decode(new Uint8Array(decoded))).toBe('跨 realm')
	})

	it('fails loudly when deflate content does not carry a usable blob', async () => {
		const snapshot = {
			kind: 'file' as const,
			contentCompressed: { compress: 'deflate' as const, blob: { bad: true } },
		} as never

		expect(hasCompressedFileContent(snapshot)).toBe(false)
		await expect(decodeReversibleFileSnapshot(snapshot)).rejects.toThrow(
			'refusing to decode as base64',
		)
	})

	it('decodes binary content without round-tripping through text', async () => {
		const snapshot = {
			kind: 'file' as const,
			contentBase64: fromUint8Array(new Uint8Array([0, 255, 1, 254])),
		}
		const decoded = new Uint8Array(await decodeReversibleFileSnapshot(snapshot))
		expect(Array.from(decoded)).toEqual([0, 255, 1, 254])
	})
})
