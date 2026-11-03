import { readLocalText } from '~/utils/local-vault-io'
import {
	agentPathKey,
	isJsonRecord,
	prefixKey,
	sessionWithoutSubagents,
	splitSessionSnapshot,
	stateKey,
	type JsonRecord,
	type SplitAgent,
} from './session-log-format'
import { SessionLogCorruptionError, scanSessionLog } from './session-log-parse'
import {
	DEFAULT_STATE_FRESHNESS_TTL_MS,
	SessionLogSegmentsBase,
} from './session-log-segments'

interface MessageEntry {
	json: string
	index: number
}

interface OperationEntry {
	json: string
}

interface CachedMessageJson {
	json: string
	/** Identity signature of the mutable message shell (parts array + element identities). */
	signature: string
}

/**
 * Serialized-JSON cache keyed by the live message object (R2 / S1 port).
 *
 * The projector replaces or appends `parts` elements and assigns a new `parts`
 * array; it never mutates a part's text in place (see agent-event-projector).
 * Keying on the message object alone would go stale after such a replacement,
 * so the cache also records the parts length and every part's object identity.
 * An unchanged message hits the cache (no full `JSON.stringify`); any
 * replacement/append invalidates exactly that message.
 */
const messageJsonCache = new WeakMap<object, CachedMessageJson>()
const objectIdentityIds = new WeakMap<object, number>()
let nextObjectIdentityId = 1

function objectIdentityId(value: object) {
	let id = objectIdentityIds.get(value)
	if (id === undefined) {
		id = nextObjectIdentityId++
		objectIdentityIds.set(value, id)
	}
	return id
}

function messageJsonCacheSignature(message: JsonRecord): string {
	const parts: unknown[] = Array.isArray(message.parts)
		? (message.parts as unknown[])
		: []
	let signature = `${parts.length}`
	for (const part of parts) {
		signature += `:${typeof part === 'object' && part !== null ? objectIdentityId(part) : 0}`
	}
	return signature
}

function serialiseMessage(message: JsonRecord): string {
	const signature = messageJsonCacheSignature(message)
	const cached = messageJsonCache.get(message)
	if (cached && cached.signature === signature) return cached.json
	const json = JSON.stringify(message)
	messageJsonCache.set(message, { json, signature })
	return json
}

export interface SessionState {
	loaded: boolean
	generation: number
	activeSegment?: string
	metaJson?: string
	/** Size of `log.jsonl` observed at the last successful load/write. */
	logSize?: number
	/** Set when the log has a torn tail; next append rewrites prefix + recovered tail. */
	pendingLogRepair?: { prefix: string; recovered: JsonRecord[] }
	/**
	 * R2b / S2: `Date.now()` of the last successful freshness validation (or of
	 * the write that made this state authoritative). Within
	 * `stateFreshnessTtlMs` the write path skips `readIndexInfo` + `getLogSize`.
	 */
	validatedAt?: number
	agentMeta: Map<string, string>
	toolTimings: Map<string, string>
	messages: Map<string, MessageEntry>
	operations: Map<string, OperationEntry>
}

interface ApplyRecordOptions {
	/**
	 * Ignore `snapshot` records. Used when a segment read from the index is the
	 * authoritative base and the remaining log records are only deltas on top of
	 * it (a stale whole-session snapshot in the log must not wipe the segment).
	 */
	ignoreSnapshot?: boolean
}

function applyRecordToState(
	state: SessionState,
	record: JsonRecord,
	options: ApplyRecordOptions = {},
) {
	const type = record.type
	if (type === 'session-meta' && isJsonRecord(record.meta)) {
		state.metaJson = JSON.stringify(record.meta)
		return
	}
	if (type === 'snapshot' && isJsonRecord(record.session)) {
		if (options.ignoreSnapshot) return
		state.metaJson = JSON.stringify(sessionWithoutSubagents(record.session))
		state.messages.clear()
		state.operations.clear()
		state.agentMeta.clear()
		state.toolTimings.clear()
		for (const agent of splitSessionSnapshot(record.session)) {
			const pathKey = agentPathKey(agent.path)
			state.agentMeta.set(pathKey, JSON.stringify(agent.meta))
			for (const [toolCallId, timing] of Object.entries(agent.toolTimings)) {
				state.toolTimings.set(
					stateKey(pathKey, toolCallId),
					JSON.stringify(timing),
				)
			}
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
		const pathKey = agentPathKey(path)
		const agentRecord = { ...record.agent }
		const legacyTimings = agentRecord.toolTimings
		delete agentRecord.toolTimings
		state.agentMeta.set(pathKey, JSON.stringify(agentRecord))
		if (isJsonRecord(legacyTimings)) {
			for (const [toolCallId, timing] of Object.entries(legacyTimings)) {
				if (!isJsonRecord(timing)) continue
				state.toolTimings.set(
					stateKey(pathKey, toolCallId),
					JSON.stringify(timing),
				)
			}
		}
		return
	}
	if (type === 'tool-timing') {
		const toolCallId =
			typeof record.toolCallId === 'string' ? record.toolCallId : ''
		if (!toolCallId) return
		const key = stateKey(agentPathKey(path), toolCallId)
		if (isJsonRecord(record.timing)) {
			state.toolTimings.set(key, JSON.stringify(record.timing))
		} else {
			state.toolTimings.delete(key)
		}
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

export class SessionLogStateBase extends SessionLogSegmentsBase {
	protected readonly sessions = new Map<string, SessionState>()

	protected appendDeltaRecords(
		state: SessionState,
		split: SplitAgent[],
		records: JsonRecord[],
		/**
		 * R2b / D-008 #3: optional split of the *live* session. `split` carries
		 * the isolated encoded snapshot that must be persisted; `sourceSplit`
		 * carries the stable live objects used only for change detection. For
		 * plain (non-binary) sessions both serialize identically, so this lets
		 * the S1 per-message cache hit across persists instead of being defeated
		 * by the encoder's fresh object graph.
		 */
		sourceSplit?: SplitAgent[],
	) {
		const sourceMessages = new Map<string, JsonRecord>()
		if (sourceSplit) {
			for (const agent of sourceSplit) {
				const pathKey = agentPathKey(agent.path)
				for (const item of agent.messages) {
					sourceMessages.set(stateKey(pathKey, item.id), item.message)
				}
			}
		}
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
			for (const item of agent.messages) {
				seen.add(item.id)
				// R2 / S1: reuse the serialized JSON while the message's `parts`
				// identity signature is unchanged (no full stringify on every
				// persist). A replaced/appended part changes the signature and is
				// re-serialized, so the projector cannot be silently skipped.
				const key = stateKey(pathKey, item.id)
				const sourceMessage = sourceMessages.get(key)
				if (sourceMessage) {
					// Fast path: the live object is stable across persists, so an
					// unchanged message is a WeakMap hit and costs no stringify.
					// When it did change, emit the encoded snapshot and store *its*
					// JSON as the new baseline. If the live session changed while
					// the encoder was awaiting, the next write sees a mismatch and
					// re-emits instead of silently marking the lost update as saved.
					if (
						state.messages.get(key)?.json === serialiseMessage(sourceMessage)
					) {
						continue
					}
					const json = JSON.stringify(item.message)
					records.push({
						type: 'message',
						agentPath: agent.path,
						messageId: item.id,
						index: item.index,
						message: item.message,
					})
					state.messages.set(key, { json, index: item.index })
					continue
				}
				const json = JSON.stringify(item.message)
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

			for (const [messageId, operations] of agent.operations) {
				// Removed the dead `operationJsonCache` (guarded by isJsonRecord, it
				// never accepted arrays) rather than revive an identity cache.
				const json = JSON.stringify(operations)
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

			const timingPrefix = prefixKey(pathKey)
			for (const [toolCallId, timing] of Object.entries(agent.toolTimings)) {
				const key = stateKey(pathKey, toolCallId)
				const json = JSON.stringify(timing)
				if (state.toolTimings.get(key) === json) continue
				records.push({
					type: 'tool-timing',
					agentPath: agent.path,
					toolCallId,
					timing,
				})
				state.toolTimings.set(key, json)
			}
			for (const key of [...state.toolTimings.keys()]) {
				if (!key.startsWith(timingPrefix)) continue
				const toolCallId = key.slice(timingPrefix.length)
				if (
					Object.prototype.hasOwnProperty.call(agent.toolTimings, toolCallId)
				) {
					continue
				}
				records.push({
					type: 'tool-timing',
					agentPath: agent.path,
					toolCallId,
					timing: null,
				})
				state.toolTimings.delete(key)
			}
		}
	}

	private createState(): SessionState {
		return {
			loaded: false,
			generation: 0,
			agentMeta: new Map(),
			toolTimings: new Map(),
			messages: new Map(),
			operations: new Map(),
		}
	}

	/**
	 * Clear a state object in place so a reload never inherits keys from a
	 * previous partial read (WS1-N5).
	 */
	private resetState(state: SessionState) {
		state.loaded = false
		state.generation = 0
		state.activeSegment = undefined
		state.metaJson = undefined
		state.logSize = undefined
		state.pendingLogRepair = undefined
		state.validatedAt = undefined
		state.agentMeta.clear()
		state.toolTimings.clear()
		state.messages.clear()
		state.operations.clear()
	}

	/**
	 * Cheap freshness probe (K15/K16): the index generation and the log size are
	 * the validators we can compare without re-reading the whole log. A mismatch
	 * means an external writer (sync / another window) changed the session, so
	 * the in-memory state must be discarded and rebuilt before it is trusted.
	 *
	 * R2b / S2: this used to run on every persist (one `index.json` read + one
	 * `log.jsonl` stat). A burst of tool-call persists repeated the same two
	 * bridge calls for a session this process had just written. The probe is now
	 * TTL-bounded: within `stateFreshnessTtlMs` the state written/validated by
	 * this instance is authoritative, and an external writer is detected at most
	 * one TTL later (on the next write after the window, or immediately after an
	 * explicit `invalidateSession`).
	 */
	protected async isStateFresh(
		id: string,
		state: SessionState,
	): Promise<boolean> {
		if (!state.loaded) return false
		const ttl =
			this.options.stateFreshnessTtlMs ?? DEFAULT_STATE_FRESHNESS_TTL_MS
		const now = Date.now()
		if (
			ttl > 0 &&
			state.validatedAt !== undefined &&
			now - state.validatedAt < ttl
		) {
			return true
		}
		const index = await this.readIndexInfo(id)
		if (index.ownerMismatch) return false
		if (
			typeof index.generation === 'number' &&
			index.generation !== state.generation
		) {
			return false
		}
		if (state.logSize !== undefined) {
			const size = await this.getLogSize(id)
			if (size !== state.logSize) return false
		}
		state.validatedAt = now
		return true
	}

	/** Mark a just-written state as authoritative for the freshness TTL. */
	protected touchStateFreshness(state: SessionState) {
		state.validatedAt = Date.now()
	}

	protected async loadState(id: string): Promise<SessionState> {
		const cached = this.sessions.get(id)
		if (cached?.loaded && (await this.isStateFresh(id, cached))) return cached
		await this.promoteSessionTemps(id)
		const state: SessionState = cached ?? this.createState()
		this.resetState(state)
		try {
			const index = await this.readIndexInfo(id)
			if (typeof index.generation === 'number') {
				state.generation = index.generation
			}
			state.activeSegment = index.activeSegment
			const segment = await this.readLatestSegment(id, index)
			// A segment named by the index is the authoritative base; a whole-session
			// snapshot in a stale log must not wipe it (WS1-N1).
			const segmentAuthoritative = segment?.authoritative ?? false
			if (segment) applyRecordToState(state, segment.record)
			const text = await readLocalText(this.vault, this.logPath(id)).catch(
				() => null,
			)
			if (text?.trim()) {
				const scan = scanSessionLog(text)
				for (const record of scan.records) {
					applyRecordToState(state, record, {
						ignoreSnapshot: segmentAuthoritative,
					})
				}
				for (const record of scan.recoveredTail) {
					applyRecordToState(state, record, {
						ignoreSnapshot: segmentAuthoritative,
					})
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
			state.logSize = await this.getLogSize(id)
			state.loaded = true
			state.validatedAt = Date.now()
		} catch (error) {
			if (error instanceof SessionLogCorruptionError) throw error
			state.loaded = false
			state.logSize = undefined
		}
		this.sessions.set(id, state)
		return state
	}
}
