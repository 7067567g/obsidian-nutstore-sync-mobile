import { normalizePath, Platform, Vault } from 'obsidian'
import { dirname } from 'path-browserify'
import type { BufferLike, WebDAVClient } from 'webdav'
import { atomicReplaceContent, atomicReplaceFromTemp } from './atomic-replace'
import { parseMobileAppDownloadFileChunkSize } from './download-chunk-size'
import logger from './logger'
import { mkdirsVault } from './mkdirs-vault'

export interface DownloadRemoteFileOptions {
	vault: Vault
	webdav: WebDAVClient
	remotePath: string
	localPath: string
	remoteSize: number
	mobileAppDownloadFileChunkSize?: string
}

interface RangeResponse {
	status: number
	arrayBuffer(): Promise<ArrayBuffer>
	headers?: { get(name: string): string | null }
}

class RangeFallbackWholeDownloadError extends Error {}

export async function downloadRemoteFile(options: DownloadRemoteFileOptions) {
	if (!Platform.isMobileApp) {
		await downloadRemoteFileWhole(options)
		return
	}
	await downloadRemoteFileInChunks(options)
}

export function bufferLikeToArrayBuffer(buffer: BufferLike): ArrayBuffer {
	if (buffer instanceof ArrayBuffer) {
		return buffer
	}
	return toArrayBuffer(buffer)
}

function validateContentRange(
	response: RangeResponse,
	offset: number,
	expectedTotal: number,
) {
	let contentRange: string | null
	try {
		contentRange = response.headers?.get?.('content-range') ?? null
	} catch {
		contentRange = null
	}
	if (!contentRange) return
	const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange.trim())
	if (!match) return
	const start = Number.parseInt(match[1], 10)
	const total = match[3] === '*' ? undefined : Number.parseInt(match[3], 10)
	if (start !== offset) {
		throw new Error(
			`Range response starts at ${start}, expected offset ${offset}`,
		)
	}
	if (total !== undefined && total !== expectedTotal) {
		throw new Error(
			`Range response total ${total} does not match remote size ${expectedTotal}`,
		)
	}
}

async function downloadRemoteFileWhole({
	vault,
	webdav,
	remotePath,
	localPath,
	remoteSize,
}: DownloadRemoteFileOptions) {
	const file = (await webdav.getFileContents(remotePath, {
		format: 'binary',
		details: false,
	})) as BufferLike
	const arrayBuffer = bufferLikeToArrayBuffer(file)
	if (arrayBuffer.byteLength !== remoteSize) {
		throw new Error('Remote Size Not Match!')
	}
	await atomicReplaceContent(vault, localPath, arrayBuffer, 'binary')
}

async function downloadRemoteFileInChunks({
	vault,
	webdav,
	remotePath,
	localPath,
	remoteSize,
	mobileAppDownloadFileChunkSize,
}: DownloadRemoteFileOptions) {
	const normalizedLocalPath = normalizePath(localPath)
	await mkdirsVault(vault, dirname(normalizedLocalPath))

	if (remoteSize === 0) {
		await atomicReplaceContent(
			vault,
			normalizedLocalPath,
			new ArrayBuffer(0),
			'binary',
		)
		return
	}

	const adapter = vault.adapter as unknown as {
		appendBinary?: (path: string, data: ArrayBuffer) => Promise<void>
	}
	const appendBinary =
		typeof adapter.appendBinary === 'function'
			? adapter.appendBinary.bind(adapter)
			: undefined

	if (!appendBinary) {
		// Never accumulate chunks in memory: on older adapters fall back to a
		// single whole-file request with an explicit diagnostic.
		logger.warn(
			'[ChunkedDownload] adapter.appendBinary is unavailable; falling back to whole-file download instead of in-memory concatenation',
		)
		await downloadRemoteFileWhole({
			vault,
			webdav,
			remotePath,
			localPath,
			remoteSize,
			mobileAppDownloadFileChunkSize,
		})
		return
	}

	const chunkSize = parseMobileAppDownloadFileChunkSize(
		mobileAppDownloadFileChunkSize,
	)
	const tempPath = normalizePath(
		`${normalizedLocalPath}.nutstore-sync-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2)}.download`,
	)
	let offset = 0
	let chunkIndex = 0

	logger.info(
		`[ChunkedDownload] start ${remotePath} (${remoteSize} bytes, chunkSize=${chunkSize})`,
	)

	try {
		while (offset < remoteSize) {
			const end = Math.min(offset + chunkSize, remoteSize) - 1
			const response = (await webdav.customRequest(remotePath, {
				method: 'GET',
				headers: {
					Range: `bytes=${offset}-${end}`,
				},
			})) as unknown as RangeResponse

			if (response.status === 206) {
				validateContentRange(response, offset, remoteSize)
				const chunk = await response.arrayBuffer()
				const expectedLength = end - offset + 1
				if (chunk.byteLength !== expectedLength) {
					throw new Error(
						`Remote chunk size not match: got ${chunk.byteLength}, expected ${expectedLength}`,
					)
				}
				if (offset === 0) {
					await vault.adapter.writeBinary(tempPath, chunk)
				} else {
					await appendBinary(tempPath, chunk)
				}
				offset += chunk.byteLength
				chunkIndex++
				if (chunkIndex % 5 === 0) {
					logger.debug(
						`[ChunkedDownload] progress ${offset}/${remoteSize} bytes (chunk #${chunkIndex})`,
					)
				}
				continue
			}

			if (response.status === 200) {
				if (offset > 0) {
					// A proxy/server ignored Range after we already wrote chunks.
					// Discard the partial temp file and explicitly fall back to a
					// whole-file request instead of appending a full body.
					throw new RangeFallbackWholeDownloadError(
						'Range request was ignored after the first chunk',
					)
				}
				const whole = await response.arrayBuffer()
				if (whole.byteLength !== remoteSize) {
					throw new Error('Remote Size Not Match!')
				}
				await atomicReplaceContent(vault, normalizedLocalPath, whole, 'binary')
				logger.info('[ChunkedDownload] server ignored Range; stored whole file')
				return
			}

			throw new Error(`Range download failed with status ${response.status}`)
		}

		if (offset !== remoteSize) {
			throw new Error('Remote Size Not Match!')
		}
		await atomicReplaceFromTemp(vault, tempPath, normalizedLocalPath)
		logger.info(`[ChunkedDownload] done ${remotePath} (${chunkIndex} chunks)`)
	} catch (error) {
		await removeTempDownload(vault, tempPath)
		if (error instanceof RangeFallbackWholeDownloadError) {
			logger.warn(
				'[ChunkedDownload] Range was ignored after the first chunk; falling back to whole-file download',
			)
			await downloadRemoteFileWhole({
				vault,
				webdav,
				remotePath,
				localPath,
				remoteSize,
				mobileAppDownloadFileChunkSize,
			})
			return
		}
		throw error
	}
}

async function removeTempDownload(vault: Vault, tempPath: string) {
	try {
		if (await vault.adapter.exists(tempPath)) {
			await vault.adapter.remove(tempPath)
		}
	} catch {
		// Best-effort cleanup only; preserve the original download error.
	}
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
	if (buf.buffer instanceof SharedArrayBuffer) {
		const copy = new ArrayBuffer(buf.byteLength)
		new Uint8Array(copy).set(buf)
		return copy
	}
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}
