import { normalizePath, Vault } from 'obsidian'
import {
	ATOMIC_BACKUP_MARKER,
	ATOMIC_TEMP_MARKER,
	atomicReplaceContent,
} from '~/utils/atomic-replace'
import { readLocalText } from '~/utils/local-vault-io'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import {
	agentPathKey,
	isJsonRecord,
	SESSION_INDEX_FILENAME,
	SESSION_LOG_FILENAME,
	SESSION_META_FILENAME,
	splitSessionSnapshot,
	stringifySessionLogRecord,
	sessionWithoutSubagents,
	type JsonRecord,
	type SplitAgent,
} from './session-log-format'

export interface SessionLogBackendOptions {
	sessionsDir: string
	compactionBytes?: number
}

interface MessageEntry {
	json: string
	index: number
}

interface OperationEntry {
	json: string
}

interface SessionState {
	loaded: boolean
	generation: number
	activeSegment?: string
	metaJson?: string
	/** Set when the log has a torn tail; next append rewrites prefix + recovered tail. */
	pendingLogRepair?: { prefix: string; recovered: JsonRecord[] }
	agentMeta: Map<string, string>
	messages: Map<string, MessageEntry>
	operations: Map<string, OperationEntry>
}

interface SourceContent {
	messages: Map<string, Array<unknown>>
	operations: Map<string, Map<string, unknown>>
}

const messageJsonCache = new WeakMap<object, string>()

function isParseableJson(text: string): boolean {
	try {
		JSON.parse(text)
		return true
	} catch {
		return false
	}
}

const operationJsonCache = new WeakMap<object, string>()

function stateKey(pathKey: string, messageId: string) {
	return `${pathKey}\u0000${messageId}`
}

function prefixKey(pathKey: string) {
	return `${pathKey}\u0000`
}

function collectSourceContent(sourceSession: unknown): SourceContent {
	const messages = new Map<string, Array<unknown>>()
	const operations = new Map<string, Map<string, unknown>>()
	const root = isJsonRecord(sourceSession) ? sourceSession.subagents : undefined
	if (!isJsonRecord(root)) return { messages, operations }

	const visit = (agent: unknown, path: string[]) => {
		if (!isJsonRecord(agent)) return
		const pathKey = agentPathKey(path)
		if (Array.isArray(agent.timeline)) messages.set(pathKey, agent.timeline)
		const operationMap = new Map<string, unknown>()
		if (isJsonRecord(agent.operations)) {
			for (const [messageId, value] of Object.entries(agent.operations)) {
				if (Array.isArray(value)) operationMap.set(messageId, value)
			}
		}
		operations.set(pathKey, operationMap)
		const children = agent.subagents
		if (isJsonRecord(children)) {
			for (const [childId, child] of Object.entries(children)) {
				visit(child, [...path, childId])
			}
		}
	}

	for (const [id, agent] of Object.entries(root)) {
		visit(agent, [id])
	}
	return { messages, operations }
}

function applyRecordToState(state: SessionState, record: JsonRecord) {
	const type = record.type
	if (type === 'session-meta' && isJsonRecord(record.meta)) {
		state.metaJson = JSON.stringify(record.meta)
		return
	}
	if (type === 'snapshot' && isJsonRecord(record.session)) {
		state.metaJson = JSON.stringify(sessionWithoutSubagents(record.session))
		state.messages.clear()
		state.operations.clear()
		state.agentMeta.clear()
		for (const agent of splitSessionSnapshot(record.session)) {
			const pathKey = agentPathKey(agent.path)
			state.agentMeta.set(pathKey, JSON.stringify(agent.meta))
			for (const item of agent.messages) {
				state.messages.set(stateKey(pathKey, item.id), {
					json: JSON.stringify(item.message),
					index: item.index,
				})
			}
			for (const [messageId, operations] of agent.operations) {
				state.operations.set(stateKey(pathKey, messageId), {
					json: JSON.stringify(operations),
				})
			}
		}
		return
	}
	const path = Array.isArray(record.agentPath)
		? record.agentPath.filter(
				(segment): segment is string => typeof segment === 'string',
			)
		: []
	if (type === 'agent' && isJsonRecord(record.agent)) {
		state.agentMeta.set(agentPathKey(path), JSON.stringify(record.agent))
		return
	}
	if (type === 'message' && isJsonRecord(record.message)) {
		const messageId =
			typeof record.messageId === 'string' ? record.messageId : ''
		if (!messageId) return
		const index = typeof record.index === 'number' ? record.index : 0
		state.messages.set(stateKey(agentPathKey(path), messageId), {
			json: JSON.stringify(record.message),
			index,
		})
		return
	}
	if (type === 'operations') {
		const messageId =
			typeof record.messageId === 'string' ? record.messageId : ''
		if (!messageId) return
		state.operations.set(stateKey(agentPathKey(path), messageId), {
			json: JSON.stringify(record.operations ?? []),
		})
		return
	}
	if (type === 'tombstone') {
		const messageId =
			typeof record.messageId === 'string' ? record.messageId : ''
		if (!messageId) return
		const key = stateKey(agentPathKey(path), messageId)
		state.messages.delete(key)
		state.operations.delete(key)
	}
}

export class SessionLogCorruptionError extends Error {
	constructor(
		message: string,
		readonly lineNumber: number,
		readonly lineText: string,
	) {
		super(message)
		this.name = 'SessionLogCorruptionError'
	}
}

export interface SessionLogScan {
	/** Newline-terminated records that are durably committed. */
	records: JsonRecord[]
	/** Safe prefix length before any torn/incomplete tail. */
	committedLength: number
	/**
	 * Complete records found in the final frame that has no trailing newline.
	 * They are applied for reading and rewritten durably by the next append.
	 */
	recoveredTail: JsonRecord[]
	/** The raw torn tail (recovered or partial) that follows `committedLength`. */
	tornTail: string
}

function parseCommittedLine(
	line: string,
	lineNumber: number,
): JsonRecord | null {
	if (!line.trim()) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(line)
	} catch {
		throw new SessionLogCorruptionError(
			`Session log line ${lineNumber} is not valid JSON`,
			lineNumber,
			line,
		)
	}
	if (!isJsonRecord(parsed) || typeof parsed.type !== 'string') {
		throw new SessionLogCorruptionError(
			`Session log line ${lineNumber} is not a session record`,
			lineNumber,
			line,
		)
	}
	return parsed
}

/**
 * Scan a JSONL session log without trusting a trailing partial frame.
 * Committed bytes end at the last newline whose line parsed as a record.
 * A complete final record without a trailing newline is returned as
 * `recoveredTail` so the next append can rewrite it durably.
 */
export function scanSessionLog(text: string): SessionLogScan {
	const records: JsonRecord[] = []
	let offset = 0
	let lineNumber = 0
	while (offset < text.length) {
		const newline = text.indexOf('\n', offset)
		if (newline === -1) {
			const fragment = text.slice(offset)
			if (!fragment.trim()) {
				return {
					records,
					committedLength: text.length,
					recoveredTail: [],
					tornTail: '',
				}
			}
			try {
				const parsed: unknown = JSON.parse(fragment)
				if (isJsonRecord(parsed) && typeof parsed.type === 'string') {
					return {
						records,
						committedLength: offset,
						recoveredTail: [parsed],
						tornTail: fragment,
					}
				}
			} catch {
				/* Not a complete record: incomplete torn tail. */
			}
			return {
				records,
				committedLength: offset,
				recoveredTail: [],
				tornTail: fragment,
			}
		}
		const line = text.slice(offset, newline)
		offset = newline + 1
		lineNumber += 1
		const record = parseCommittedLine(line, lineNumber)
		if (record) records.push(record)
	}
	return {
		records,
		committedLength: text.length,
		recoveredTail: [],
		tornTail: '',
	}
}

function materializeSession(
	meta: JsonRecord,
	records: JsonRecord[],
): Record<string, unknown> {
	interface Accumulator {
		path: string[]
		meta: JsonRecord
		messages: Map<string, { index: number; message: JsonRecord }>
		removed: Set<string>
		operations: Map<string, unknown>
	}

	let topLevel: JsonRecord | undefined
	const agents = new Map<string, Accumulator>()
	const ensureAgent = (path: string[]) => {
		const key = agentPathKey(path)
		let agent = agents.get(key)
		if (!agent) {
			agent = {
				path,
				meta: { id: path[path.length - 1] },
				messages: new Map(),
				removed: new Set(),
				operations: new Map(),
			}
			agents.set(key, agent)
		}
		return agent
	}

	for (const record of records) {
		const type = record.type
		const path = Array.isArray(record.agentPath)
			? record.agentPath.filter(
					(segment): segment is string => typeof segment === 'string',
				)
			: []
		if (type === 'snapshot' && isJsonRecord(record.session)) {
			// A snapshot is the complete session, so records before it must not leak
			// into the materialized timeline.
			topLevel = {
				...(topLevel ?? {}),
				...sessionWithoutSubagents(record.session),
			}
			agents.clear()
			for (const split of splitSessionSnapshot(record.session)) {
				const agent = ensureAgent(split.path)
				agent.meta = { ...split.meta }
				agent.messages.clear()
				for (const item of split.messages) {
					agent.messages.set(item.id, {
						index: item.index,
						message: item.message,
					})
				}
				for (const [messageId, operations] of split.operations) {
					agent.operations.set(messageId, operations)
				}
			}
			continue
		}
		if (type === 'session-meta' && isJsonRecord(record.meta)) {
			topLevel = { ...(topLevel ?? {}), ...record.meta }
			continue
		}
		if (!path.length) continue
		const agent = ensureAgent(path)
		if (type === 'agent' && isJsonRecord(record.agent)) {
			agent.meta = { ...agent.meta, ...record.agent }
			continue
		}
		if (type === 'message' && isJsonRecord(record.message)) {
			const messageId =
				typeof record.messageId === 'string' ? record.messageId : ''
			const index = typeof record.index === 'number' ? record.index : 0
			if (!messageId) continue
			agent.messages.set(messageId, { index, message: record.message })
			agent.removed.delete(stateKey(agentPathKey(path), messageId))
			continue
		}
		if (type === 'operations') {
			const messageId =
				typeof record.messageId === 'string' ? record.messageId : ''
			if (!messageId) continue
			agent.operations.set(messageId, record.operations ?? [])
			continue
		}
		if (type === 'tombstone') {
			const messageId =
				typeof record.messageId === 'string' ? record.messageId : ''
			if (!messageId) continue
			agent.removed.add(stateKey(agentPathKey(path), messageId))
		}
	}

	const materialized = new Map<string, JsonRecord>()
	for (const [key, agent] of agents) {
		const timeline = [...agent.messages.entries()]
			.sort((a, b) => a[1].index - b[1].index)
			.map(([messageId, item]) => ({ id: messageId, ...item }))
			.filter(
				(item) =>
					!agent.removed.has(stateKey(agentPathKey(agent.path), item.id)),
			)
			.map((item) => item.message)
		const operations: Record<string, unknown> = {}
		for (const [messageId, value] of agent.operations) {
			if (agent.removed.has(stateKey(agentPathKey(agent.path), messageId))) {
				continue
			}
			operations[messageId] = value
		}
		materialized.set(key, {
			...agent.meta,
			id:
				typeof agent.meta.id === 'string'
					? agent.meta.id
					: agent.path[agent.path.length - 1],
			timeline,
			operations,
			subagents: {},
		})
	}

	for (const [key, agent] of materialized) {
		const path = agents.get(key)?.path ?? []
		if (path.length <= 1) continue
		const parentKey = agentPathKey(path.slice(0, -1))
		const parent = materialized.get(parentKey)
		if (!parent) continue
		const childId = path[path.length - 1]
		const subagents = parent.subagents as Record<string, unknown>
		subagents[childId] = agent
	}

	const rootSubagents: Record<string, unknown> = {}
	for (const [key, agent] of materialized) {
		const path = agents.get(key)?.path ?? []
		if (path.length === 1) {
			rootSubagents[path[0]] = agent
		}
	}
	return { ...meta, ...(topLevel ?? {}), subagents: rootSubagents }
}

export class SessionLogBackend {
	private readonly sessions = new Map<string, SessionState>()

	constructor(
		private readonly vault: Vault,
		private readonly options: SessionLogBackendOptions,
	) {}

	private get adapter() {
		return this.vault.adapter
	}

	private sessionDir(id: string) {
		return normalizePath(`${this.options.sessionsDir}/${id}`)
	}

	private logPath(id: string) {
		return normalizePath(`${this.sessionDir(id)}/${SESSION_LOG_FILENAME}`)
	}

	private indexPath(id: string) {
		return normalizePath(`${this.sessionDir(id)}/${SESSION_INDEX_FILENAME}`)
	}

	private metaPath(id: string) {
		return normalizePath(`${this.sessionDir(id)}/${SESSION_META_FILENAME}`)
	}

	private async readIndexInfo(id: string): Promise<{
		generation?: number
		activeSegment?: string
	}> {
		try {
			const text = await readLocalText(this.vault, this.indexPath(id))
			const parsed: unknown = JSON.parse(text)
			if (!isJsonRecord(parsed)) return {}
			return {
				generation:
					typeof parsed.generation === 'number' ? parsed.generation : undefined,
				activeSegment:
					typeof parsed.activeSegment === 'string'
						? parsed.activeSegment
						: undefined,
			}
		} catch {
			return {}
		}
	}

	private async writeIndexFile(
		id: string,
		generation: number,
		updatedAt: number,
		agents: SplitAgent[],
		activeSegment?: string,
	) {
		await atomicReplaceContent(
			this.vault,
			this.indexPath(id),
			JSON.stringify(
				{
					formatVersion: 1,
					id,
					generation,
					updatedAt,
					...(activeSegment ? { activeSegment } : {}),
					agents: agents.map((agent) => ({
						pathKey: agentPathKey(agent.path),
						id: agent.id,
						messageCount: agent.messages.length,
					})),
				},
				null,
				2,
			),
			'text',
		)
	}

	async exists(id: string): Promise<boolean> {
		try {
			return (
				(await this.adapter.exists(this.logPath(id))) ||
				(await this.adapter.exists(this.metaPath(id))) ||
				(await this.adapter.exists(this.indexPath(id)))
			)
		} catch {
			return false
		}
	}

	async readSessionFile(id: string): Promise<JsonRecord> {
		await this.promoteSessionTemps(id)
		const metaText = await readLocalText(this.vault, this.metaPath(id)).catch(
			() => null,
		)
		const meta: JsonRecord = metaText
			? (JSON.parse(metaText) as JsonRecord)
			: { schemaVersion: 2, id, createdAt: 0, updatedAt: 0 }
		const index = await this.readIndexInfo(id)
		const segment = await this.readLatestSegment(id, index)
		const logText = await readLocalText(this.vault, this.logPath(id)).catch(
			() => null,
		)
		const records: JsonRecord[] = []
		if (segment) records.push(segment)
		if (logText) {
			const scan = scanSessionLog(logText)
			records.push(...scan.records, ...scan.recoveredTail)
		}
		if (records.length === 0) {
			throw new Error(`Session log not found: ${this.logPath(id)}`)
		}
		return materializeSession(meta, records)
	}

	async writeSessionFile(
		id: string,
		session: JsonRecord,
		sourceSession?: unknown,
	): Promise<void> {
		const state = await this.loadState(id)
		const split = splitSessionSnapshot(session)
		const sourceContent = sourceSession
			? collectSourceContent(sourceSession)
			: { messages: new Map(), operations: new Map() }
		const records: JsonRecord[] = []
		const sessionMeta = sessionWithoutSubagents(session)
		const metaJson = JSON.stringify(sessionMeta)

		if (!state.loaded) {
			records.push({ type: 'snapshot', session })
			state.loaded = true
			state.activeSegment = undefined
			state.metaJson = metaJson
			for (const agent of split) {
				const pathKey = agentPathKey(agent.path)
				state.agentMeta.set(pathKey, JSON.stringify(agent.meta))
				for (const item of agent.messages) {
					state.messages.set(stateKey(pathKey, item.id), {
						json: JSON.stringify(item.message),
						index: item.index,
					})
				}
				for (const [messageId, operations] of agent.operations) {
					state.operations.set(stateKey(pathKey, messageId), {
						json: JSON.stringify(operations),
					})
				}
			}
		} else {
			this.appendDeltaRecords(state, split, sourceContent, records)
			if (state.metaJson !== metaJson) {
				records.push({ type: 'session-meta', meta: sessionMeta })
			}
		}

		if (state.loaded && records.length === 0 && state.metaJson === metaJson) {
			const cacheReady = await (async () => {
				try {
					return (
						(await this.adapter.exists(this.metaPath(id))) &&
						(await this.adapter.exists(this.indexPath(id)))
					)
				} catch {
					return false
				}
			})()
			if (cacheReady) return
		}

		await mkdirsVault(this.vault, this.sessionDir(id))
		try {
			// The append/repair below is the commit point. Only after it lands do
			// we advance generation and write the derived meta/index caches.
			if (records.length > 0) {
				const logPath = this.logPath(id)
				const repair = state.pendingLogRepair
				if (repair) {
					const repaired =
						repair.prefix +
						[...repair.recovered, ...records]
							.map(stringifySessionLogRecord)
							.join('\n') +
						'\n'
					await atomicReplaceContent(this.vault, logPath, repaired, 'text')
					state.pendingLogRepair = undefined
				} else {
					if (!(await this.adapter.exists(logPath))) {
						await this.adapter.write(logPath, '')
					}
					await this.adapter.append(
						logPath,
						`${records.map(stringifySessionLogRecord).join('\n')}\n`,
					)
				}
				state.generation += 1
			}
			await atomicReplaceContent(
				this.vault,
				this.metaPath(id),
				metaJson,
				'text',
			)
			state.metaJson = metaJson
			await this.writeIndexFile(
				id,
				state.generation,
				typeof session.updatedAt === 'number' ? session.updatedAt : Date.now(),
				split,
				state.activeSegment,
			)
			const compactionBytes = this.options.compactionBytes
			if (compactionBytes && (await this.getLogSize(id)) > compactionBytes) {
				await this.compactSession(id, session)
			}
		} catch (error) {
			// Persistence is the commit point: never leave in-memory state ahead
			// of disk. The next write reloads from the committed prefix.
			this.sessions.delete(id)
			throw error
		}
	}

	async getLogSize(id: string): Promise<number> {
		try {
			const stat = await this.adapter.stat(this.logPath(id))
			return stat?.size ?? 0
		} catch {
			return 0
		}
	}

	private async listSegmentEntries(
		id: string,
	): Promise<Array<{ file: string; name: string; generation: number }>> {
		try {
			const listed = await this.adapter.list(
				normalizePath(`${this.sessionDir(id)}/seg`),
			)
			return listed.files.flatMap((file) => {
				const name = normalizePath(file).split('/').pop() ?? ''
				const match = /^(\d+)-(\d+)\.json$/.exec(name)
				return match ? [{ file, name, generation: Number(match[1]) }] : []
			})
		} catch {
			return []
		}
	}

	private async promoteSessionTemps(id: string): Promise<void> {
		await this.promoteTempsInDirectory(this.sessionDir(id))
		await this.promoteTempsInDirectory(
			normalizePath(`${this.sessionDir(id)}/seg`),
		)
	}

	private async promoteTempsInDirectory(directory: string): Promise<void> {
		let listed: { files: string[] }
		try {
			listed = await this.adapter.list(directory)
		} catch {
			return
		}
		for (const file of listed.files) {
			const normalizedFile = normalizePath(file)
			const slash = normalizedFile.lastIndexOf('/')
			const parent = slash >= 0 ? normalizedFile.slice(0, slash) : ''
			if (parent !== directory) continue
			const name = normalizedFile.slice(slash + 1)
			const tempMarker = name.lastIndexOf(ATOMIC_TEMP_MARKER)
			const backupMarker = name.lastIndexOf(ATOMIC_BACKUP_MARKER)
			if (tempMarker > 0) {
				await this.recoverAtomicArtifact(directory, name, tempMarker)
			} else if (backupMarker > 0) {
				await this.recoverBackupArtifact(directory, name, backupMarker)
			}
		}
	}

	private async recoverAtomicArtifact(
		directory: string,
		name: string,
		markerIndex: number,
	): Promise<void> {
		const targetName = name.slice(0, markerIndex)
		if (!targetName) return
		const file = normalizePath(`${directory}/${name}`)
		const targetPath = normalizePath(`${directory}/${targetName}`)
		try {
			const tempText = await readLocalText(this.vault, file)
			const targetExists = await this.adapter.exists(targetPath)
			if (!targetExists) {
				// A complete temp that never made it to the target is the best
				// surviving copy; promote it.
				JSON.parse(tempText)
				await this.adapter.rename(file, targetPath)
				return
			}
			const targetText = await readLocalText(this.vault, targetPath)
			const targetValid = isParseableJson(targetText)
			if (tempText.length === 0) {
				// Crash before the temp body was written; it can never be
				// installed and would otherwise accumulate forever.
				await this.adapter.remove(file)
				return
			}
			const tempValid = isParseableJson(tempText)
			if (targetValid || !tempValid) {
				// Target is published/usable (or neither copy parses): keep the
				// target and drop the stale sibling.
				await this.adapter.remove(file)
				return
			}
			// Target exists but is corrupt while the temp parses: prefer the temp.
			await this.adapter.write(targetPath, tempText)
			await this.adapter.remove(file)
		} catch {
			/* Leave incomplete/corrupt artifacts for diagnostics. */
		}
	}

	private async recoverBackupArtifact(
		directory: string,
		name: string,
		markerIndex: number,
	): Promise<void> {
		const targetName = name.slice(0, markerIndex)
		if (!targetName) return
		const file = normalizePath(`${directory}/${name}`)
		const targetPath = normalizePath(`${directory}/${targetName}`)
		try {
			const backupText = await readLocalText(this.vault, file)
			if (backupText.length === 0) {
				await this.adapter.remove(file)
				return
			}
			const targetExists = await this.adapter.exists(targetPath)
			if (!targetExists) {
				JSON.parse(backupText)
				await this.adapter.rename(file, targetPath)
				return
			}
			const targetText = await readLocalText(this.vault, targetPath)
			const targetValid = isParseableJson(targetText)
			const backupValid = isParseableJson(backupText)
			if (targetValid || !backupValid) {
				await this.adapter.remove(file)
				return
			}
			await this.adapter.write(targetPath, backupText)
			await this.adapter.remove(file)
		} catch {
			/* Leave incomplete/corrupt artifacts for diagnostics. */
		}
	}

	/** Startup sweep: promote complete atomic temp files into their targets. */
	async recoverPendingTemps(): Promise<void> {
		let listed: { folders: string[] }
		try {
			listed = await this.adapter.list(this.options.sessionsDir)
		} catch {
			return
		}
		for (const folder of listed.folders) {
			const id = normalizePath(folder).split('/').pop() ?? ''
			if (!id) continue
			await this.promoteSessionTemps(id)
		}
	}

	async compactSession(id: string, session: JsonRecord): Promise<void> {
		const state = await this.loadState(id)
		const split = splitSessionSnapshot(session)
		const segDir = normalizePath(`${this.sessionDir(id)}/seg`)
		await mkdirsVault(this.vault, segDir)
		const messageCount = split.reduce(
			(total, agent) => total + agent.messages.length,
			0,
		)
		const segments = await this.listSegmentEntries(id)
		const highestGeneration = segments.reduce(
			(max, entry) => Math.max(max, entry.generation),
			state.generation,
		)
		let segmentGeneration = highestGeneration + 1
		let segmentName = `${String(segmentGeneration).padStart(4, '0')}-${String(
			messageCount,
		).padStart(4, '0')}.json`
		while (
			await this.adapter.exists(normalizePath(`${segDir}/${segmentName}`))
		) {
			segmentGeneration += 1
			segmentName = `${String(segmentGeneration).padStart(4, '0')}-${String(
				messageCount,
			).padStart(4, '0')}.json`
		}
		await atomicReplaceContent(
			this.vault,
			normalizePath(`${segDir}/${segmentName}`),
			JSON.stringify(session),
			'text',
		)
		const metaJson = JSON.stringify(sessionWithoutSubagents(session))
		const nextState: SessionState = {
			loaded: true,
			generation: state.generation + 1,
			activeSegment: segmentName,
			metaJson,
			agentMeta: new Map(),
			messages: new Map(),
			operations: new Map(),
		}
		for (const agent of split) {
			const pathKey = agentPathKey(agent.path)
			nextState.agentMeta.set(pathKey, JSON.stringify(agent.meta))
			for (const item of agent.messages) {
				nextState.messages.set(stateKey(pathKey, item.id), {
					json: JSON.stringify(item.message),
					index: item.index,
				})
			}
			for (const [messageId, operations] of agent.operations) {
				nextState.operations.set(stateKey(pathKey, messageId), {
					json: JSON.stringify(operations),
				})
			}
		}
		await atomicReplaceContent(this.vault, this.metaPath(id), metaJson, 'text')
		// Publish the new active segment before removing the old log; a crash
		// between these steps leaves the old log available for replay.
		await this.writeIndexFile(
			id,
			nextState.generation,
			typeof session.updatedAt === 'number' ? session.updatedAt : Date.now(),
			split,
			segmentName,
		)
		this.sessions.set(id, nextState)
		// Keep an empty log file so session existence checks and appends remain cheap.
		try {
			if (await this.adapter.exists(this.logPath(id))) {
				await this.adapter.remove(this.logPath(id))
			}
		} catch {
			/* Best effort: index already points at the segment. */
		}
		await this.adapter.write(this.logPath(id), '')
	}

	async deleteSessionFile(id: string): Promise<void> {
		try {
			await this.adapter.rmdir(this.sessionDir(id), true)
		} catch {
			/* No directory on disk. */
		}
		this.sessions.delete(id)
	}

	private appendDeltaRecords(
		state: SessionState,
		split: SplitAgent[],
		sourceContent: SourceContent,
		records: JsonRecord[],
	) {
		for (const agent of split) {
			const pathKey = agentPathKey(agent.path)
			const metaJson = JSON.stringify(agent.meta)
			if (state.agentMeta.get(pathKey) !== metaJson) {
				records.push({
					type: 'agent',
					agentPath: agent.path,
					agent: agent.meta,
				})
				state.agentMeta.set(pathKey, metaJson)
			}

			const seen = new Set<string>()
			const liveMessages = sourceContent.messages.get(pathKey)
			for (const item of agent.messages) {
				seen.add(item.id)
				const liveMessage = liveMessages?.[item.index]
				let json = isJsonRecord(liveMessage)
					? messageJsonCache.get(liveMessage)
					: undefined
				if (!json) {
					json = JSON.stringify(item.message)
					if (isJsonRecord(liveMessage)) {
						messageJsonCache.set(liveMessage, json)
					}
				}
				const key = stateKey(pathKey, item.id)
				if (state.messages.get(key)?.json === json) continue
				records.push({
					type: 'message',
					agentPath: agent.path,
					messageId: item.id,
					index: item.index,
					message: item.message,
				})
				state.messages.set(key, { json, index: item.index })
			}

			const prefix = prefixKey(pathKey)
			for (const key of [...state.messages.keys()]) {
				if (!key.startsWith(prefix)) continue
				const messageId = key.slice(prefix.length)
				if (seen.has(messageId)) continue
				records.push({
					type: 'tombstone',
					agentPath: agent.path,
					messageId,
				})
				state.messages.delete(key)
				state.operations.delete(key)
			}

			const liveOperations = sourceContent.operations.get(pathKey)
			for (const [messageId, operations] of agent.operations) {
				const liveArray = liveOperations?.get(messageId)
				let json = isJsonRecord(liveArray)
					? operationJsonCache.get(liveArray)
					: undefined
				if (!json) {
					json = JSON.stringify(operations)
					if (isJsonRecord(liveArray)) {
						operationJsonCache.set(liveArray, json)
					}
				}
				const key = stateKey(pathKey, messageId)
				if (state.operations.get(key)?.json === json) continue
				records.push({
					type: 'operations',
					agentPath: agent.path,
					messageId,
					operations,
				})
				state.operations.set(key, { json })
			}
		}
	}

	private async loadState(id: string): Promise<SessionState> {
		const cached = this.sessions.get(id)
		if (cached?.loaded) return cached
		await this.promoteSessionTemps(id)
		const state: SessionState = cached ?? {
			loaded: false,
			generation: 0,
			agentMeta: new Map(),
			messages: new Map(),
			operations: new Map(),
		}
		try {
			const index = await this.readIndexInfo(id)
			if (typeof index.generation === 'number') {
				state.generation = index.generation
			}
			state.activeSegment = index.activeSegment
			const segment = await this.readLatestSegment(id, index)
			if (segment) applyRecordToState(state, segment)
			const text = await readLocalText(this.vault, this.logPath(id)).catch(
				() => null,
			)
			if (text?.trim()) {
				const scan = scanSessionLog(text)
				for (const record of scan.records) {
					applyRecordToState(state, record)
				}
				for (const record of scan.recoveredTail) {
					applyRecordToState(state, record)
				}
				if (scan.tornTail) {
					state.pendingLogRepair = {
						prefix: text.slice(0, scan.committedLength),
						recovered: scan.recoveredTail,
					}
				}
			} else if (text === null && !segment) {
				throw new Error(`Session log not found: ${this.logPath(id)}`)
			}
			state.loaded = true
		} catch (error) {
			if (error instanceof SessionLogCorruptionError) throw error
			state.loaded = false
		}
		this.sessions.set(id, state)
		return state
	}

	private async readLatestSegment(
		id: string,
		index: { generation?: number; activeSegment?: string } = {},
	): Promise<JsonRecord | null> {
		try {
			const listed = await this.adapter.list(
				normalizePath(`${this.sessionDir(id)}/seg`),
			)
			const candidates = listed.files
				.map((file) => {
					const name = normalizePath(file).split('/').pop() ?? ''
					const match = /^(\d+)-(\d+)\.json$/.exec(name)
					return {
						file,
						name,
						generation: match ? Number(match[1]) : undefined,
					}
				})
				.filter(
					(
						entry,
					): entry is { file: string; name: string; generation: number } =>
						typeof entry.generation === 'number',
				)

			if (index.activeSegment) {
				const active = candidates.find(
					(entry) => entry.name === index.activeSegment,
				)
				if (active) return await this.readSegment(active.file)
			}

			let eligible = candidates
			const maxGeneration = index.generation
			if (typeof maxGeneration === 'number') {
				const capped = candidates.filter(
					(entry) => entry.generation <= maxGeneration + 1,
				)
				if (capped.length > 0) eligible = capped
			}
			eligible.sort(
				(left, right) =>
					left.generation - right.generation ||
					left.name.localeCompare(right.name),
			)
			const selected = eligible.at(-1)
			if (selected) return await this.readSegment(selected.file)

			// Last-resort compatibility for unexpected segment filenames.
			const fallback = listed.files.slice().sort().at(-1)
			return fallback ? await this.readSegment(fallback) : null
		} catch {
			return null
		}
	}

	private async readSegment(file: string): Promise<JsonRecord | null> {
		try {
			const parsed: unknown = JSON.parse(await readLocalText(this.vault, file))
			return isJsonRecord(parsed) ? { type: 'snapshot', session: parsed } : null
		} catch {
			return null
		}
	}
}
