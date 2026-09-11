import { murmurHash } from 'ohash'
import { createSkippedFileSnapshot } from '~/ai/chat/messages/reversible-content'
import type { ReversibleToolOp } from '~/ai/chat/types'

/**
 * Large reversible-operation snapshots (before/after file contents) dominate
 * persisted chat sessions. They are needed for diff rendering and "recall", but
 * rewriting tens of megabytes of them on every tool step makes long mobile
 * sessions sluggish.
 *
 * This module moves a message's operation array out of the main session file
 * into a sidecar JSON file once it grows past a threshold. The session keeps a
 * compact reference (`operationRefs`) that older plugin versions safely ignore;
 * the storage backend hydrates references before the session reaches the
 * runtime, so the in-memory shape is unchanged.
 */

export const OPERATIONS_REF_MARKER = '__nutstore_reversible_op_ref_v1'
export const DEFAULT_MAX_INLINE_OPERATION_BYTES = 256 * 1024
/** Sidecars parsed concurrently while opening a session (mobile memory bound). */
export const OPERATION_HYDRATE_CONCURRENCY = 2

export interface PersistedOperationRef {
	[OPERATIONS_REF_MARKER]: true
	/** Path relative to the chat root directory, e.g. `ops/<session>/<id>.json`. */
	path: string
	/** Serialized length of the operations array (UTF-16 code units). */
	size: number
	/** Change-detection hash of the serialized operations array. */
	hash: string
	/** Optional metadata used to render an explicit missing-snapshot hint. */
	summary?: {
		vaultPath: string
		operation: ReversibleToolOp['operation']
		size: number
	}
}

export interface PersistedOperationRefEntry {
	agentPath: string[]
	messageId: string
	ref: PersistedOperationRef
}

export interface OperationFile {
	path: string
	content: string
	size: number
	hash: string
}

export interface ExternalizeOperationOptions {
	sessionId: string
	maxInlineBytes?: number
	/**
	 * Live in-memory session used as an identity key for encoded operation
	 * arrays. Reusing the serialized JSON while the source array is unchanged
	 * avoids re-stringifying tens of megabytes on every tool step.
	 */
	sourceSession?: unknown
}

interface CachedSerializedOperations {
	content: string
	size: number
	hash: string
}

const serializedOperationCache = new WeakMap<
	object,
	CachedSerializedOperations
>()

export interface ExternalizeOperationResult {
	files: OperationFile[]
	hasRefs: boolean
}

interface PersistedAgentLike {
	operations?: Record<string, unknown>
	subagents?: Record<string, PersistedAgentLike>
}

interface PersistedSessionLike {
	operationRefs?: unknown
	subagents?: Record<string, PersistedAgentLike>
}

function sanitizePathSegment(value: string, fallback: string) {
	const sanitized = value
		.replace(/[^A-Za-z0-9._-]/g, '_')
		.replace(/^\.+$/, '_')
		.toLowerCase()
		.slice(0, 64)
	return sanitized || fallback
}

export function getOperationDirectoryPath(sessionId: string) {
	// The human-readable segment is lossy (e.g. `a/b` and `a?b` both become
	// `a_b`), so pair it with a hash of the original id. This mirrors the
	// harness's injective session-directory encoding and keeps two sessions from
	// ever sharing/pruning each other's sidecars.
	const segment = sanitizePathSegment(sessionId, 'session')
	const hash = murmurHash(sessionId).toString(16)
	return `ops/${segment}-${hash}`
}

export function getOperationFilePath(
	sessionId: string,
	agentPath: readonly string[],
	messageId: string,
	hash: string,
) {
	const messageSegment = sanitizePathSegment(messageId, 'message')
	const key = `${agentPath.join('/')}\u0000${messageId}`
	const fileStem = murmurHash(key).toString(16)
	return `${getOperationDirectoryPath(sessionId)}/${fileStem}-${hash}-${messageSegment}.json`
}

export function isSafeOperationRefPath(path: unknown): path is string {
	if (typeof path !== 'string' || !path.startsWith('ops/')) return false
	if (!path.endsWith('.json')) return false
	const segments = path.split('/')
	return (
		segments.length >= 3 &&
		segments.every(
			(segment) =>
				segment.length > 0 &&
				segment !== '.' &&
				segment !== '..' &&
				/^[A-Za-z0-9._-]+$/.test(segment),
		)
	)
}

function isPersistedOperationRef(
	value: unknown,
): value is PersistedOperationRef {
	return (
		!!value &&
		typeof value === 'object' &&
		(value as Partial<PersistedOperationRef>)[OPERATIONS_REF_MARKER] === true &&
		typeof (value as Partial<PersistedOperationRef>).path === 'string'
	)
}

function forEachAgent(
	session: unknown,
	visit: (agent: PersistedAgentLike, agentPath: string[]) => void,
) {
	const root = session as PersistedSessionLike | null
	if (!root?.subagents || typeof root.subagents !== 'object') return
	const stack = Object.entries(root.subagents).map(([id, agent]) => ({
		agent,
		path: [id],
	}))
	while (stack.length > 0) {
		const current = stack.pop()
		if (!current) continue
		const { agent, path } = current
		if (!agent || typeof agent !== 'object') continue
		visit(agent, path)
		if (agent.subagents && typeof agent.subagents === 'object') {
			for (const [id, child] of Object.entries(agent.subagents)) {
				stack.push({ agent: child, path: [...path, id] })
			}
		}
	}
}

function isReversibleOperation(
	value: unknown,
): value is ReversibleToolOp['operation'] {
	return value === 'create' || value === 'update' || value === 'delete'
}

function buildOperationRefSummary(
	operation: unknown,
	size: number,
): PersistedOperationRef['summary'] | undefined {
	if (!operation || typeof operation !== 'object') return undefined
	const candidate = operation as { vaultPath?: unknown; operation?: unknown }
	if (typeof candidate.vaultPath !== 'string') return undefined
	if (!isReversibleOperation(candidate.operation)) return undefined
	return {
		vaultPath: candidate.vaultPath,
		operation: candidate.operation,
		size,
	}
}

function operationKey(agentPath: readonly string[], messageId: string) {
	return `${agentPath.join('/')}\u0000${messageId}`
}

function collectOperationsByKey(session: unknown) {
	const operationsByKey = new Map<string, object>()
	forEachAgent(session, (agent, agentPath) => {
		if (!agent.operations || typeof agent.operations !== 'object') return
		for (const [messageId, operations] of Object.entries(agent.operations)) {
			if (Array.isArray(operations)) {
				operationsByKey.set(operationKey(agentPath, messageId), operations)
			}
		}
	})
	return operationsByKey
}

/**
 * Replace oversized operation arrays in a *persisted* session snapshot with
 * sidecar references. The input is mutated in place (it is already a throwaway
 * encoded snapshot) and the sidecar files that must be written are returned.
 */
export function externalizeSessionOperations(
	session: unknown,
	options: ExternalizeOperationOptions,
): ExternalizeOperationResult {
	const maxInlineBytes =
		options.maxInlineBytes ?? DEFAULT_MAX_INLINE_OPERATION_BYTES
	const files: OperationFile[] = []
	const refs: PersistedOperationRefEntry[] = []
	const root = session as PersistedSessionLike | null
	const sourceOperations = options.sourceSession
		? collectOperationsByKey(options.sourceSession)
		: undefined

	if (root && typeof root === 'object' && 'operationRefs' in root) {
		delete root.operationRefs
	}

	forEachAgent(session, (agent, agentPath) => {
		if (!agent.operations || typeof agent.operations !== 'object') return
		for (const [messageId, operations] of Object.entries(agent.operations)) {
			if (!Array.isArray(operations)) continue
			const sourceOperationsArray = sourceOperations?.get(
				operationKey(agentPath, messageId),
			)
			let serialized = sourceOperationsArray
				? serializedOperationCache.get(sourceOperationsArray)
				: undefined
			if (!serialized) {
				const content = JSON.stringify(operations)
				serialized = {
					content,
					size: content.length,
					hash: murmurHash(content).toString(16),
				}
				if (sourceOperationsArray) {
					serializedOperationCache.set(sourceOperationsArray, serialized)
				}
			}
			if (serialized.size <= maxInlineBytes) continue
			const path = getOperationFilePath(
				options.sessionId,
				agentPath,
				messageId,
				serialized.hash,
			)
			files.push({
				path,
				content: serialized.content,
				size: serialized.size,
				hash: serialized.hash,
			})
			agent.operations[messageId] = []
			const summary = buildOperationRefSummary(operations[0], serialized.size)
			refs.push({
				agentPath,
				messageId,
				ref: {
					[OPERATIONS_REF_MARKER]: true,
					path,
					size: serialized.size,
					hash: serialized.hash,
					summary,
				},
			})
		}
	})

	if (refs.length > 0 && root && typeof root === 'object') {
		root.operationRefs = refs
	}
	return { files, hasRefs: refs.length > 0 }
}

function findAgentByPath(session: unknown, agentPath: readonly string[]) {
	let current: PersistedAgentLike | undefined = (
		session as PersistedSessionLike | null
	)?.subagents?.[agentPath[0]]
	for (const id of agentPath.slice(1)) {
		if (!current || typeof current !== 'object') return undefined
		current = current.subagents?.[id]
	}
	return current
}

function buildMissingSnapshotOperations(
	summary: PersistedOperationRef['summary'],
): unknown[] | undefined {
	if (!summary) return undefined
	const skipped = createSkippedFileSnapshot(summary.size, 'missing')
	switch (summary.operation) {
		case 'create':
			return [
				{
					vaultPath: summary.vaultPath,
					operation: 'create',
					before: { kind: 'file' },
					after: skipped,
				},
			]
		case 'update':
			return [
				{
					vaultPath: summary.vaultPath,
					operation: 'update',
					before: skipped,
					after: skipped,
				},
			]
		case 'delete':
			return [
				{
					vaultPath: summary.vaultPath,
					operation: 'delete',
					before: skipped,
				},
			]
	}
}

async function mapWithConcurrency<T>(
	items: readonly T[],
	concurrency: number,
	map: (item: T) => Promise<void>,
) {
	let cursor = 0
	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		async () => {
			while (cursor < items.length) {
				const index = cursor
				cursor += 1
				await map(items[index])
			}
		},
	)
	await Promise.all(workers)
}

/**
 * Restore sidecar operation arrays into a persisted session snapshot before it
 * is decoded. Missing or malformed sidecars are dropped rather than failing the
 * whole session load.
 */
export async function hydrateSessionOperations(
	session: unknown,
	readOperationFile: (path: string) => Promise<string>,
): Promise<void> {
	const root = session as PersistedSessionLike | null
	const entries = root?.operationRefs
	if (!root || !Array.isArray(entries)) return
	delete root.operationRefs

	await mapWithConcurrency(
		entries,
		OPERATION_HYDRATE_CONCURRENCY,
		async (entry) => {
			if (!entry || typeof entry !== 'object') return
			const candidate = entry as Partial<PersistedOperationRefEntry>
			if (
				!Array.isArray(candidate.agentPath) ||
				!candidate.agentPath.every(
					(id): id is string => typeof id === 'string',
				) ||
				typeof candidate.messageId !== 'string' ||
				!isPersistedOperationRef(candidate.ref) ||
				!isSafeOperationRefPath(candidate.ref.path)
			) {
				return
			}
			const agent = findAgentByPath(session, candidate.agentPath)
			if (!agent) return
			if (!agent.operations || typeof agent.operations !== 'object') {
				agent.operations = {}
			}
			try {
				const parsed: unknown = JSON.parse(
					await readOperationFile(candidate.ref.path),
				)
				agent.operations[candidate.messageId] = Array.isArray(parsed)
					? parsed
					: []
			} catch {
				agent.operations[candidate.messageId] =
					buildMissingSnapshotOperations(candidate.ref.summary) ?? []
			}
		},
	)
}
