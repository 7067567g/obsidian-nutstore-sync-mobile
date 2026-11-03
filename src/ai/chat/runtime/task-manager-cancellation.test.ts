import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '~/ai/chat/domain'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import { TaskManager } from './task-manager'
import {
	EXPLORER_AGENT_ID,
	getAgentDefinition,
	MASTER_AGENT_ID,
} from '~/ai/chat/agents/registry'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import { createMasterTurnScheduler } from './master-turn-scheduler'
import type { TaskOrigin } from './master-turn-scheduler'

const writeTaskResult = vi.hoisted(() => vi.fn(async () => undefined))
const generateText = vi.hoisted(() => vi.fn())
const NEUTRAL_TEXT = 'Hello 你好 🌿'

function testOrigin(turnId = 'T1'): TaskOrigin {
	return { turnId, signal: new AbortController().signal }
}

function getEnabledExplorerDefinition(agentType: string) {
	const definition = getAgentDefinition(agentType, {
		fullAccess: false,
		subagents: { explorer: { enabled: true } },
	})
	if (!definition) throw new Error(`Unknown agent type: ${agentType}`)
	return definition
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

describe('TaskManager cancellation and fencing', () => {
	beforeEach(() => {
		writeTaskResult.mockClear()
		generateText.mockReset()
	})

	it('does not revive a task completion cancelled while its result is being written', async () => {
		let releaseWrite: (() => void) | undefined
		writeTaskResult.mockImplementationOnce(
			() =>
				new Promise<undefined>((resolve) => {
					releaseWrite = () => resolve(undefined)
				}),
		)
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'child',
			type: EXPLORER_AGENT_ID,
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

		const completion = manager.finishAgentAsCompleted(
			session,
			child,
			NEUTRAL_TEXT,
			testOrigin(),
		)
		await vi.waitFor(() => expect(writeTaskResult).toHaveBeenCalledTimes(1))
		child.status = 'cancelled'
		child.finishedAt = Date.now()
		releaseWrite!()
		await completion

		expect(child.status).toBe('cancelled')
		expect(handler).not.toHaveBeenCalled()
	})

	it('discards a stale task completion after its session is rehydrated', async () => {
		let releaseWrite: (() => void) | undefined
		writeTaskResult.mockImplementationOnce(
			() =>
				new Promise<undefined>((resolve) => {
					releaseWrite = () => resolve(undefined)
				}),
		)
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'child',
			type: EXPLORER_AGENT_ID,
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
		const state = {
			loadedSessions: new Map([[session.id, session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map(),
		}
		const persistSession = vi.fn(async () => undefined)
		const handler = vi.fn(() => true)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			state as never,
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
			testOrigin(),
		)
		await vi.waitFor(() => expect(writeTaskResult).toHaveBeenCalledTimes(1))
		state.loadedSessions.set(session.id, {
			...session,
			subagents: { master: createEmptyMasterAgent(3) },
		})
		releaseWrite!()
		await completion

		expect(child.status).toBe('running')
		expect(persistSession).not.toHaveBeenCalled()
		expect(handler).not.toHaveBeenCalled()
	})

	it('does not deliver a settled task after its session is rehydrated', async () => {
		let releasePersist: (() => void) | undefined
		let isPersistCurrent: (() => boolean) | undefined
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'child',
			type: EXPLORER_AGENT_ID,
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
		const state = {
			loadedSessions: new Map([[session.id, session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map(),
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
			state as never,
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
			testOrigin(),
		)
		await vi.waitFor(() => expect(persistSession).toHaveBeenCalledTimes(1))
		state.loadedSessions.set(session.id, {
			...session,
			subagents: { master: createEmptyMasterAgent(3) },
		})
		expect(isPersistCurrent?.()).toBe(false)
		releasePersist!()
		await completion

		expect(handler).not.toHaveBeenCalled()
		expect(master.pendingInputs).toEqual([])
	})

	it('fences master delivery after the origin turn is aborted', async () => {
		const master = createEmptyMasterAgent(1)
		const controller = new AbortController()
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			model: { providerId: 'provider', modelId: 'model' },
			subagents: { master },
		}
		const state = {
			loadedSessions: new Map([[session.id, session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map(),
			runtimeBySessionId: new Map([
				[
					session.id,
					{
						runState: 'thinking',
						draft: { text: '', userContext: [] },
						scheduler: {
							...createMasterTurnScheduler(),
							active: {
								turn: {
									turnId: 'T1',
									kind: 'user-submission',
									submission: { text: NEUTRAL_TEXT, userContext: [] },
								},
								abortController: controller,
							},
						},
					},
				],
			]),
		} as never
		const toolExecutor = {
			getAgentDefinition: getEnabledExplorerDefinition,
			getSubagentModelSelection: () => undefined,
		}
		const handler = vi.fn(
			(_sessionId: string, _input: AppUIMessage, _origin: TaskOrigin) => true,
		)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			state,
			{} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			toolExecutor as never,
			{} as never,
			{} as never,
		)
		manager.setMasterAgentInputHandler(handler)
		vi.spyOn(manager as never, 'runAgent' as never).mockResolvedValue(
			undefined as never,
		)

		const output = await manager.dispatchTask(
			{
				prompt: NEUTRAL_TEXT,
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: session.id,
			},
			{ turnId: 'T1', signal: controller.signal },
		)
		controller.abort()
		await manager.finishAgentAsCompleted(
			session,
			master.subagents[output.taskId],
			NEUTRAL_TEXT,
			{ turnId: 'T1', signal: controller.signal },
		)

		expect(handler).not.toHaveBeenCalled()
		expect(master.pendingInputs).toEqual([])
	})

	it('rejects non-dispatchable and unknown agent types', async () => {
		const master = createEmptyMasterAgent(1)
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			model: { providerId: 'provider', modelId: 'model' },
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
			{
				getAgentDefinition: (agentType: string) => {
					const definition = getAgentDefinition(agentType)
					if (!definition) throw new Error(`Unknown agent type: ${agentType}`)
					return definition
				},
				getSubagentModelSelection: () => undefined,
			} as never,
			{} as never,
			{} as never,
		)

		for (const [subagentType, message] of [
			[MASTER_AGENT_ID, 'cannot be dispatched'],
			['memory', 'Unknown agent type'],
		] as const) {
			await expect(
				manager.dispatchTask(
					{
						prompt: 'Inspect neutral notes 检查中性笔记 🌿',
						subagentType,
						callerAgentId: MASTER_AGENT_ID,
						sessionId: session.id,
					},
					testOrigin(),
				),
			).rejects.toThrow(message)
		}
		expect(master.subagents).toEqual({})
	})
})
