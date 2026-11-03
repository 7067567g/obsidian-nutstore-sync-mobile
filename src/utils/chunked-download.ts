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
	/** Extra attempts per chunk after the first one (default 3). */
	chunkRetryCount?: number
	/** Base delay for exponential chunk backoff in ms (default 250). */
	chunkRetryBaseDelayMs?: number
}

interface RangeResponse {
	status: number
	arrayBuffer(): Promise<ArrayBuffer>
	headers?: { get(name: string): string | null }
}

class RangeFallbackWholeDownloadError extends Error {}

const DEFAULT_CHUNK_RETRY_COUNT = 3
const DEFAULT_CHUNK_RETRY_BASE_DELAY_MS = 250

/**
 * Deterministic sibling temp path used for resumable chunked downloads. A
 * stable name (instead of a timestamped one) is what lets a later attempt pick
 * up the bytes a previous interrupted attempt left behind.
 */
export function getChunkedDownloadTempPath(localPath: string) {
	return normalizePath(
		`${normalizePath(localPath)}.nutstore-sync-resume.download`,
	)
}

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

function sleep(ms: number) {
	return new Promise<void>((resolve) => {
		window.setTimeout(resolve, ms)
	})
}

async function adapterExists(vault: Vault, path: string) {
	try {
		return await vault.adapter.exists(path)
	} catch {
		return false
	}
}

async function adapterFileSize(vault: Vault, path: string): Promise<number> {
	const stat = (
		vault.adapter as unknown as {
			stat?: (path: string) => Promise<{ size: number } | null>
		}
	).stat
	if (typeof stat !== 'function') return 0
	try {
		const stats = await stat.call(vault.adapter, path)
		return stats?.size ?? 0
	} catch {
		return 0
	}
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

interface RangeFetchResult {
	status: number
	body: ArrayBuffer | null
}

/**
 * Fetch one range request with exponential backoff. Network errors (thrown by
 * the request or by reading the body) are retried; non-206 statuses are
 * returned to the caller without retry so it can decide between the whole-file
 * fallback and a hard error. `readWholeBody` mirrors the old behaviour of only
 * draining a status-200 body when no chunk was written yet.
 */
async function fetchRangeWithRetry(
	webdav: WebDAVClient,
	remotePath: string,
	offset: number,
	end: number,
	remoteSize: number,
	retryCount: number,
	baseDelayMs: number,
	readWholeBody: boolean,
): Promise<RangeFetchResult> {
	const attempts = Math.max(0, retryCount) + 1
	let lastError: unknown
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			const response = (await webdav.customRequest(remotePath, {
				method: 'GET',
				headers: {
					Range: `bytes=${offset}-${end}`,
				},
			})) as unknown as RangeResponse

			if (response.status === 206) {
				validateContentRange(response, offset, remoteSize)
				return { status: 206, body: await response.arrayBuffer() }
			}
			if (response.status === 200 && readWholeBody) {
				return { status: 200, body: await response.arrayBuffer() }
			}
			return { status: response.status, body: null }
		} catch (error) {
			lastError = error
			if (attempt < attempts - 1) {
				await sleep(baseDelayMs * 2 ** attempt)
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError))
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
	chunkRetryCount = DEFAULT_CHUNK_RETRY_COUNT,
	chunkRetryBaseDelayMs = DEFAULT_CHUNK_RETRY_BASE_DELAY_MS,
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
	const tempPath = getChunkedDownloadTempPath(normalizedLocalPath)
	let offset = 0
	let chunkIndex = 0

	// Resume from a temp file kept by an interrupted earlier attempt.
	if (await adapterExists(vault, tempPath)) {
		const existingSize = await adapterFileSize(vault, tempPath)
		if (existingSize > remoteSize) {
			await removeTempDownload(vault, tempPath)
		} else {
			offset = existingSize
		}
	}
	if (offset === remoteSize) {
		await atomicReplaceFromTemp(vault, tempPath, normalizedLocalPath)
		logger.info(`[ChunkedDownload] resumed complete ${remotePath}`)
		return
	}

	logger.info(
		`[ChunkedDownload] start ${remotePath} (${remoteSize} bytes, chunkSize=${chunkSize}, resumeAt=${offset})`,
	)

	try {
		while (offset < remoteSize) {
			const end = Math.min(offset + chunkSize, remoteSize) - 1
			const { status, body } = await fetchRangeWithRetry(
				webdav,
				remotePath,
				offset,
				end,
				remoteSize,
				chunkRetryCount,
				chunkRetryBaseDelayMs,
				offset === 0,
			)

			if (status === 206 && body) {
				const expectedLength = end - offset + 1
				if (body.byteLength !== expectedLength) {
					throw new Error(
						`Remote chunk size not match: got ${body.byteLength}, expected ${expectedLength}`,
					)
				}
				if (offset === 0) {
					await vault.adapter.writeBinary(tempPath, body)
				} else {
					await appendBinary(tempPath, body)
				}
				offset += body.byteLength
				chunkIndex++
				if (chunkIndex % 5 === 0) {
					logger.debug(
						`[ChunkedDownload] progress ${offset}/${remoteSize} bytes (chunk #${chunkIndex})`,
					)
				}
				continue
			}

			if (status === 200) {
				if (offset > 0) {
					// A proxy/server ignored Range after we already wrote chunks.
					// Discard the partial temp file and explicitly fall back to a
					// whole-file request instead of appending a full body.
					throw new RangeFallbackWholeDownloadError(
						'Range request was ignored after the first chunk',
					)
				}
				if (!body || body.byteLength !== remoteSize) {
					throw new Error('Remote Size Not Match!')
				}
				await atomicReplaceContent(vault, normalizedLocalPath, body, 'binary')
				logger.info('[ChunkedDownload] server ignored Range; stored whole file')
				return
			}

			throw new Error(`Range download failed with status ${status}`)
		}

		if (offset !== remoteSize) {
			throw new Error('Remote Size Not Match!')
		}
		await atomicReplaceFromTemp(vault, tempPath, normalizedLocalPath)
		logger.info(`[ChunkedDownload] done ${remotePath} (${chunkIndex} chunks)`)
	} catch (error) {
		if (error instanceof RangeFallbackWholeDownloadError) {
			await removeTempDownload(vault, tempPath)
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
		// Keep the partial temp so the next attempt can resume instead of
		// re-downloading the whole file.
		logger.warn(
			`[ChunkedDownload] interrupted ${remotePath} at ${offset}/${remoteSize} bytes; keeping temp for resume`,
		)
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
