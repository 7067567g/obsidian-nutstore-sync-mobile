import type { ChatSession } from '~/ai/chat/domain'
import { perfMetrics, perfNow } from '~/diagnostics/perf-metrics'
import { getMasterAgent, getSessionSubagents } from '~/ai/chat/domain'
import type { SessionRuntimeState } from '~/ai/chat/runtime/chat-state'
import type {
	AppUIMessage,
	AppUIMessagePart,
	ChatAgentState,
	ChatDisplayBlock,
	ReversibleToolOp,
} from '~/ai/chat/types'
import {
	buildMessageDisplayBlocks,
	messageHasUserContext,
} from '~/ai/chat/ui/display-blocks'
import type { ChatboxProps } from '~/ai/chat/ui/types'

// Solid stores attach reactive Symbol metadata to wrapped plain objects. Keep
// that metadata in the view layer instead of mutating the canonical session.
function snapshotViewValue<T>(
	value: T,
	seen = new WeakMap<object, unknown>(),
): T {
	if (!value || typeof value !== 'object') return value

	const source = value as object
	const existing = seen.get(source)
	if (existing) return existing as T

	if (Array.isArray(value)) {
		const snapshot: unknown[] = []
		seen.set(source, snapshot)
		for (const item of value) snapshot.push(snapshotViewValue(item, seen))
		return snapshot as T
	}

	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) return value

	const snapshot = Object.create(prototype) as Record<string, unknown>
	seen.set(source, snapshot)
	for (const [key, entry] of Object.entries(value)) {
		snapshot[key] = snapshotViewValue(entry, seen)
	}
	return snapshot as T
}

type TimelineItem = ChatboxProps['timeline'][number]

interface AgentTimelineCache {
	signature: unknown[]
	timeline: ChatboxProps['timeline']
}

interface MessageProjection {
	signature: number
	snapshot: AppUIMessage
	blocks: ChatDisplayBlock[]
	hasContext: boolean
}

/**
 * Incremental projection caches. The session is mutable and is persisted as a
 * whole; rebuilding every message's display blocks on each 33ms stream notify
 * is what makes long sessions sluggish on mobile. These caches reuse the
 * previous snapshot/blocks for every unchanged message and only rebuild the
 * streaming message.
 *
 * Correctness relies on immutable updates for the parts that can change:
 * `projectTextDelta` replaces the text part object, tool results replace the
 * dynamic-tool part object, `toolTimings[id]` is replaced, and
 * `operations[messageId]` arrays are replaced. The signatures compare those
 * object identities, so an in-place mutation would be missed.
 */
const agentTimelineCache = new WeakMap<ChatAgentState, AgentTimelineCache>()
const messageProjections = new WeakMap<AppUIMessage, MessageProjection>()
const partSnapshots = new WeakMap<object, AppUIMessagePart>()
const operationsSnapshots = new WeakMap<object, ReversibleToolOp[]>()

function sameSignature(left: readonly unknown[], right: readonly unknown[]) {
	if (left.length !== right.length) return false
	for (let index = 0; index < left.length; index += 1) {
		if (!Object.is(left[index], right[index])) return false
	}
	return true
}

const objectIds = new WeakMap<object, number>()
let nextObjectId = 1

function objectId(value: object) {
	const existing = objectIds.get(value)
	if (existing) return existing
	const id = nextObjectId++
	objectIds.set(value, id)
	return id
}

function mixHash(hash: number, value: number) {
	return Math.imul(hash ^ (value | 0), 16777619) >>> 0
}

function mixString(hash: number, value: string) {
	let result = hash
	for (let index = 0; index < value.length; index += 1) {
		result = mixHash(result, value.charCodeAt(index))
	}
	return result
}

function snapshotPart(part: AppUIMessagePart): AppUIMessagePart {
	const key = part as object
	const cached = partSnapshots.get(key)
	if (cached) return cached
	const snapshot = snapshotViewValue(part)
	partSnapshots.set(key, snapshot)
	return snapshot
}

function snapshotOperations(operations: ReversibleToolOp[] | undefined) {
	if (!operations) return []
	const key = operations as object
	const cached = operationsSnapshots.get(key)
	if (cached) return cached
	const snapshot = snapshotViewValue(operations)
	operationsSnapshots.set(key, snapshot)
	return snapshot
}

function snapshotMessage(message: AppUIMessage): AppUIMessage {
	return {
		...message,
		metadata: message.metadata
			? snapshotViewValue(message.metadata)
			: undefined,
		parts: message.parts.map(snapshotPart),
	}
}

function messageFingerprint(
	message: AppUIMessage,
	operations: ReversibleToolOp[] | undefined,
	toolTimings: ChatAgentState['toolTimings'],
) {
	let hash = 2166136261
	hash = mixHash(hash, objectId(message))
	hash = mixHash(hash, message.parts.length)
	for (const part of message.parts) {
		hash = mixHash(hash, objectId(part))
		if (part.type === 'dynamic-tool') {
			const timing = toolTimings[part.toolCallId]
			hash = mixHash(hash, timing ? objectId(timing) : 0)
		}
	}
	hash = mixHash(hash, operations ? objectId(operations) : 0)
	return hash
}

function projectMessage(
	message: AppUIMessage,
	operations: ReversibleToolOp[] | undefined,
	toolTimingsSnapshot: ChatAgentState['toolTimings'],
	toolTimings: ChatAgentState['toolTimings'],
) {
	const signature = messageFingerprint(message, operations, toolTimings)
	const cached = messageProjections.get(message)
	if (cached && cached.signature === signature) return cached

	const snapshot = snapshotMessage(message)
	const blocks = buildMessageDisplayBlocks(
		snapshot,
		toolTimingsSnapshot,
		snapshotOperations(operations),
	)
	const projection: MessageProjection = {
		signature,
		snapshot,
		blocks,
		hasContext: messageHasUserContext(snapshot),
	}
	messageProjections.set(message, projection)
	return projection
}

function agentSignature(agent: ChatAgentState) {
	let hash = 2166136261
	hash = mixHash(hash, objectId(agent))
	hash = mixString(hash, agent.id)
	hash = mixString(hash, agent.type)
	hash = mixString(hash, agent.status)
	hash = mixHash(hash, agent.createdAt)
	if (agent.startedAt !== undefined) hash = mixHash(hash, agent.startedAt)
	if (agent.finishedAt !== undefined) hash = mixHash(hash, agent.finishedAt)
	hash = mixString(hash, agent.model?.providerId ?? '')
	hash = mixString(hash, agent.model?.modelId ?? '')
	hash = mixString(hash, agent.resultPath ?? '')
	hash = mixHash(hash, agent.timeline.length)

	for (const message of agent.timeline) {
		hash = mixHash(hash, objectId(message))
		hash = mixHash(hash, message.parts.length)
		for (const part of message.parts) {
			hash = mixHash(hash, objectId(part))
			if (part.type === 'dynamic-tool') {
				const timing = agent.toolTimings[part.toolCallId]
				hash = mixHash(hash, timing ? objectId(timing) : 0)
			}
		}
		const operations = agent.operations[message.id]
		hash = mixHash(hash, operations ? objectId(operations) : 0)
	}
	for (const [toolCallId, timing] of Object.entries(agent.toolTimings)) {
		hash = mixString(hash, toolCallId)
		hash = mixHash(hash, objectId(timing))
	}
	return [hash, agent.status, agent.id, agent.type, agent.timeline.length]
}

function buildAgentTimeline(
	agent: ChatAgentState,
	createdAt: number,
): ChatboxProps['timeline'] {
	const signature = agentSignature(agent)
	const cached = agentTimelineCache.get(agent)
	if (cached && sameSignature(cached.signature, signature)) {
		return cached.timeline
	}

	const toolTimingsSnapshot = snapshotViewValue(agent.toolTimings)
	const timeline: ChatboxProps['timeline'] = []
	for (const message of agent.timeline) {
		if (message.role === 'system') continue
		const projection = projectMessage(
			message,
			agent.operations[message.id],
			toolTimingsSnapshot,
			agent.toolTimings,
		)
		if (!projection.blocks.length && !projection.hasContext) continue
		const item: TimelineItem = {
			createdAt: message.metadata?.createdAt ?? createdAt,
			message: projection.snapshot,
			displayBlocks: projection.blocks,
			showHeader: true,
		}
		timeline.push(item)
	}

	let previousModelId: string | undefined
	let canContinue = false
	for (const item of timeline) {
		if (item.message.role === 'user') {
			previousModelId = undefined
			canContinue = false
			continue
		}
		const modelId = item.message.metadata?.llm?.modelId
		item.showHeader = !canContinue || !modelId || modelId !== previousModelId
		previousModelId = modelId
		canContinue = !!modelId
	}

	agentTimelineCache.set(agent, { signature, timeline })
	return timeline
}

export function buildTimeline(session: ChatSession): ChatboxProps['timeline'] {
	const startedAt = perfNow()
	try {
		return buildAgentTimeline(getMasterAgent(session), session.createdAt)
	} finally {
		perfMetrics.recordRender(perfNow() - startedAt)
	}
}

export function buildAgentViews(
	session: ChatSession,
): ChatboxProps['agentsById'] {
	const startedAt = perfNow()
	try {
		const views: ChatboxProps['agentsById'] = {}
		const visit = (agent: ChatAgentState) => {
			for (const child of Object.values(agent.subagents)) {
				views[child.id] = {
					id: child.id,
					type: child.type,
					status: child.status,
					createdAt: child.createdAt,
					startedAt: child.startedAt,
					finishedAt: child.finishedAt,
					timeline: buildAgentTimeline(child, child.createdAt),
				}
				visit(child)
			}
		}
		visit(getMasterAgent(session))
		return views
	} finally {
		perfMetrics.recordRender(perfNow() - startedAt)
	}
}

export function collectOtherBusySessionIds(
	loadedSessions: Map<string, ChatSession>,
	activeSessionId: string | undefined,
	getRuntime: (sessionId: string) => SessionRuntimeState,
) {
	return Array.from(loadedSessions.values())
		.filter((session) => session.id !== activeSessionId)
		.filter((session) => {
			const runtime = getRuntime(session.id)
			return (
				runtime.runState !== 'idle' ||
				!!runtime.processing ||
				runtime.scheduler.queued.length > 0 ||
				getSessionSubagents(session).some(
					(agent) => agent.status === 'running' || agent.status === 'queued',
				)
			)
		})
		.map((session) => session.id)
}
