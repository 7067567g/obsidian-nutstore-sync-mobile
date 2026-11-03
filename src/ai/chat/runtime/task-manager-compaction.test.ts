import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '~/ai/chat/domain'
import { MessageFactory } from '~/ai/chat/messages/message-factory'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import { ContextCompactionCoordinator } from './context-compaction-coordinator'
import { TaskManager } from './task-manager'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
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

describe('TaskManager compaction resume', () => {
	beforeEach(() => {
		writeTaskResult.mockClear()
		generateText.mockReset()
	})

	it('carries tool-call continuation across a compaction resume', async () => {
		const master = createEmptyMasterAgent(1)
		const agent: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'neutral-child',
			type: 'subagent',
			model: { providerId: 'neutral-provider', modelId: 'neutral-model' },
			status: 'running',
			timeline: [
				{
					id: 'neutral-request',
					role: 'user',
					metadata: { createdAt: 1 },
					parts: [{ type: 'text', text: NEUTRAL_TEXT }],
				},
			],
		}
		master.subagents[agent.id] = agent
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'neutral-session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const continuation = {
			consecutiveCount: 2,
			isRepeatedTooManyTimes: false,
		} as never
		const runTurn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'needs-compaction', continuation })
			.mockResolvedValueOnce({ status: 'completed', text: NEUTRAL_TEXT })
		const state = {
			loadedSessions: new Map([[session.id, session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map([
				[
					agent.id,
					{ providerId: 'neutral-provider', modelId: 'neutral-model' },
				],
			]),
		}
		const manager = new TaskManager(
			{} as never,
			vi.fn(async () => undefined),
			state as never,
			{
				getProviderByIdOrThrow: () => ({ id: 'neutral-provider' }),
				getModelByIdsOrThrow: () => ({ id: 'neutral-model' }),
			} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{ runTurn } as never,
		)
		manager.setMasterAgentInputHandler(() => true)

		await manager.runAgent(session, agent, testOrigin())

		expect(runTurn.mock.calls[1][0].continuation).toBe(continuation)
	})

	it('settles after one failed hard-pressure summary instead of retrying', async () => {
		generateText.mockResolvedValue({ text: ' \n\t ' })
		const master = createEmptyMasterAgent(1)
		const agent: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'neutral-child',
			type: 'subagent',
			model: { providerId: 'neutral-provider', modelId: 'neutral-model' },
			status: 'running',
			timeline: [
				{
					id: 'neutral-old-user',
					role: 'user',
					metadata: { createdAt: 1 },
					parts: [{ type: 'text', text: NEUTRAL_TEXT.repeat(10_000) }],
				},
				{
					id: 'neutral-old-assistant',
					role: 'assistant',
					metadata: {
						createdAt: 2,
						llm: {
							usage: {
								inputTokens: 86_000,
								outputTokens: 0,
								totalTokens: 86_000,
							} as never,
						},
					},
					parts: [{ type: 'text', text: NEUTRAL_TEXT }],
				},
				{
					id: 'neutral-current-user',
					role: 'user',
					metadata: { createdAt: 3 },
					parts: [{ type: 'text', text: NEUTRAL_TEXT }],
				},
			],
		}
		master.subagents[agent.id] = agent
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'neutral-session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const store = {
			persistSession: vi.fn(async () => undefined),
			persistMetaAndIndex: vi.fn(async () => undefined),
			upsertSessionIndexItem: vi.fn(),
		}
		const factory = new MessageFactory({} as never, vi.fn())
		const coordinator = new ContextCompactionCoordinator(
			store as never,
			factory,
		)
		const runTurn = vi.fn()
		const manager = new TaskManager(
			{} as never,
			vi.fn(async () => undefined),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map([
					[
						agent.id,
						{ providerId: 'neutral-provider', modelId: 'neutral-model' },
					],
				]),
			} as never,
			{
				getProviderByIdOrThrow: () => ({ id: 'neutral-provider' }),
				getModelByIdsOrThrow: () => ({
					id: 'neutral-model',
					limit: { context: 100_000, output: 10_000 },
				}),
			} as never,
			store as never,
			vi.fn(),
			{} as never,
			factory,
			{
				runTurn,
				resolveSummaryContext: vi.fn(async () => ({})),
			} as never,
			coordinator,
			() => 'llm' as const,
		)
		manager.setMasterAgentInputHandler(() => true)

		await manager.runAgent(session, agent, testOrigin())

		expect(generateText).toHaveBeenCalledTimes(1)
		expect(runTurn).not.toHaveBeenCalled()
		expect(agent.status).toBe('failed')
	})

	it('cancels an optimistic compaction job when an agent settles', async () => {
		let signal: AbortSignal | undefined
		generateText.mockImplementation(
			({ abortSignal }: { abortSignal?: AbortSignal }) => {
				signal = abortSignal
				return new Promise(() => undefined)
			},
		)
		const message = (
			id: string,
			role: 'user' | 'assistant',
			createdAt: number,
		): AppUIMessage => ({
			id,
			role,
			metadata: { createdAt },
			parts: [{ type: 'text', text: `${NEUTRAL_TEXT} ${id}` }],
		})
		const master = createEmptyMasterAgent(1)
		const agent: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'neutral-child',
			type: 'subagent',
			status: 'running',
			timeline: [
				{
					...message('neutral-old-user', 'user', 1),
					parts: [{ type: 'text', text: NEUTRAL_TEXT.repeat(10_000) }],
				},
				message('neutral-old-assistant', 'assistant', 2),
				message('neutral-current-user', 'user', 3),
			],
		}
		agent.timeline[1].metadata!.llm = {
			usage: {
				inputTokens: 82_000,
				outputTokens: 0,
				totalTokens: 82_000,
			} as never,
		}
		master.subagents[agent.id] = agent
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'neutral-session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const store = {
			persistSession: vi.fn(async () => undefined),
			persistMetaAndIndex: vi.fn(async () => undefined),
			upsertSessionIndexItem: vi.fn(),
		}
		const factory = new MessageFactory({} as never, vi.fn())
		const coordinator = new ContextCompactionCoordinator(
			store as never,
			factory,
		)
		const compactionRequest = {
			session,
			agent,
			provider: { id: 'neutral-provider' } as never,
			model: {
				id: 'neutral-model',
				limit: { context: 100_000, output: 10_000 },
			} as never,
			revision: 'neutral-revision',
			resolveSummaryContext: async () => ({}),
			isCancelled: () => false,
			isCurrent: () => true,
		}
		expect(coordinator.inspect(compactionRequest)).toBe('ready')
		await vi.waitFor(() => expect(signal).toBeDefined())

		const manager = new TaskManager(
			{} as never,
			vi.fn(async () => undefined),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map(),
			} as never,
			{} as never,
			store as never,
			vi.fn(),
			{} as never,
			factory,
			{} as never,
			coordinator,
		)
		manager.setMasterAgentInputHandler(() => true)

		await manager.finishAgentAsCompleted(
			session,
			agent,
			NEUTRAL_TEXT,
			testOrigin(),
		)

		expect(signal!.aborted).toBe(true)
		expect(generateText).toHaveBeenCalledTimes(1)
	})
})
