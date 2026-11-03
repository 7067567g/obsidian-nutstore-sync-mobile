import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '~/ai/chat/domain'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import { TaskManager } from './task-manager'
import { normalizeRehydratedExecution } from '~/ai/chat/session/rehydration-execution'
import { EXPLORER_AGENT_ID } from '~/ai/chat/agents/registry'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import { BASH_TMP_MOUNT_POINT } from '~/ai/tools/bash/mount-points'
import type { TaskOrigin } from './master-turn-scheduler'

const writeTaskResult = vi.hoisted(() => vi.fn(async () => undefined))
const generateText = vi.hoisted(() => vi.fn())
const NEUTRAL_TEXT = 'Hello 你好 🌿'

function testOrigin(turnId = 'T1'): TaskOrigin {
	return { turnId, signal: new AbortController().signal }
}

vi.mock('~/ai/tools/bash/tmp-fs', () => ({
	writeBashTmpText: writeTaskResult,
}))
vi.mock('ai', async (importOriginal) => ({
	...(await importOriginal<typeof import('ai')>()),
	generateText,
}))
vi.mock('~/ai/core/runtime', () => ({
	prepareMessagesForModel: (
		_provider: unknown,
		_model: string,
		messages: unknown,
	) => messages,
	resolveLanguageModel: () => ({ model: {} }),
}))

describe('TaskManager parent notifications', () => {
	beforeEach(() => {
		writeTaskResult.mockClear()
		generateText.mockReset()
	})

	it('persists the result before notifying the direct parent', async () => {
		const events: string[] = []
		writeTaskResult.mockImplementationOnce(async () => {
			events.push('persist-result')
		})
		const master = createEmptyMasterAgent(1)
		const parent: ChatAgentState = {
			...createEmptyMasterAgent(1),
			id: 'parent',
			type: 'subagent',
			status: 'running',
		}
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'child',
			type: 'subagent',
			status: 'running',
		}
		parent.subagents.child = child
		vi.spyOn(parent.pendingInputs, 'push').mockImplementation((...items) => {
			events.push('notify-parent')
			for (const item of items) {
				Array.prototype.push.call(parent.pendingInputs, item)
			}
			return parent.pendingInputs.length
		})
		master.subagents.parent = parent
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 3,
			subagents: { master },
		}
		const state = {
			loadedSessions: new Map([['session', session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map(),
		} as never
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			state,
			{} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)

		await manager.finishAgentAsCompleted(session, child, 'done', testOrigin())
		expect(events).toEqual(['persist-result', 'notify-parent'])

		expect(writeTaskResult).toHaveBeenCalledWith(
			{},
			`${BASH_TMP_MOUNT_POINT}/session/tasks/child.txt`,
			'done',
		)

		expect(master.pendingInputs).toEqual([])
		expect(parent.pendingInputs).toHaveLength(1)
		expect(parent.pendingInputs[0].parts[0]).toMatchObject({
			type: 'data-system-notification',
			data: {
				kind: 'task-result-ready',
				taskId: 'child',
				resultPath: `${BASH_TMP_MOUNT_POINT}/session/tasks/child.txt`,
			},
		})
		expect(parent.pendingInputs[0].parts).toHaveLength(1)
	})

	it('persists a completed child after its origin is stopped', async () => {
		let releasePersist: (() => void) | undefined
		let isPersistCurrent: (() => boolean) | undefined
		const controller = new AbortController()
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'completed-child',
			type: 'subagent',
			status: 'running',
		}
		master.subagents[child.id] = child
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const persistSession = vi.fn(
			(_session: ChatSession, isCurrent?: () => boolean) => {
				isPersistCurrent = isCurrent
				return new Promise<void>((resolve) => {
					releasePersist = resolve
				})
			},
		)
		const handler = vi.fn(() => true)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map(),
			} as never,
			{} as never,
			{ persistSession } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)
		manager.setMasterAgentInputHandler(handler)

		const completion = manager.finishAgentAsCompleted(
			session,
			child,
			NEUTRAL_TEXT,
			{ turnId: 'T1', signal: controller.signal },
		)
		await vi.waitFor(() => expect(persistSession).toHaveBeenCalledTimes(1))
		controller.abort()

		expect(isPersistCurrent?.()).toBe(true)
		releasePersist!()
		await completion

		expect(child.status).toBe('completed')
		expect(handler).not.toHaveBeenCalled()
	})

	it('does not persist again before enqueuing a master continuation', async () => {
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'master-child',
			type: 'subagent',
			status: 'running',
		}
		master.subagents[child.id] = child
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const persistSession = vi.fn(async () => undefined)
		const handler = vi.fn(() => true)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map(),
			} as never,
			{} as never,
			{ persistSession } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)
		manager.setMasterAgentInputHandler(handler)

		await manager.finishAgentAsCompleted(
			session,
			child,
			NEUTRAL_TEXT,
			testOrigin(),
		)

		expect(persistSession).toHaveBeenCalledTimes(1)
		expect(handler).toHaveBeenCalledTimes(1)
	})

	it.each([0, 1, 3])(
		'rebuilds an unconsumed task continuation at depth %s after rehydration',
		(depth) => {
			const master = createEmptyMasterAgent(1)
			const child: ChatAgentState = {
				...createEmptyMasterAgent(2),
				id: 'completed-child',
				type: EXPLORER_AGENT_ID,
				status: 'completed',
				resultPath: `${BASH_TMP_MOUNT_POINT}/session/tasks/completed-child.txt`,
			}
			let parent = master
			for (let level = 0; level < depth; level += 1) {
				const ancestor: ChatAgentState = {
					...createEmptyMasterAgent(1),
					id: `探索 Explorer 🌿 ${level}`,
					type: EXPLORER_AGENT_ID,
					status: 'idle',
				}
				parent.subagents[ancestor.id] = ancestor
				parent = ancestor
			}
			child.id = '记忆 Memory 🌿'
			child.resultPath = `${BASH_TMP_MOUNT_POINT}/session/tasks/${child.id}.txt`
			parent.subagents[child.id] = child
			const pendingInput: AppUIMessage = {
				id: '结果 Result 🌿',
				role: 'user',
				parts: [
					{
						type: 'data-system-notification',
						data: {
							kind: 'task-result-ready',
							taskId: child.id,
							resultPath: child.resultPath,
						},
					},
				],
			}
			if (depth > 0) parent.pendingInputs.push(pendingInput)
			const session: ChatSession = {
				schemaVersion: 2,
				id: 'session',
				createdAt: 1,
				updatedAt: 1,
				subagents: { master },
			}
			const handler = vi.fn(
				(_sessionId: string, _input: AppUIMessage, _origin: TaskOrigin) => true,
			)
			const manager = new TaskManager(
				{} as never,
				vi.fn(),
				{
					loadedSessions: new Map([[session.id, session]]),
					deletedSessionIds: new Set<string>(),
					taskModelSelection: new Map(),
				} as never,
				{} as never,
				{ persistSession: vi.fn(async () => undefined) } as never,
				vi.fn(),
				{} as never,
				{} as never,
				{} as never,
			)
			manager.setMasterAgentInputHandler(handler)

			normalizeRehydratedExecution(session)
			manager.restoreMasterTaskContinuations(session)

			expect(handler).toHaveBeenCalledTimes(1)
			expect(handler.mock.calls[0]?.[0]).toBe(session.id)
			expect(handler.mock.calls[0]?.[1]).toMatchObject({
				role: 'user',
				parts: [
					{
						type: 'data-system-notification',
						data: {
							kind: 'task-result-ready',
							taskId: child.id,
							resultPath: child.resultPath,
						},
					},
				],
			})
			expect(master.pendingInputs).toEqual([])
			expect(parent.pendingInputs).toEqual([])
			if (depth > 0) expect(parent.status).toBe('cancelled')

			// Once the recovered turn is durable, another reload must not replay it.
			master.timeline.push(handler.mock.calls[0]![1])
			handler.mockClear()
			normalizeRehydratedExecution(session)
			manager.restoreMasterTaskContinuations(session)
			expect(handler).not.toHaveBeenCalled()

			// A result already consumed by its direct parent also needs no replay.
			master.timeline = []
			parent.timeline.push(pendingInput)
			manager.restoreMasterTaskContinuations(session)
			expect(handler).not.toHaveBeenCalled()
		},
	)

	it('does not settle or notify when persisting the result fails', async () => {
		writeTaskResult.mockRejectedValueOnce(new Error('disk full'))
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'child',
			type: 'subagent',
			status: 'running',
		}
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		master.subagents.child = child
		const state = {
			loadedSessions: new Map([['session', session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map(),
		} as never
		const persistSession = vi.fn(async () => undefined)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			state,
			{} as never,
			{ persistSession } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)

		await expect(
			manager.finishAgentAsCompleted(session, child, 'done', testOrigin()),
		).rejects.toThrow('disk full')

		expect(child.status).toBe('running')
		expect(master.pendingInputs).toEqual([])
		expect(persistSession).not.toHaveBeenCalled()
	})

	it('settles a child when direct parent delivery cannot be staged', async () => {
		const master = createEmptyMasterAgent(1)
		const parent: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'parent',
			type: 'subagent',
			status: 'running',
		}
		const child: ChatAgentState = {
			...createEmptyMasterAgent(3),
			id: 'child',
			type: 'subagent',
			status: 'running',
		}
		parent.subagents[child.id] = child
		master.subagents[parent.id] = parent
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const persistSession = vi
			.fn<() => Promise<void>>()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('neutral parent delivery failure'))
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map(),
			} as never,
			{} as never,
			{ persistSession } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)

		await expect(
			manager.finishAgentAsCompleted(
				session,
				child,
				NEUTRAL_TEXT,
				testOrigin(),
			),
		).rejects.toThrow('neutral parent delivery failure')

		expect(child.status).toBe('completed')
		expect(parent.pendingInputs).toEqual([])
	})

	it('does not deliver an orphaned child result to the master', async () => {
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'orphaned-child',
			type: 'subagent',
			status: 'running',
		}
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const handler = vi.fn(() => true)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map(),
			} as never,
			{} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)
		manager.setMasterAgentInputHandler(handler)

		await expect(
			manager.finishAgentAsCompleted(
				session,
				child,
				NEUTRAL_TEXT,
				testOrigin(),
			),
		).rejects.toThrow('Task parent is unavailable')

		expect(child.status).toBe('completed')
		expect(handler).not.toHaveBeenCalled()
	})
})
