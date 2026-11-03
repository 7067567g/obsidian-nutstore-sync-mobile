import {
	agentPathKey,
	isJsonRecord,
	sessionWithoutSubagents,
	splitSessionSnapshot,
	stateKey,
	type JsonRecord,
} from './session-log-format'

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

export function materializeSession(
	meta: JsonRecord,
	records: JsonRecord[],
): Record<string, unknown> {
	interface Accumulator {
		path: string[]
		meta: JsonRecord
		messages: Map<string, { index: number; message: JsonRecord }>
		removed: Set<string>
		operations: Map<string, unknown>
		toolTimings: Map<string, JsonRecord>
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
				toolTimings: new Map(),
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
				agent.toolTimings.clear()
				for (const [toolCallId, timing] of Object.entries(split.toolTimings)) {
					if (isJsonRecord(timing)) agent.toolTimings.set(toolCallId, timing)
				}
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
			const agentRecord = { ...record.agent }
			const legacyTimings = agentRecord.toolTimings
			delete agentRecord.toolTimings
			agent.meta = { ...agent.meta, ...agentRecord }
			if (isJsonRecord(legacyTimings)) {
				for (const [toolCallId, timing] of Object.entries(legacyTimings)) {
					if (isJsonRecord(timing)) agent.toolTimings.set(toolCallId, timing)
				}
			}
			continue
		}
		if (type === 'tool-timing') {
			const toolCallId =
				typeof record.toolCallId === 'string' ? record.toolCallId : ''
			if (!toolCallId) continue
			if (isJsonRecord(record.timing)) {
				agent.toolTimings.set(toolCallId, record.timing)
			} else {
				agent.toolTimings.delete(toolCallId)
			}
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
			toolTimings: Object.fromEntries(agent.toolTimings),
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
