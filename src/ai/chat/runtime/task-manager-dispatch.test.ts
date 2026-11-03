import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parse as parseAgentId } from 'id-agent'
import type { ChatSession } from '~/ai/chat/domain'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import { TaskManager } from './task-manager'
import {
	EXPLORER_AGENT_ID,
	getAgentDefinition,
	MASTER_AGENT_ID,
} from '~/ai/chat/agents/registry'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import { BASH_TMP_MOUNT_POINT } from '~/ai/tools/bash/mount-points'
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

describe('TaskManager dispatch and subagent models', () => {
	beforeEach(() => {
		writeTaskResult.mockClear()
		generateText.mockReset()
	})

	it.each([
		'origin is aborted',
		'session is replaced',
		'parent becomes terminal',
	])(
		'removes a nested continuation when persistence resumes after the %s',
		async (staleCondition) => {
			let releaseDeliveryPersist: (() => void) | undefined
			const controller = new AbortController()
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
			const state = {
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map(),
			}
			const persistSession = vi
				.fn<() => Promise<void>>()
				.mockResolvedValueOnce(undefined)
				.mockImplementationOnce(
					() =>
						new Promise<void>((resolve) => {
							releaseDeliveryPersist = resolve
						}),
				)
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

			const completion = manager.finishAgentAsCompleted(
				session,
				child,
				NEUTRAL_TEXT,
				{ turnId: 'T1', signal: controller.signal },
			)
			await vi.waitFor(() => expect(persistSession).toHaveBeenCalledTimes(2))
			if (staleCondition === 'origin is aborted') controller.abort()
			if (staleCondition === 'session is replaced') {
				state.loadedSessions.set(session.id, {
					...session,
					subagents: { master: createEmptyMasterAgent(4) },
				})
			}
			if (staleCondition === 'parent becomes terminal') {
				parent.status = 'cancelled'
			}
			releaseDeliveryPersist!()
			await completion

			expect(child.status).toBe('completed')
			expect(parent.pendingInputs).toEqual([])
		},
	)

	it('completes only a running child', async () => {
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'idle-child',
			type: 'subagent',
			status: 'idle',
		}
		master.subagents[child.id] = child
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
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

		await manager.finishAgentAsCompleted(
			session,
			child,
			NEUTRAL_TEXT,
			testOrigin(),
		)

		expect(child.status).toBe('idle')
		expect(writeTaskResult).not.toHaveBeenCalled()
	})

	it('dispatches a typed subagent with an id-agent task id', async () => {
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
		const toolExecutor = {
			getAgentDefinition: getEnabledExplorerDefinition,
			getSubagentModelSelection: () => undefined,
		}
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
		vi.spyOn(manager as never, 'runAgent' as never).mockResolvedValue(
			undefined as never,
		)

		const output = await manager.dispatchTask(
			{
				prompt: 'Inspect the vault',
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: 'master',
				sessionId: session.id,
			},
			testOrigin(),
		)

		const parsed = parseAgentId(output.taskId)
		expect(parsed?.prefix).toBe(EXPLORER_AGENT_ID)
		expect(master.subagents[output.taskId]).toMatchObject({
			id: output.taskId,
			type: EXPLORER_AGENT_ID,
			model: { providerId: 'provider', modelId: 'model' },
		})
		expect(output).toMatchObject({
			subagentType: EXPLORER_AGENT_ID,
			status: 'dispatched',
		})
	})

	it('captures the configured subagent model instead of later settings changes', async () => {
		const master = createEmptyMasterAgent(1)
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'neutral-session',
			createdAt: 1,
			updatedAt: 1,
			model: { providerId: 'caller-provider', modelId: 'caller-model' },
			subagents: { master },
		}
		const configuredModel = {
			providerId: 'configured-provider',
			modelId: 'configured-model',
		}
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
			} as never,
			{
				getProviderByIdOrThrow: () => ({ id: 'configured-provider' }),
				getModelByIdsOrThrow: () => ({ id: 'configured-model' }),
			} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			{
				getAgentDefinition: getEnabledExplorerDefinition,
				getSubagentModelSelection: () => ({ ...configuredModel }),
			} as never,
			{} as never,
			{} as never,
		)
		vi.spyOn(manager as never, 'runAgent' as never).mockResolvedValue(
			undefined as never,
		)

		const task = await manager.dispatchTask(
			{
				prompt: '调查中性内容 🌿',
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: session.id,
			},
			testOrigin(),
		)
		configuredModel.modelId = 'changed-after-dispatch'

		expect(master.subagents[task.taskId].model).toEqual({
			providerId: 'configured-provider',
			modelId: 'configured-model',
		})
	})

	it.each([
		{
			name: 'deleted provider',
			getProviderByIdOrThrow: () => {
				throw new Error('中性 provider 已删除 🌿')
			},
			getModelByIdsOrThrow: vi.fn(),
		},
		{
			name: 'removed model',
			getProviderByIdOrThrow: () => ({ id: 'configured-provider' }),
			getModelByIdsOrThrow: () => {
				throw new Error('中性 model 已移除 🌿')
			},
		},
	])(
		'falls back to the caller model after a $name subagent configuration',
		async (selection) => {
			const master = createEmptyMasterAgent(1)
			const session: ChatSession = {
				schemaVersion: 2,
				id: 'neutral-session',
				createdAt: 1,
				updatedAt: 1,
				model: { providerId: 'caller-provider', modelId: 'caller-model' },
				subagents: { master },
			}
			const manager = new TaskManager(
				{} as never,
				vi.fn(),
				{
					loadedSessions: new Map([[session.id, session]]),
					deletedSessionIds: new Set<string>(),
				} as never,
				selection as never,
				{ persistSession: vi.fn(async () => undefined) } as never,
				vi.fn(),
				{
					getAgentDefinition: getEnabledExplorerDefinition,
					getSubagentModelSelection: () => ({
						providerId: 'configured-provider',
						modelId: 'configured-model',
					}),
				} as never,
				{} as never,
				{} as never,
			)
			vi.spyOn(manager as never, 'runAgent' as never).mockResolvedValue(
				undefined as never,
			)

			const task = await manager.dispatchTask(
				{
					prompt: 'Review neutral notes 复核中性笔记 🌿',
					subagentType: EXPLORER_AGENT_ID,
					callerAgentId: MASTER_AGENT_ID,
					sessionId: session.id,
				},
				testOrigin(),
			)

			expect(master.subagents[task.taskId].model).toEqual(session.model)
		},
	)

	it('settles an unavailable configured model and notifies its parent', async () => {
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'neutral-child',
			type: EXPLORER_AGENT_ID,
			model: { providerId: 'missing-provider', modelId: 'missing-model' },
			status: 'running',
		}
		master.subagents[child.id] = child
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'neutral-session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const notifyParent = vi.fn(() => true)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
			} as never,
			{
				getProviderByIdOrThrow: () => {
					throw new Error('中性 provider 不可用 🌿')
				},
			} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)
		manager.setMasterAgentInputHandler(notifyParent)

		await manager.runAgent(session, child, testOrigin())

		expect(child.status).toBe('failed')
		expect(child.resultPath).toBe(
			`${BASH_TMP_MOUNT_POINT}/${session.id}/tasks/${child.id}.txt`,
		)
		expect(writeTaskResult).toHaveBeenCalledWith(
			{},
			child.resultPath,
			expect.stringContaining('中性 provider 不可用 🌿'),
		)
		expect(notifyParent).toHaveBeenCalledWith(
			session.id,
			expect.objectContaining({
				parts: [
					expect.objectContaining({
						data: expect.objectContaining({ kind: 'task-result-ready' }),
					}),
				],
			}),
			expect.anything(),
		)
	})

	it('captures master task lineage when dispatching and preserves it for nested tasks', async () => {
		const master = createEmptyMasterAgent(1)
		const controller = new AbortController()
		const origin: TaskOrigin = { turnId: 'T1', signal: controller.signal }
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

		const first = await manager.dispatchTask(
			{
				prompt: NEUTRAL_TEXT,
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: session.id,
			},
			origin,
		)
		const firstAgent = master.subagents[first.taskId]
		const second = await manager.dispatchTask(
			{
				prompt: NEUTRAL_TEXT,
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: first.taskId,
				sessionId: session.id,
			},
			origin,
		)

		await manager.finishAgentAsCompleted(
			session,
			firstAgent.subagents[second.taskId],
			NEUTRAL_TEXT,
			origin,
		)
		expect(firstAgent.pendingInputs).toHaveLength(1)
		await manager.finishAgentAsCompleted(
			session,
			firstAgent,
			NEUTRAL_TEXT,
			origin,
		)

		expect(handler).toHaveBeenCalledTimes(1)
		expect(handler.mock.calls[0]?.[2]).toEqual({
			turnId: 'T1',
			signal: controller.signal,
		})
		expect(master.pendingInputs).toEqual([])
	})

	it('cancelling T1 leaves T0 child compaction running', async () => {
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
			loadedSessions: new Map([[session.id, session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map(),
		} as never
		const compactionCoordinator = {
			cancel: vi.fn(),
		}
		const toolExecutor = {
			getAgentDefinition: getEnabledExplorerDefinition,
			getSubagentModelSelection: () => undefined,
		}
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
			compactionCoordinator as never,
		)
		vi.spyOn(manager as never, 'runAgent' as never).mockResolvedValue(
			undefined as never,
		)

		const t0 = await manager.dispatchTask(
			{
				prompt: NEUTRAL_TEXT,
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: session.id,
			},
			testOrigin('T0'),
		)
		const t1 = await manager.dispatchTask(
			{
				prompt: NEUTRAL_TEXT,
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: session.id,
			},
			testOrigin('T1'),
		)

		manager.cancelAllNonTerminalAgents(session, 'T1')

		expect(master.subagents[t0.taskId].status).toBe('running')
		expect(master.subagents[t1.taskId].status).toBe('cancelled')
		expect(compactionCoordinator.cancel).toHaveBeenCalledWith(
			session.id,
			t1.taskId,
		)
		expect(compactionCoordinator.cancel).not.toHaveBeenCalledWith(
			session.id,
			t0.taskId,
		)
	})
})
