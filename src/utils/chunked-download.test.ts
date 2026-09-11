import { afterEach, describe, expect, it, vi } from 'vitest'
import { Platform, type Vault } from 'obsidian'
import type { WebDAVClient } from 'webdav'
import { downloadRemoteFile } from './chunked-download'

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	return copy.buffer
}

class RangeWebdav {
	getFileContentsCalls = 0
	customRequestCalls = 0

	constructor(
		private readonly content: Uint8Array,
		private readonly ignoreRangeAfterFirstChunk = false,
	) {}

	async getFileContents() {
		this.getFileContentsCalls += 1
		return copyArrayBuffer(this.content)
	}

	async customRequest(
		_remotePath: string,
		options: { headers: Record<string, string> },
	) {
		this.customRequestCalls += 1
		const match = /bytes=(\d+)-(\d+)/.exec(options.headers.Range)
		if (!match) throw new Error('missing range')
		const start = Number.parseInt(match[1], 10)
		const end = Number.parseInt(match[2], 10)
		if (this.ignoreRangeAfterFirstChunk && start > 0) {
			return this.response(200, copyArrayBuffer(this.content), null)
		}
		const chunk = this.content.slice(start, end + 1)
		return this.response(
			206,
			chunk.buffer.slice(0),
			`bytes ${start}-${end}/${this.content.byteLength}`,
		)
	}

	private response(
		status: number,
		body: ArrayBuffer,
		contentRange: string | null,
	) {
		return {
			status,
			arrayBuffer: async () => body,
			headers: {
				get: (name: string) =>
					name.toLowerCase() === 'content-range' ? contentRange : null,
			},
		}
	}
}

class MemoryAdapter {
	files = new Map<string, string | ArrayBuffer>()
	dirs = new Set<string>()
	appendBinary?: (path: string, data: ArrayBuffer) => Promise<void>

	constructor(options: { withAppendBinary: boolean }) {
		if (options.withAppendBinary) {
			this.appendBinary = async (path, data) => {
				const current = this.files.get(path)
				if (!(current instanceof ArrayBuffer)) {
					throw new Error(`missing binary temp: ${path}`)
				}
				const merged = new Uint8Array(current.byteLength + data.byteLength)
				merged.set(new Uint8Array(current), 0)
				merged.set(new Uint8Array(data), current.byteLength)
				this.files.set(path, merged.buffer)
			}
		}
	}

	async exists(path: string) {
		return this.files.has(path) || this.dirs.has(path)
	}

	async mkdir(path: string) {
		this.dirs.add(path)
	}

	async writeBinary(path: string, data: ArrayBuffer) {
		this.files.set(path, data.slice(0))
	}

	async remove(path: string) {
		this.files.delete(path)
		this.dirs.delete(path)
	}

	async rename(from: string, to: string) {
		const content = this.files.get(from)
		if (content === undefined) throw new Error(`missing source: ${from}`)
		this.files.delete(from)
		this.files.set(to, content)
	}
}

function makeVault(adapter: MemoryAdapter) {
	return {
		configDir: '.obsidian',
		adapter,
	} as unknown as Vault
}

const localPath = '.agents/nutstore-sync/downloads/target.bin'

afterEach(() => {
	Platform.isMobileApp = false
})

describe('chunked download', () => {
	it('downloads chunks with 206 responses and atomically replaces the target', async () => {
		Platform.isMobileApp = true
		const content = new Uint8Array(100).map((_, index) => index)
		const adapter = new MemoryAdapter({ withAppendBinary: true })
		const webdav = new RangeWebdav(content) as unknown as WebDAVClient

		await downloadRemoteFile({
			vault: makeVault(adapter),
			webdav,
			remotePath: '/remote/target.bin',
			localPath,
			remoteSize: content.byteLength,
			mobileAppDownloadFileChunkSize: '64 KiB',
		})

		expect(adapter.files.get(localPath)).toBeInstanceOf(ArrayBuffer)
		expect(new Uint8Array(adapter.files.get(localPath) as ArrayBuffer)).toEqual(
			content,
		)
	})

	it('accepts a 200 whole-file response when Range is ignored immediately', async () => {
		Platform.isMobileApp = true
		const content = new Uint8Array(100).map((_, index) => index)
		const adapter = new MemoryAdapter({ withAppendBinary: true })
		const webdav = new RangeWebdav(content)
		webdav.customRequest = async () =>
			({
				status: 200,
				arrayBuffer: async () => content.buffer.slice(0),
				headers: { get: () => null },
			}) as never
		const getFileContents = vi.spyOn(webdav, 'getFileContents')

		await downloadRemoteFile({
			vault: makeVault(adapter),
			webdav: webdav as unknown as WebDAVClient,
			remotePath: '/remote/target.bin',
			localPath,
			remoteSize: content.byteLength,
			mobileAppDownloadFileChunkSize: '64 KiB',
		})

		expect(getFileContents).not.toHaveBeenCalled()
		expect(new Uint8Array(adapter.files.get(localPath) as ArrayBuffer)).toEqual(
			content,
		)
	})

	it('falls back to whole-file download when Range is ignored after the first chunk', async () => {
		Platform.isMobileApp = true
		const content = new Uint8Array(70_000).map((_, index) => index % 256)
		const adapter = new MemoryAdapter({ withAppendBinary: true })
		const webdav = new RangeWebdav(content, true) as unknown as WebDAVClient

		await downloadRemoteFile({
			vault: makeVault(adapter),
			webdav,
			remotePath: '/remote/target.bin',
			localPath,
			remoteSize: content.byteLength,
			mobileAppDownloadFileChunkSize: '64 KiB',
		})

		expect((webdav as unknown as RangeWebdav).getFileContentsCalls).toBe(1)
		expect(new Uint8Array(adapter.files.get(localPath) as ArrayBuffer)).toEqual(
			content,
		)
	})

	it('falls back to whole-file download when appendBinary is unavailable', async () => {
		Platform.isMobileApp = true
		const content = new Uint8Array(100).map((_, index) => index)
		const adapter = new MemoryAdapter({ withAppendBinary: false })
		const webdav = new RangeWebdav(content) as unknown as WebDAVClient

		await downloadRemoteFile({
			vault: makeVault(adapter),
			webdav,
			remotePath: '/remote/target.bin',
			localPath,
			remoteSize: content.byteLength,
			mobileAppDownloadFileChunkSize: '64 KiB',
		})

		expect((webdav as unknown as RangeWebdav).customRequestCalls).toBe(0)
		expect((webdav as unknown as RangeWebdav).getFileContentsCalls).toBe(1)
		expect(new Uint8Array(adapter.files.get(localPath) as ArrayBuffer)).toEqual(
			content,
		)
	})

	it('rejects an unexpected Range status with an explicit error', async () => {
		Platform.isMobileApp = true
		const content = new Uint8Array(100)
		const adapter = new MemoryAdapter({ withAppendBinary: true })
		const webdav = new RangeWebdav(content)
		webdav.customRequest = async () =>
			({
				status: 416,
				arrayBuffer: async () => new ArrayBuffer(0),
				headers: { get: () => null },
			}) as never

		await expect(
			downloadRemoteFile({
				vault: makeVault(adapter),
				webdav: webdav as unknown as WebDAVClient,
				remotePath: '/remote/target.bin',
				localPath,
				remoteSize: content.byteLength,
				mobileAppDownloadFileChunkSize: '64 KiB',
			}),
		).rejects.toThrow('Range download failed with status 416')
	})
})
