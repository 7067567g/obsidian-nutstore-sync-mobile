import { normalizePath, Vault } from 'obsidian'
import { perfMetrics, perfNow } from '~/diagnostics/perf-metrics'
import type { ChatSession } from '~/ai/chat/domain'
import type { PersistedChatSession } from '~/ai/chat/session/session-persistence'
import {
	DEFAULT_MAX_INLINE_OPERATION_BYTES,
	externalizeSessionOperations,
	getOperationDirectoryPath,
	hydrateSessionOperations,
	isSafeOperationRefPath,
	type OperationFile,
} from '~/ai/chat/session/session-operations'
import { SessionLogBackend } from './session-log-backend'
import {
	runOpsGc,
	type OpsGcFile,
	type OpsGcOptions,
	type OpsGcReport,
} from './ops-gc'
import type { JsonRecord } from './session-log-format'
import {
	readLocalText,
	removeLocalPath,
	writeLocalTextAtomic,
} from '~/utils/local-vault-io'

/**
 * Chat sessions are persisted as individual JSON files inside the vault (next
 * to the other plugin-managed agent config), so they are grep-able, cross-device
 * syncable via the existing sync module, and resilient to meta/index loss.
 *
 * Layout:
 *   .agents/nutstore-sync/
 *     chat-meta.json          # lightweight index: order + active + cached titles
 *     sessions/<id>.json      # one whole ChatSession snapshot per file
 *     ops/<id>/<ref>.json     # oversized reversible-operation sidecars
 *
 * The title is embedded in EACH session file as well as cached in chat-meta.json
 * so a deleted or corrupted meta file never destroys the session titles.
 */
export const CHAT_ROOT_DIR = '.agents/nutstore-sync'
export const CHAT_SESSIONS_DIR = `${CHAT_ROOT_DIR}/sessions`
export const CHAT_META_FILENAME = 'chat-meta.json'

export interface ChatSessionFilePayload {
	/** Whole session snapshot (blobs already base64url-encoded). */
	session: PersistedChatSession
	/** Human title stored alongside the snapshot; source of truth per file. */
	title?: string
}

export interface SessionsFileBackendOptions {
	/**
	 * Operation arrays larger than this serialized size are moved to a
	 * sidecar file instead of being rewritten with the main session snapshot.
	 * A getter keeps the limit live when the user changes settings.
	 */
	maxInlineOperationBytes?: number | (() => number | undefined)
	/** Use the legacy whole-file JSON format. Defaults to the JSONL backend. */
	useLegacyBackend?: boolean
	/** Append log size threshold before compaction into a segment snapshot. */
	sessionLogCompactionBytes?: number
}

export interface ReadSessionFileOptions {
	/** Skip sidecar hydration when only index metadata is needed. */
	hydrateOperations?: boolean
}

export interface ChatMetaSessionInfo {
	title: string
	createdAt: number
	updatedAt: number
}

export interface ChatMetaFile {
	activeSessionId?: string
	orderedSessionIds: string[]
	/**
	 * Cached per-session index data so the list renders without loading files.
	 * Backed up by the embedded title inside each session file, so a lost or
	 * corrupted meta file can always be rebuilt from the session files.
	 */
	sessions: Record<string, ChatMetaSessionInfo>
}

export class SessionFileCorruptError extends Error {
	constructor(public readonly filePath: string) {
		super(`Corrupted chat session file: ${filePath}`)
		this.name = 'SessionFileCorruptError'
	}
}

export function getChatSessionPath(id: string) {
	return normalizePath(`${CHAT_SESSIONS_DIR}/${id}.json`)
}

export function getChatMetaPath() {
	return normalizePath(`${CHAT_ROOT_DIR}/${CHAT_META_FILENAME}`)
}

export function isChatMetaFile(value: unknown): value is ChatMetaFile {
	return (
		!!value &&
		typeof value === 'object' &&
		Array.isArray((value as ChatMetaFile).orderedSessionIds) &&
		typeof (value as ChatMetaFile).sessions === 'object' &&
		(value as ChatMetaFile).sessions !== null
	)
}

function stringifyJsonFile(value: unknown) {
	// Compact JSON keeps mobile writes/parses proportional to the payload;
	// pretty-printing roughly doubles both size and string-building work.
	return `${JSON.stringify(value)}\n`
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
	if (left.size !== right.size) return false
	for (const value of left) {
		if (!right.has(value)) return false
	}
	return true
}

export class SessionsFileBackend {
	private readonly operationHashes = new Map<string, string>()
	private readonly operationFiles = new Map<string, Set<string>>()
	private readonly ensuredDirectories = new Set<string>()
	private readonly logBackend: SessionLogBackend | null

	constructor(
		private vault: Vault,
		private options: SessionsFileBackendOptions = {},
	) {
		this.logBackend = options.useLegacyBackend
			? null
			: new SessionLogBackend(vault, {
					sessionsDir: CHAT_SESSIONS_DIR,
					compactionBytes: options.sessionLogCompactionBytes ?? 512 * 1024,
				})
	}

	private get adapter() {
		return this.vault.adapter
	}

	private get maxInlineOperationBytes() {
		const configured = this.options.maxInlineOperationBytes
		const value = typeof configured === 'function' ? configured() : configured
		return value ?? DEFAULT_MAX_INLINE_OPERATION_BYTES
	}

	private operationPath(relativePath: string) {
		return normalizePath(`${CHAT_ROOT_DIR}/${relativePath}`)
	}

	private getOperationDir(sessionId: string) {
		return this.operationPath(getOperationDirectoryPath(sessionId))
	}
	/**
	 * Seed the in-memory sidecar hash cache from a persisted session snapshot.
	 * This is what lets a cold start skip rewriting every existing sidecar when
	 * the referenced operation arrays are unchanged.
	 */
	private seedOperationHashesFromSession(session: unknown) {
		const refs = (
			session as {
				operationRefs?: Array<{ ref?: { path?: unknown; hash?: unknown } }>
			}
		)?.operationRefs
		if (!Array.isArray(refs)) return
		for (const entry of refs) {
			const path = entry?.ref?.path
			const hash = entry?.ref?.hash
			if (typeof path === 'string' && typeof hash === 'string') {
				this.operationHashes.set(path, hash)
			}
		}
	}

	private async ensureDirectory(path: string) {
		if (this.ensuredDirectories.has(path)) {
			// M-04: a cached directory may have been deleted externally; verify
			// existence before trusting the cache, then rebuild when needed.
			try {
				const stat = await this.adapter.stat(path)
				if (stat?.type === 'folder') return
			} catch {
				/* Recreate below. */
			}
			this.ensuredDirectories.delete(path)
		}
		const segments = path.split('/').filter(Boolean)
		let current = ''
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment
			try {
				perfMetrics.recordBridgeCall('adapter.mkdir')
				await this.adapter.mkdir(current)
			} catch {
				/* directory already exists */
			}
		}
		this.ensuredDirectories.add(path)
	}

	private async ensureSessionsDir() {
		await this.ensureDirectory(CHAT_SESSIONS_DIR)
	}

	private async writeOperationFiles(sessionId: string, files: OperationFile[]) {
		if (files.length > 0) {
			await this.ensureDirectory(this.getOperationDir(sessionId))
		}
		for (const file of files) {
			if (this.operationHashes.get(file.path) === file.hash) continue
			await writeLocalTextAtomic(
				this.vault,
				this.operationPath(file.path),
				file.content,
			)
			this.operationHashes.set(file.path, file.hash)
		}
	}

	private async pruneOperationFiles(
		sessionId: string,
		keep: ReadonlySet<string>,
	) {
		const known = this.operationFiles.get(sessionId)
		if (known && sameStringSet(known, keep)) return
		const dir = this.getOperationDir(sessionId)
		let existing: string[] = []
		try {
			perfMetrics.recordBridgeCall('adapter.list')
			existing = (await this.adapter.list(dir)).files
		} catch {
			/* no sidecars yet */
		}
		for (const filePath of existing) {
			const normalized = normalizePath(filePath)
			const relative = normalized.startsWith(`${CHAT_ROOT_DIR}/`)
				? normalized.slice(CHAT_ROOT_DIR.length + 1)
				: normalized
			if (keep.has(relative)) continue
			await removeLocalPath(this.vault, normalized)
			this.operationHashes.delete(relative)
		}
		this.operationFiles.set(sessionId, new Set(keep))
	}

	async writeSessionFile(
		id: string,
		payload: ChatSessionFilePayload,
		sourceSession?: ChatSession,
	) {
		const startedAt = perfNow()
		try {
			const { files } = externalizeSessionOperations(payload.session, {
				sessionId: id,
				maxInlineBytes: this.maxInlineOperationBytes,
				sourceSession,
			})
			// Sidecars must land before the session file so an interrupted write
			// cannot leave the main snapshot pointing at operations that do not exist.
			await this.writeOperationFiles(id, files)

			if (this.logBackend) {
				const sessionForLog = {
					...(payload.session as unknown as JsonRecord),
					title: payload.title,
				}
				perfMetrics.recordSessionSize(JSON.stringify(sessionForLog).length)
				perfMetrics.recordBridgeCall('session.write.log')
				await this.logBackend.writeSessionFile(id, sessionForLog, sourceSession)
			} else {
				await this.ensureSessionsDir()
				const serialized = stringifyJsonFile(payload)
				perfMetrics.recordSessionSize(serialized.length)
				perfMetrics.recordBridgeCall('session.write')
				await writeLocalTextAtomic(
					this.vault,
					getChatSessionPath(id),
					serialized,
				)
			}
			// Only remove superseded sidecars after the main snapshot references the
			// new ones; a failed session write must leave the previous set intact.
			await this.pruneOperationFiles(
				id,
				new Set(files.map((file) => file.path)),
			)
		} finally {
			perfMetrics.recordPersistenceWrite(perfNow() - startedAt)
		}
	}

	async readSessionFile(
		id: string,
		options: ReadSessionFileOptions = {},
	): Promise<ChatSessionFilePayload> {
		if (this.logBackend && (await this.logBackend.exists(id))) {
			perfMetrics.recordBridgeCall('session.read.log')
			const parsed = await this.logBackend.readSessionFile(id)
			const title = typeof parsed.title === 'string' ? parsed.title : undefined
			delete parsed.title
			this.seedOperationHashesFromSession(parsed)
			if (options.hydrateOperations !== false) {
				await hydrateSessionOperations(parsed, (relativePath) =>
					readLocalText(this.vault, this.operationPath(relativePath)),
				)
			}
			return {
				session: parsed as unknown as PersistedChatSession,
				title,
			}
		}

		const filePath = getChatSessionPath(id)
		let content: string
		try {
			perfMetrics.recordBridgeCall('session.read')
			content = await readLocalText(this.vault, filePath)
		} catch {
			perfMetrics.recordBridgeCall('adapter.exists')
			const exists = await this.adapter.exists(filePath)
			if (!exists) {
				throw new Error(`Session file not found: ${filePath}`)
			}
			throw new SessionFileCorruptError(filePath)
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(content)
		} catch {
			throw new SessionFileCorruptError(filePath)
		}
		if (!parsed || typeof parsed !== 'object') {
			throw new SessionFileCorruptError(filePath)
		}
		const record = parsed as { session?: unknown; title?: unknown }
		if (!record.session || typeof record.session !== 'object') {
			throw new SessionFileCorruptError(filePath)
		}
		this.seedOperationHashesFromSession(record.session)
		if (options.hydrateOperations !== false) {
			await hydrateSessionOperations(record.session, (relativePath) =>
				readLocalText(this.vault, this.operationPath(relativePath)),
			)
		}
		return {
			session: record.session as PersistedChatSession,
			title: typeof record.title === 'string' ? record.title : undefined,
		}
	}

	async deleteSessionFile(id: string) {
		perfMetrics.recordBridgeCall('session.delete')
		if (this.logBackend) {
			await this.logBackend.deleteSessionFile(id)
		}
		await removeLocalPath(this.vault, getChatSessionPath(id))
		const operationDir = this.getOperationDir(id)
		await removeLocalPath(this.vault, operationDir, true)
		this.ensuredDirectories.delete(operationDir)
		this.operationFiles.delete(id)
		const prefix = `${getOperationDirectoryPath(id)}/`
		for (const key of [...this.operationHashes.keys()]) {
			if (key.startsWith(prefix)) this.operationHashes.delete(key)
		}
	}

	async recoverPendingTemps(): Promise<void> {
		await this.logBackend?.recoverPendingTemps()
	}

	async listSessionIds(): Promise<string[]> {
		let files: string[]
		let folders: string[]
		try {
			perfMetrics.recordBridgeCall('adapter.list')
			const listed = await this.adapter.list(CHAT_SESSIONS_DIR)
			files = listed.files
			folders = listed.folders
		} catch {
			return []
		}
		const ids = new Set<string>()
		for (const file of files) {
			const name = normalizePath(file).split('/').pop() ?? ''
			if (name.endsWith('.json')) {
				ids.add(name.slice(0, -'.json'.length))
			}
		}
		for (const folder of folders) {
			const name = normalizePath(folder).split('/').pop() ?? ''
			if (name && this.logBackend && (await this.logBackend.exists(name))) {
				ids.add(name)
			}
		}
		return [...ids].filter((id) => id.length > 0)
	}

	async hasAnySessionFiles(): Promise<boolean> {
		return (await this.listSessionIds()).length > 0
	}

	async readSessionOperationRefPaths(id: string): Promise<string[]> {
		let session: unknown
		if (this.logBackend && (await this.logBackend.exists(id))) {
			session = await this.logBackend.readSessionFile(id)
		} else {
			const content = await readLocalText(this.vault, getChatSessionPath(id))
			const parsed = JSON.parse(content) as { session?: unknown }
			session = parsed.session
		}
		const refs = (
			session as {
				operationRefs?: Array<{ ref?: { path?: unknown } }>
			}
		)?.operationRefs
		if (!Array.isArray(refs)) return []
		const paths: string[] = []
		for (const entry of refs) {
			const path = entry?.ref?.path
			if (typeof path !== 'string' || !isSafeOperationRefPath(path)) continue
			paths.push(normalizePath(`${CHAT_ROOT_DIR}/${path}`))
		}
		return paths
	}

	async listOperationFiles(): Promise<OpsGcFile[]> {
		const opsDir = normalizePath(`${CHAT_ROOT_DIR}/ops`)
		const files: OpsGcFile[] = []
		try {
			const listed = await this.adapter.list(opsDir)
			for (const folder of listed.folders) {
				const folderList = await this.adapter.list(folder)
				for (const file of folderList.files) {
					const normalized = normalizePath(file)
					const stat = await this.adapter.stat(normalized)
					files.push({
						path: normalized,
						size: stat?.size ?? 0,
					})
				}
			}
		} catch {
			/* No ops directory yet. */
		}
		return files
	}

	async removeOperationFiles(paths: string[]): Promise<void> {
		for (const path of paths) {
			await removeLocalPath(this.vault, path)
		}
	}

	async collectOperationGcReport(options?: OpsGcOptions): Promise<OpsGcReport> {
		return runOpsGc(this, options)
	}

	async writeMetaFile(meta: ChatMetaFile) {
		perfMetrics.recordBridgeCall('meta.write')
		await this.ensureSessionsDir()
		await writeLocalTextAtomic(
			this.vault,
			getChatMetaPath(),
			stringifyJsonFile(meta),
		)
	}

	async readMetaFile(): Promise<ChatMetaFile | null> {
		const filePath = getChatMetaPath()
		let content: string
		try {
			perfMetrics.recordBridgeCall('meta.read')
			content = await readLocalText(this.vault, filePath)
		} catch {
			return null
		}
		try {
			const parsed = JSON.parse(content)
			return isChatMetaFile(parsed) ? parsed : null
		} catch {
			return null
		}
	}
}
