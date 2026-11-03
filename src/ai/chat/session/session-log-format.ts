export const SESSION_LOG_FORMAT_VERSION = 2
/** Segments kept after compaction: active plus this many previous generations. */
export const SESSION_SEGMENT_RETENTION_GENERATIONS = 1
export const SESSION_LOG_FILENAME = 'log.jsonl'
export const SESSION_INDEX_FILENAME = 'index.json'
export const SESSION_META_FILENAME = 'meta.json'

export type JsonRecord = Record<string, unknown>

export interface SplitMessage {
	id: string
	index: number
	message: JsonRecord
}

export interface SplitAgent {
	path: string[]
	id: string
	meta: JsonRecord
	/** Incremental per-call timing records; kept out of `meta` to avoid rewriting it. */
	toolTimings: JsonRecord
	messages: SplitMessage[]
	operations: Map<string, unknown[]>
}

export function isJsonRecord(value: unknown): value is JsonRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function agentPathKey(path: readonly string[]) {
	return path.join('/')
}

export function stateKey(pathKey: string, messageId: string) {
	return `${pathKey}\u0000${messageId}`
}

export function prefixKey(pathKey: string) {
	return `${pathKey}\u0000`
}

export function sessionWithoutSubagents(snapshot: JsonRecord): JsonRecord {
	const meta = { ...snapshot }
	delete meta.subagents
	return meta
}

function stripAgentMeta(agent: JsonRecord): JsonRecord {
	const meta = { ...agent }
	delete meta.timeline
	delete meta.operations
	delete meta.subagents
	delete meta.toolTimings
	return meta
}

function splitToolTimings(agent: JsonRecord): JsonRecord {
	const timings: JsonRecord = {}
	if (!isJsonRecord(agent.toolTimings)) return timings
	for (const [toolCallId, timing] of Object.entries(agent.toolTimings)) {
		if (isJsonRecord(timing)) timings[toolCallId] = timing
	}
	return timings
}

function messageId(message: JsonRecord, index: number) {
	const id = message.id
	return typeof id === 'string' && id.length > 0 ? id : `index-${index}`
}

/** Walk a persisted ChatSession snapshot in memory only. */
export function splitSessionSnapshot(snapshot: JsonRecord): SplitAgent[] {
	const result: SplitAgent[] = []
	const root = snapshot.subagents
	if (!isJsonRecord(root)) return result

	const visit = (id: string, agent: unknown, path: string[]) => {
		if (!isJsonRecord(agent)) return
		const timeline = Array.isArray(agent.timeline) ? agent.timeline : []
		const operations = new Map<string, unknown[]>()
		if (isJsonRecord(agent.operations)) {
			for (const [messageId, value] of Object.entries(agent.operations)) {
				if (Array.isArray(value)) operations.set(messageId, value)
			}
		}
		result.push({
			path,
			id: typeof agent.id === 'string' ? agent.id : id,
			meta: stripAgentMeta(agent),
			toolTimings: splitToolTimings(agent),
			messages: timeline
				.map((message, index) =>
					isJsonRecord(message)
						? {
								id: messageId(message, index),
								index,
								message,
							}
						: undefined,
				)
				.filter((message): message is SplitMessage => !!message),
			operations,
		})

		const children = agent.subagents
		if (isJsonRecord(children)) {
			for (const [childId, child] of Object.entries(children)) {
				visit(childId, child, [...path, childId])
			}
		}
	}

	for (const [id, agent] of Object.entries(root)) {
		visit(id, agent, [id])
	}
	return result
}

export function parseSessionLogLine(line: string): JsonRecord | null {
	const trimmed = line.trim()
	if (!trimmed) return null
	try {
		const parsed: unknown = JSON.parse(trimmed)
		return isJsonRecord(parsed) && typeof parsed.type === 'string'
			? parsed
			: null
	} catch {
		return null
	}
}

export function stringifySessionLogRecord(record: JsonRecord) {
	return JSON.stringify(record)
}
