import { describe, expect, it, vi } from 'vitest'
import {
	DEFAULT_MAX_INLINE_OPERATION_BYTES,
	externalizeSessionOperations,
	getOperationDirectoryPath,
	getOperationFilePath,
	hydrateSessionOperations,
	OPERATIONS_REF_MARKER,
} from '~/ai/chat/session/session-operations'

function makeSession(operations: unknown) {
	return {
		schemaVersion: 2,
		subagents: {
			master: {
				operations: { 'message-1': operations },
				subagents: {},
			},
		},
	}
}

describe('session operation externalization', () => {
	it('keeps operations inline while they stay under the threshold', () => {
		const session = makeSession([{ vaultPath: 'note.md', operation: 'create' }])
		const result = externalizeSessionOperations(session, {
			sessionId: 'session-1',
			maxInlineBytes: DEFAULT_MAX_INLINE_OPERATION_BYTES,
		})

		expect(result.hasRefs).toBe(false)
		expect(result.files).toHaveLength(0)
		expect(session.subagents.master.operations['message-1']).toHaveLength(1)
		expect('operationRefs' in session).toBe(false)
	})

	it('moves oversized operations to a sidecar and records a compact ref', () => {
		const operations = [
			{ vaultPath: 'note.md', operation: 'update', payload: 'x'.repeat(200) },
		]
		const session = makeSession(operations)
		const result = externalizeSessionOperations(session, {
			sessionId: 'session-1',
			maxInlineBytes: 10,
		})

		expect(result.hasRefs).toBe(true)
		expect(result.files).toHaveLength(1)
		expect(session.subagents.master.operations['message-1']).toEqual([])
		const refs = (session as { operationRefs?: unknown[] }).operationRefs
		expect(refs).toHaveLength(1)
		expect(refs?.[0]).toMatchObject({
			agentPath: ['master'],
			messageId: 'message-1',
			ref: {
				[OPERATIONS_REF_MARKER]: true,
				path: result.files[0].path,
				size: result.files[0].size,
				hash: result.files[0].hash,
			},
		})
		expect(JSON.parse(result.files[0].content)).toEqual(operations)
	})

	it('reuses the live source array identity for repeated persists', () => {
		const operations = [
			{ vaultPath: 'note.md', operation: 'update', payload: 'y'.repeat(200) },
		]
		const sourceSession = makeSession(operations)
		const first = externalizeSessionOperations(makeSession(operations), {
			sessionId: 'session-1',
			maxInlineBytes: 10,
			sourceSession,
		})
		const second = externalizeSessionOperations(
			makeSession(JSON.parse(JSON.stringify(operations))),
			{
				sessionId: 'session-1',
				maxInlineBytes: 10,
				sourceSession,
			},
		)

		expect(second.files[0].content).toBe(first.files[0].content)
		expect(second.files[0].hash).toBe(first.files[0].hash)
		expect(second.files[0].path).toBe(first.files[0].path)
	})

	it('restores sidecar operations into the persisted session', async () => {
		const operations = [{ vaultPath: 'note.md', operation: 'delete' }]
		const session = makeSession([])
		;(session as { operationRefs?: unknown[] }).operationRefs = [
			{
				agentPath: ['master'],
				messageId: 'message-1',
				ref: {
					[OPERATIONS_REF_MARKER]: true,
					path: 'ops/session-1/ref.json',
					size: 12,
					hash: 'abc',
				},
			},
		]
		const readFile = vi.fn(async () => JSON.stringify(operations))

		await hydrateSessionOperations(session, readFile)

		expect(readFile).toHaveBeenCalledWith('ops/session-1/ref.json')
		expect(session.subagents.master.operations['message-1']).toEqual(operations)
		expect('operationRefs' in session).toBe(false)
	})

	it('bounds sidecar hydration concurrency', async () => {
		const session = makeSession([])
		;(session as { operationRefs?: unknown[] }).operationRefs = Array.from(
			{ length: 6 },
			(_, index) => ({
				agentPath: ['master'],
				messageId: `message-${index}`,
				ref: {
					[OPERATIONS_REF_MARKER]: true,
					path: `ops/session-1/ref-${index}.json`,
					size: 2,
					hash: 'abc',
				},
			}),
		)
		let active = 0
		let maxActive = 0
		const readFile = vi.fn(async () => {
			active += 1
			maxActive = Math.max(maxActive, active)
			await new Promise((resolve) => window.setTimeout(resolve, 1))
			active -= 1
			return '[]'
		})

		await hydrateSessionOperations(session, readFile)

		expect(readFile).toHaveBeenCalledTimes(6)
		expect(maxActive).toBeLessThanOrEqual(2)
	})

	it('drops refs with unsafe paths instead of reading arbitrary files', async () => {
		const session = makeSession([])
		;(session as { operationRefs?: unknown[] }).operationRefs = [
			{
				agentPath: ['master'],
				messageId: 'message-1',
				ref: {
					[OPERATIONS_REF_MARKER]: true,
					path: '../../secret.json',
					size: 1,
					hash: 'abc',
				},
			},
		]
		const readFile = vi.fn(async () => '[]')

		await hydrateSessionOperations(session, readFile)

		expect(readFile).not.toHaveBeenCalled()
		expect(session.subagents.master.operations['message-1']).toEqual([])
	})

	it('rejects encoded traversal segments', async () => {
		const session = makeSession([])
		;(session as { operationRefs?: unknown[] }).operationRefs = [
			{
				agentPath: ['master'],
				messageId: 'message-1',
				ref: {
					[OPERATIONS_REF_MARKER]: true,
					path: 'ops/session-1/%2e%2e/secret.json',
					size: 1,
					hash: 'abc',
				},
			},
		]
		const readFile = vi.fn(async () => '[]')

		await hydrateSessionOperations(session, readFile)

		expect(readFile).not.toHaveBeenCalled()
	})

	it('degrades to an empty operation list when a sidecar is missing', async () => {
		const session = makeSession([])
		;(session as { operationRefs?: unknown[] }).operationRefs = [
			{
				agentPath: ['master'],
				messageId: 'message-1',
				ref: {
					[OPERATIONS_REF_MARKER]: true,
					path: 'ops/session-1/missing.json',
					size: 1,
					hash: 'abc',
				},
			},
		]
		const readFile = vi.fn(async () => {
			throw new Error('not found')
		})

		await expect(
			hydrateSessionOperations(session, readFile),
		).resolves.toBeUndefined()
		expect(session.subagents.master.operations['message-1']).toEqual([])
	})

	it('sanitizes dot segments in generated sidecar paths', () => {
		const path = getOperationFilePath('..', ['master'], '..', 'abc123')
		expect(path.startsWith('ops/')).toBe(true)
		expect(path.endsWith('.json')).toBe(true)
		expect(path).not.toContain('/../')
	})

	it('keeps lossy-sanitized session ids in distinct directories', () => {
		expect(getOperationDirectoryPath('a/b')).not.toBe(
			getOperationDirectoryPath('a?b'),
		)
	})
})

it('renders an explicit missing-snapshot marker when a sidecar with summary is missing', async () => {
	const session = makeSession([])
	;(session as { operationRefs?: unknown[] }).operationRefs = [
		{
			agentPath: ['master'],
			messageId: 'message-1',
			ref: {
				[OPERATIONS_REF_MARKER]: true,
				path: 'ops/session-1/missing.json',
				size: 123,
				hash: 'abc',
				summary: {
					vaultPath: 'note.md',
					operation: 'update',
					size: 123,
				},
			},
		},
	]
	const readFile = vi.fn(async () => {
		throw new Error('not found')
	})

	await hydrateSessionOperations(session, readFile)

	const operations = session.subagents.master.operations['message-1'] as Array<{
		vaultPath: string
		operation: string
		before: { skipped?: { reason?: string; size?: number } }
	}>
	expect(operations).toHaveLength(1)
	expect(operations[0].vaultPath).toBe('note.md')
	expect(operations[0].before.skipped).toEqual({
		size: 123,
		reason: 'missing',
	})
})
