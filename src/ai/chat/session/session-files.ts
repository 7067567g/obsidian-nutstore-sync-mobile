import { normalizePath, Vault } from 'obsidian'
import { writeTextWithParents } from '~/utils/adapter-io'
import {
	ATOMIC_TEMP_MARKER,
	recoverOrphanedBackups,
} from '~/utils/atomic-replace'
import { perfMetrics, perfNow } from '~/diagnostics/perf-metrics'
import type { ChatSession } from '~/ai/chat/domain'
import type { PersistedChatSession } from './session-persistence'
import {
	DEFAULT_MAX_INLINE_OPERATION_BYTES,
	externalizeSessionOperations,
	getOperationDirectoryPath,
	hydrateSessionOperations,
	isSafeOperationRefPath,
	type OperationFile,
} from './session-operations'
import { SessionLogBackend } from './session-log-backend'
import {
	runOpsGc,
	type OpsGcFile,
	type OpsGcOptions,
	type OpsGcReport,
	type RetentionFile,
	type RetentionScanResult,
} from './ops-gc'
import type { RetentionCategory } from './retention-policy'
import { SESSION_LOG_FILENAME, type JsonRecord } from './session-log-format'
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

/** Hidden marker that keeps Android media scanners out of the agent data tree. */
export const CHAT_ROOT_NOMEDIA_FILE = `${CHAT_ROOT_DIR}/.nomedia`
/**
 * Best-effort `.nomedia` marker for the agent data root. Media scanning is an
 * Android storage-pressure/noise source and must never fail plugin startup.
 */
export async function ensureChatRootNomedia(vault: Vault) {
	const path = normalizePath(CHAT_ROOT_NOMEDIA_FILE)
	try {
		if (await vault.adapter.exists(path)) return
		await writeTextWithParents(vault.adapter, path, '')
	} catch {
		/* Advisory marker only; storage may be read-only or adapter may be absent. */
	}
}
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
	/**
	 * R2b / S2: TTL for the JSONL write-path freshness probe (index read + log
	 * stat). Forwarded to `SessionLogBackend`; `0` restores the per-write probe
	 * used by the freshness regression tests.
	 */
	stateFreshnessTtlMs?: number
	/**
	 * H4/K16 (WS-7): expose a cheap, comparable per-session version token so
	 * `SessionStore` revalidates its `loadedSessions` cache after an external
	 * rewrite (Nutstore sync pull, import, second window). Off by default so
	 * callers that rely on the legacy "cache stays authoritative until
	 * `invalidateSession`" contract (frozen store tests) are unaffected; the
	 * production backend opts in from `chat.service.core.ts`.
	 */
	trackSessionFileVersions?: boolean
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

/**
 * WS-5 / H8 (K15 validator + K16 conditional re-verify): a sidecar cache entry
 * records a comparable validator next to the content hash. The content hash is
 * already part of the content-addressed file path; the adapter stat (existence +
 * optional mtime) is the validator that catches external deletion/corruption
 * that the in-memory hash table cannot see.
 */
interface TrackedSidecarHash {
	hash: string
	/** Adapter mtime observed when this entry was last written/verified. */
	mtime?: number
}

/** K17: hard upper bound on the in-memory sidecar validator table. */
const MAX_TRACKED_SIDECAR_HASHES = 2048
/** K17: hard upper bound on remembered ensured directories. */
const MAX_ENSUREd_DIRECTORIES = 512
/** K17: hard upper bound on remembered per-session sidecar listings. */
const MAX_TRACKED_OPERATION_DIRECTORIES = 512

/** Bounds for the six-class retention scan; a report must never stall startup. */
const RETENTION_SCAN_FILE_CAP = 400
const RETENTION_SCAN_DIRECTORY_CAP = 80
const RETENTION_SCAN_MAX_DEPTH = 8

function evictOldestMapKeys<K, V>(map: Map<K, V>, max: number) {
	while (map.size > max) {
		const oldest = map.keys().next()
		if (oldest.done) return
		map.delete(oldest.value)
	}
}

function evictOldestSetValues<T>(set: Set<T>, max: number) {
	while (set.size > max) {
		const oldest = set.values().next()
		if (oldest.done) return
		set.delete(oldest.value)
	}
}

export class SessionsFileBackend {
	private readonly operationHashes = new Map<string, TrackedSidecarHash>()
	private readonly operationFiles = new Map<string, Set<string>>()
	private readonly ensuredDirectories = new Set<string>()
	/** K17 bounds; instance fields keep them overridable in tests. */
	private maxTrackedSidecarHashes = MAX_TRACKED_SIDECAR_HASHES
	private maxEnsuredDirectories = MAX_ENSUREd_DIRECTORIES
	private maxTrackedOperationDirectories = MAX_TRACKED_OPERATION_DIRECTORIES
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
					stateFreshnessTtlMs: options.stateFreshnessTtlMs,
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

	private async statFile(path: string) {
		try {
			perfMetrics.recordBridgeCall('adapter.stat')
			return await this.adapter.stat(path)
		} catch {
			return null
		}
	}

	/**
	 * H4 / K16 (WS-7): a cheap, comparable validator for the persisted payload.
	 *
	 * R2b / S3: this used to probe `log.exists()` (up to 3 `exists`) and then
	 * stat all three JSONL files — 4–6 bridge calls on every `loadSessionById`
	 * cache hit. `log.jsonl` is the commit point of every JSONL write (it is
	 * created on the first write and kept empty after compaction), so one stat
	 * of it is enough to catch an external append/rewrite. Only when it is
	 * absent do we fall back to the legacy whole-session file (one more stat).
	 *
	 * `mtime` + `size` is only a *suspicion* that the payload changed, so a
	 * mismatch makes `SessionStore` re-read the session. Returns `undefined` when
	 * tracking is disabled or the session has no on-disk files.
	 */
	async getSessionFileVersion(
		id: string,
	): Promise<string | number | undefined> {
		if (!this.options.trackSessionFileVersions) return undefined
		const logStat = await this.statFile(
			normalizePath(`${CHAT_SESSIONS_DIR}/${id}/${SESSION_LOG_FILENAME}`),
		)
		if (logStat && logStat.type !== 'folder') {
			return `log:${logStat.mtime ?? 0}:${logStat.size ?? 0}`
		}
		const stat = await this.statFile(getChatSessionPath(id))
		if (!stat || stat.type !== 'file') return undefined
		return `file:${stat.mtime ?? 0}:${stat.size ?? 0}`
	}

	/**
	 * N3 (WS-7): whether the session still has on-disk state. Used to tell a
	 * genuinely missing session (safe to reconcile/trim the index) apart from a
	 * transient read failure while the file is still there.
	 */
	async hasSessionFile(id: string): Promise<boolean> {
		if (this.logBackend && (await this.logBackend.exists(id))) return true
		const stat = await this.statFile(getChatSessionPath(id))
		return stat?.type === 'file'
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
				this.operationHashes.set(path, { hash })
			}
		}
	}

	/**
	 * H8 / K16: a cache hit on `operationHashes` is only a *suspicion* that the
	 * sidecar is unchanged. Because the path is content-addressed but the file
	 * can be deleted externally (vault sync, cleanup, Android storage reclaim),
	 * re-verify the validator (stat) before trusting the skip. A missing file, a
	 * non-file, or a changed mtime forces a rewrite.
	 */
	private async isSidecarStillCached(file: OperationFile): Promise<boolean> {
		const tracked = this.operationHashes.get(file.path)
		if (!tracked || tracked.hash !== file.hash) return false

		let stat: { type?: string; mtime?: number } | null
		try {
			perfMetrics.recordBridgeCall('adapter.stat')
			stat = await this.adapter.stat(this.operationPath(file.path))
		} catch {
			return false
		}
		if (!stat || stat.type === 'folder') return false
		if (
			tracked.mtime !== undefined &&
			stat.mtime !== undefined &&
			stat.mtime !== tracked.mtime
		) {
			return false
		}
		return true
	}

	private rememberOperationHash(path: string, hash: string, mtime?: number) {
		// Refresh insertion order so the bounded eviction below is LRU-ish.
		this.operationHashes.delete(path)
		this.operationHashes.set(path, { hash, mtime })
		evictOldestMapKeys(this.operationHashes, this.maxTrackedSidecarHashes)
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
		evictOldestSetValues(this.ensuredDirectories, this.maxEnsuredDirectories)
	}

	private async ensureSessionsDir() {
		await this.ensureDirectory(CHAT_SESSIONS_DIR)
	}

	private async writeOperationFiles(sessionId: string, files: OperationFile[]) {
		if (files.length > 0) {
			await this.ensureDirectory(this.getOperationDir(sessionId))
		}
		for (const file of files) {
			// H8 / K15+K16: never skip a sidecar write on a bare in-memory hash
			// match; re-verify the on-disk validator first.
			if (await this.isSidecarStillCached(file)) continue
			await writeLocalTextAtomic(
				this.vault,
				this.operationPath(file.path),
				file.content,
			)
			let mtime: number | undefined
			try {
				perfMetrics.recordBridgeCall('adapter.stat')
				const stat = await this.adapter.stat(this.operationPath(file.path))
				mtime = stat?.mtime
			} catch {
				mtime = undefined
			}
			this.rememberOperationHash(file.path, file.hash, mtime)
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
		evictOldestMapKeys(this.operationFiles, this.maxTrackedOperationDirectories)
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
				// R2b / D-008 #3: do NOT `JSON.stringify` the whole session here
				// just to sample its size — that re-serialised ~9.8 MiB on every
				// persist and defeated the per-message cache (S1). The JSONL
				// backend records the bytes it actually writes.
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
		// R2b / S4: atomic-replace backups are now healed here (startup) instead
		// of on every write. Session/segment directories are covered by the log
		// backend below; the chat root (chat-meta.json, .nomedia) only here.
		await recoverOrphanedBackups(this.vault, CHAT_ROOT_DIR)
		await this.logBackend?.recoverPendingTemps()
	}

	/**
	 * R2b / S2: an external writer changed this session, so the JSONL write-path
	 * state must be dropped as well — otherwise the freshness TTL could keep
	 * appending onto a state that predates the external change.
	 */
	invalidateSessionState(id: string): void {
		this.logBackend?.invalidateSessionState(id)
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
						mtime: stat?.mtime,
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

	/**
	 * Walk one class root with hard depth/file caps. Returns `truncated: true`
	 * instead of throwing when the cap is hit, so the report can say the byte
	 * count is a lower bound.
	 */
	private async scanRetentionRoot(
		root: string,
		category: RetentionCategory,
		classify: (path: string) => RetentionCategory = () => category,
	): Promise<{ files: RetentionFile[]; truncated: boolean }> {
		const files: RetentionFile[] = []
		const stack: Array<{ path: string; depth: number }> = [
			{ path: normalizePath(root), depth: 0 },
		]
		let visitedDirectories = 0
		let truncated = false
		while (stack.length > 0) {
			if (
				files.length >= RETENTION_SCAN_FILE_CAP ||
				visitedDirectories >= RETENTION_SCAN_DIRECTORY_CAP
			) {
				truncated = true
				break
			}
			const current = stack.pop()
			if (!current) break
			visitedDirectories += 1
			let listed: { files: string[]; folders: string[] }
			try {
				listed = await this.adapter.list(current.path)
			} catch {
				/* Missing/unreadable class root: report the classes we can see. */
				continue
			}
			for (const file of listed.files) {
				if (files.length >= RETENTION_SCAN_FILE_CAP) {
					truncated = true
					break
				}
				const path = normalizePath(file)
				let size = 0
				let mtime: number | undefined
				try {
					const stat = await this.adapter.stat(path)
					size = stat?.size ?? 0
					mtime = stat?.mtime
				} catch {
					/* Keep the file with unknown size rather than dropping it. */
				}
				files.push({ path, size, mtime, category: classify(path) })
			}
			if (current.depth >= RETENTION_SCAN_MAX_DEPTH) {
				if (listed.folders.length > 0) truncated = true
				continue
			}
			for (const folder of listed.folders) {
				stack.push({ path: normalizePath(folder), depth: current.depth + 1 })
			}
		}
		return { files, truncated }
	}

	async listRetentionFiles(): Promise<RetentionScanResult> {
		const roots: Array<{
			root: string
			category: RetentionCategory
			classify?: (path: string) => RetentionCategory
		}> = [
			{
				root: CHAT_SESSIONS_DIR,
				category: 'sessions',
				classify: (path) =>
					path.includes(ATOMIC_TEMP_MARKER) ? 'tmp' : 'sessions',
			},
			{ root: `${CHAT_ROOT_DIR}/ops`, category: 'ops' },
			{ root: `${CHAT_ROOT_DIR}/spill`, category: 'spill' },
			{ root: '.trash', category: 'trash' },
			{ root: `${CHAT_ROOT_DIR}/tmp`, category: 'tmp' },
			{ root: `${CHAT_ROOT_DIR}/diagnostics`, category: 'diagnostics' },
			{ root: `${CHAT_ROOT_DIR}/logs`, category: 'diagnostics' },
		]
		const files: RetentionFile[] = []
		const truncated = new Set<RetentionCategory>()
		for (const entry of roots) {
			const scan = await this.scanRetentionRoot(
				entry.root,
				entry.category,
				entry.classify,
			)
			files.push(...scan.files)
			if (scan.truncated) {
				truncated.add(entry.category)
				if (entry.classify) {
					for (const file of scan.files) truncated.add(file.category)
				}
			}
		}
		return { files, truncated: [...truncated] }
	}

	async removeRetentionFiles(paths: string[]): Promise<void> {
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
			const parsed: unknown = JSON.parse(content)
			return isChatMetaFile(parsed) ? parsed : null
		} catch {
			return null
		}
	}
}
