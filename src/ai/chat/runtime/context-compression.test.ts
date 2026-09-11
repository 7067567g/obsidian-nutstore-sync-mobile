import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '~/ai/chat/domain'
import { MessageFactory } from '~/ai/chat/messages/message-factory'
import {
	createEmptyMasterAgent,
	selectContextTimeline,
} from '~/ai/chat/messages/ui-message'
import {
	createContextCompressionPlan,
	findRecentTurnStartIndex,
	generateContextCompression,
	resolveSummaryContext,
	resolveContextPressure,
	resolveContextWindow,
	runContextCompression,
	shouldAutoCompressAgent,
	shouldStartContextCompaction,
} from '~/ai/chat/runtime/context-compression'
import { COMPRESSION_PROMPT } from '~/ai/chat/prompts'
import type { AppUIMessage } from '~/ai/chat/types'

const generateText = vi.hoisted(() => vi.fn())
const buildAgentSystemPrompt = vi.hoisted(() => vi.fn())
const NEUTRAL_TEXT = 'Hello 你好 🌿'

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
vi.mock('~/ai/chat/prompts', async (importOriginal) => ({
	...(await importOriginal<typeof import('~/ai/chat/prompts')>()),
	buildAgentSystemPrompt,
}))

function message(
	id: string,
	role: 'user' | 'assistant',
	createdAt: number,
): AppUIMessage {
	return {
		id,
		role,
		metadata: { createdAt },
		parts: [{ type: 'text', text: id }],
	}
}

describe('context compression', () => {
	beforeEach(() => {
		generateText.mockReset()
		generateText.mockResolvedValue({ text: 'compressed context' })
		buildAgentSystemPrompt.mockReset()
		buildAgentSystemPrompt.mockResolvedValue('SYSTEM')
	})

	describe('tool-pairing safe cuts', () => {
		function toolMessage(
			id: string,
			createdAt: number,
			state: 'output-available' | 'input-available',
		): AppUIMessage {
			const part: AppUIMessage['parts'][number] =
				state === 'output-available'
					? {
							type: 'dynamic-tool',
							toolName: 'bash',
							toolCallId: `${id}-call`,
							state: 'output-available',
							input: {},
							output: 'ok',
						}
					: {
							type: 'dynamic-tool',
							toolName: 'bash',
							toolCallId: `${id}-call`,
							state: 'input-available',
							input: {},
						}
			return {
				id,
				role: 'assistant',
				metadata: { createdAt },
				parts: [part],
			}
		}

		it('retains an incomplete tool-call turn instead of summarizing it', async () => {
			const agent = createEmptyMasterAgent(1)
			agent.timeline = [
				message('u1', 'user', 1),
				toolMessage('a1', 2, 'output-available'),
				message('u2', 'user', 3),
				toolMessage('a2', 4, 'input-available'),
				message('u3', 'user', 5),
				message('a3', 'assistant', 6),
			]

			const plan = await createContextCompressionPlan(
				agent,
				{ id: 'model', limit: { context: 0, output: 0 } } as never,
				{ allowFullContext: true },
			)

			expect(plan?.sourceMessageIds).toEqual(['u1', 'a1'])
			expect(plan?.summarizedThroughMessageId).toBe('a1')
		})

		it('returns no plan when the first turn has an incomplete tool call', async () => {
			const agent = createEmptyMasterAgent(1)
			agent.timeline = [
				message('u1', 'user', 1),
				toolMessage('a1', 2, 'input-available'),
			]

			const plan = await createContextCompressionPlan(
				agent,
				{ id: 'model', limit: { context: 0, output: 0 } } as never,
				{ allowFullContext: true },
			)

			expect(plan).toBeUndefined()
		})
	})

	it('does not commit a checkpoint when the summarizer returns no text', async () => {
		generateText.mockResolvedValueOnce({ text: ' \n\t ' })
		const master = createEmptyMasterAgent(1)
		master.timeline = [message('neutral-user', 'user', 1)]
		master.timeline[0].parts = [{ type: 'text', text: NEUTRAL_TEXT }]
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'neutral-session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const store = {
			upsertSessionIndexItem: vi.fn(),
			persistSession: vi.fn(async () => undefined),
			persistMetaAndIndex: vi.fn(async () => undefined),
		}

		const committed = await runContextCompression({
			provider: {} as never,
			model: { id: 'neutral-model' } as never,
			session,
			agent: master,
			store: store as never,
			messageFactory: new MessageFactory({} as never, vi.fn()),
		})

		expect(committed).toBe('failed')
		expect(master.timeline.map((item) => item.id)).toEqual(['neutral-user'])
		expect(store.persistSession).not.toHaveBeenCalled()
	})

	it('inserts the summary before the recent turns that fit the token budget', async () => {
		const master = createEmptyMasterAgent(1)
		master.timeline = [
			message('u1', 'user', 1),
			message('a1', 'assistant', 2),
			message('u2', 'user', 3),
			message('a2', 'assistant', 4),
			message('u3', 'user', 5),
			message('a3', 'assistant', 6),
			message('u4', 'user', 7),
		]
		master.timeline[0].parts = [
			{ type: 'text', text: 'old context '.repeat(10_000) },
		]
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const store = {
			upsertSessionIndexItem: vi.fn(),
			persistSession: vi.fn(async () => undefined),
			persistMetaAndIndex: vi.fn(async () => undefined),
		}
		const factory = new MessageFactory({ app: {} } as never, vi.fn())

		await runContextCompression({
			provider: {} as never,
			model: { id: 'model' } as never,
			session,
			agent: master,
			store: store as never,
			messageFactory: factory,
		})

		expect(master.timeline.map((item) => item.id)).toEqual([
			'u1',
			'a1',
			'u2',
			'a2',
			'u3',
			'a3',
			'u4',
			expect.stringMatching(/^checkpoint/),
		])
		const selected = selectContextTimeline(master.timeline)
		expect(selected.slice(1).map((item) => item.id)).toEqual([
			'u2',
			'a2',
			'u3',
			'a3',
			'u4',
		])
		expect(selected[0].parts[0]).toMatchObject({
			type: 'data-context-checkpoint',
			data: {
				mode: 'summary',
				summary: 'compressed context',
				summarizedThroughMessageId: 'a1',
				retainedMessageIds: ['u2', 'a2', 'u3', 'a3', 'u4'],
			},
		})
	})

	it('preserves more short turns and always keeps an oversized current turn', async () => {
		const shortTurns = [
			message('u1', 'user', 1),
			message('a1', 'assistant', 2),
			message('u2', 'user', 3),
			message('a2', 'assistant', 4),
			message('u3', 'user', 5),
		]
		expect(await findRecentTurnStartIndex(shortTurns, 2048)).toBe(0)

		const oversizedCurrentTurn = message('current', 'user', 6)
		oversizedCurrentTurn.parts = [
			{ type: 'text', text: 'large request '.repeat(10_000) },
		]
		expect(
			await findRecentTurnStartIndex(
				[...shortTurns, oversizedCurrentTurn],
				2048,
			),
		).toBe(shortTurns.length)
	})

	it('resolves preserved turns recursively across appended checkpoints', () => {
		const checkpoint = (
			id: string,
			preservedTurnCount: number,
		): AppUIMessage => ({
			id,
			role: 'user',
			metadata: { createdAt: 10 },
			parts: [
				{
					type: 'data-context-checkpoint',
					data: {
						mode: 'summary',
						summary: id,
						preservedTurnCount,
					},
				},
			],
		})
		const timeline = [
			message('u1', 'user', 1),
			message('a1', 'assistant', 2),
			checkpoint('c1', 1),
			message('u2', 'user', 3),
			message('a2', 'assistant', 4),
			checkpoint('c2', 2),
			message('u3', 'user', 5),
		]

		expect(selectContextTimeline(timeline).map((item) => item.id)).toEqual([
			'c2',
			'u1',
			'a1',
			'u2',
			'a2',
			'u3',
		])
	})

	it('ignores usage from retained turns until a new response is generated', () => {
		const agent = createEmptyMasterAgent(1)
		const checkpoint: AppUIMessage = {
			id: 'checkpoint',
			role: 'user',
			metadata: { createdAt: 100 },
			parts: [
				{
					type: 'data-context-checkpoint',
					data: { mode: 'summary', summary: 'summary' },
				},
			],
		}
		const oldAssistant = message('old-assistant', 'assistant', 50)
		oldAssistant.metadata!.llm = {
			usage: {
				inputTokens: 220_000,
				outputTokens: 0,
				totalTokens: 220_000,
			} as never,
		}
		agent.timeline = [checkpoint, oldAssistant]

		expect(
			shouldAutoCompressAgent(agent, { limit: { context: 100_000 } } as never),
		).toBe(false)

		const newAssistant = message('new-assistant', 'assistant', 101)
		newAssistant.metadata!.llm = {
			usage: {
				inputTokens: 220_000,
				outputTokens: 0,
				totalTokens: 220_000,
			} as never,
		}
		agent.timeline.push(newAssistant)
		expect(
			shouldAutoCompressAgent(agent, { limit: { context: 100_000 } } as never),
		).toBe(true)
	})

	it('starts background compaction before the hard input limit', () => {
		const agent = createEmptyMasterAgent(1)
		const assistant = message('assistant', 'assistant', 1)
		assistant.metadata!.llm = {
			usage: {
				inputTokens: 500_000,
				outputTokens: 40_000,
				totalTokens: 540_000,
			} as never,
		}
		agent.timeline = [assistant]

		expect(
			resolveContextPressure(agent, {
				limit: { context: 1_000_000, output: 384_000 },
			} as never),
		).toBe('soft')
		expect(
			shouldStartContextCompaction(agent, {
				limit: { context: 1_000_000, output: 384_000 },
			} as never),
		).toBe(true)
		expect(
			shouldAutoCompressAgent(agent, {
				limit: { context: 1_000_000, output: 384_000 },
			} as never),
		).toBe(false)
	})

	it('reaches the hard limit after reserving the model output limit', () => {
		const agent = createEmptyMasterAgent(1)
		const assistant = message('assistant', 'assistant', 1)
		assistant.metadata!.llm = {
			usage: {
				inputTokens: 870_000,
				outputTokens: 47_232,
				totalTokens: 917_232,
			} as never,
		}
		agent.timeline = [assistant]

		expect(
			shouldAutoCompressAgent(agent, {
				limit: { context: 1_000_000, output: 384_000 },
			} as never),
		).toBe(true)
	})

	it('rejects a summary that does not shrink the compacted range', async () => {
		generateText.mockResolvedValueOnce({ text: 'x'.repeat(2000) })
		const plan = {
			summarizedThroughMessageId: 'u1',
			sourceMessageIds: ['u1'],
			retainedMessageIds: [],
			messages: [
				{
					id: 'u1',
					role: 'user',
					metadata: { createdAt: 1 },
					parts: [{ type: 'text', text: 'small' }],
				},
			],
		}

		const summary = await generateContextCompression({
			provider: {} as never,
			model: { id: 'model' } as never,
			session: {} as never,
			plan: plan as never,
			tools: {} as never,
		})

		expect(summary).toBeUndefined()
	})
	it('prunes oversized historical tool results before summarizing', async () => {
		generateText.mockResolvedValueOnce({ text: 'short summary' })
		const plan = {
			summarizedThroughMessageId: 'tool-message',
			sourceMessageIds: ['tool-message'],
			retainedMessageIds: [],
			messages: [
				{
					id: 'tool-message',
					role: 'assistant',
					metadata: { createdAt: 1 },
					parts: [
						{
							type: 'dynamic-tool',
							toolName: 'bash',
							toolCallId: 'tool-call',
							state: 'output-available',
							input: {},
							output: 'x'.repeat(20_000),
						},
					],
				},
			],
		}

		const summary = await generateContextCompression({
			provider: {} as never,
			model: { id: 'model' } as never,
			session: {} as never,
			plan: plan as never,
			tools: {} as never,
		})

		expect(summary).toBe('short summary')
		const request = generateText.mock.calls.at(-1)?.[0] as {
			messages: unknown[]
		}
		const serialized = JSON.stringify(request.messages)
		expect(serialized).toContain('tool result middle omitted')
		expect(serialized).not.toContain('x'.repeat(20_000))
	})

	it('forwards shared tool schemas but never execution or tool context to the summarizer', async () => {
		const master = createEmptyMasterAgent(1)
		master.timeline = [message('u1', 'user', 1)]
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const store = {
			upsertSessionIndexItem: vi.fn(),
			persistSession: vi.fn(async () => undefined),
			persistMetaAndIndex: vi.fn(async () => undefined),
		}
		const factory = new MessageFactory({} as never, vi.fn())
		const execute = vi.fn()
		const tools = { bash: { execute } } as never

		await runContextCompression({
			provider: {} as never,
			model: { id: 'model' } as never,
			session,
			agent: master,
			store: store as never,
			messageFactory: factory,
			system: 'SYSTEM',
			tools,
		})

		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				system: 'SYSTEM',
				tools: { bash: {} },
				toolChoice: 'none',
			}),
		)
		expect(generateText).toHaveBeenCalledWith(
			expect.not.objectContaining({ toolsContext: expect.anything() }),
		)
		expect(execute).not.toHaveBeenCalled()
	})

	it('exposes tool schemas without execution capabilities to the summarizer', async () => {
		const master = createEmptyMasterAgent(1)
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const definition = { id: 'master' } as never
		const executeTask = vi.fn()
		const executeWrite = vi.fn()
		const result = await resolveSummaryContext(
			master,
			session,
			{ id: 'model' } as never,
			{
				getAgentDefinition: vi.fn(() => definition),
				createTools: vi.fn(async () => ({
					task: { execute: executeTask },
					apply_patch: { execute: executeWrite },
				})),
			} as never,
			{} as never,
		)

		expect(result).toMatchObject({ system: 'SYSTEM' })
		expect(result.tools?.task?.execute).toBeUndefined()
		expect(result.tools?.apply_patch?.execute).toBeUndefined()
		expect(executeTask).not.toHaveBeenCalled()
		expect(executeWrite).not.toHaveBeenCalled()
	})

	it('uses the independent summary output budget', async () => {
		const master = createEmptyMasterAgent(1)
		master.timeline = [message('u1', 'user', 1)]
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const store = {
			upsertSessionIndexItem: vi.fn(),
			persistSession: vi.fn(async () => undefined),
			persistMetaAndIndex: vi.fn(async () => undefined),
		}
		const factory = new MessageFactory({} as never, vi.fn())

		await runContextCompression({
			provider: {} as never,
			model: {
				id: 'model',
				limit: { context: 1_000_000, output: 384_000 },
			} as never,
			session,
			agent: master,
			store: store as never,
			messageFactory: factory,
		})

		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({ maxOutputTokens: 16_384 }),
		)
	})

	it('keeps the compaction instruction as a separate final user message', async () => {
		const master = createEmptyMasterAgent(1)
		master.timeline = [
			message('u1', 'user', 1),
			message('a1', 'assistant', 2),
			message('u2', 'user', 3),
		]
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const store = {
			upsertSessionIndexItem: vi.fn(),
			persistSession: vi.fn(async () => undefined),
			persistMetaAndIndex: vi.fn(async () => undefined),
		}
		const factory = new MessageFactory({} as never, vi.fn())

		await runContextCompression({
			provider: {} as never,
			model: { id: 'model' } as never,
			session,
			agent: master,
			store: store as never,
			messageFactory: factory,
		})

		const callArgs = generateText.mock.calls.at(-1)![0] as {
			messages: Array<{
				role: string
				content: Array<{ type: string; text: string }>
			}>
		}
		const roles = callArgs.messages.map((message) => message.role)
		expect(roles).toEqual(['user', 'assistant', 'user', 'user'])
		const last = callArgs.messages.at(-1)!
		expect(last).toMatchObject({ role: 'user' })
		expect(last.content[0]).toMatchObject({
			type: 'text',
			text: COMPRESSION_PROMPT,
		})
	})

	it('uses buildMessages when both tools and a builder are provided', async () => {
		const master = createEmptyMasterAgent(1)
		master.timeline = [message('u1', 'user', 1)]
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const store = {
			upsertSessionIndexItem: vi.fn(),
			persistSession: vi.fn(async () => undefined),
			persistMetaAndIndex: vi.fn(async () => undefined),
		}
		const factory = new MessageFactory({} as never, vi.fn())
		const buildMessages = vi.fn(
			async () =>
				[{ role: 'user', content: [{ type: 'text', text: 'BUILT' }] }] as never,
		)

		await runContextCompression({
			provider: {} as never,
			model: { id: 'model' } as never,
			session,
			agent: master,
			store: store as never,
			messageFactory: factory,
			tools: {} as never,
			buildMessages: buildMessages as never,
		})

		expect(buildMessages).toHaveBeenCalledTimes(1)
		const callArgs = generateText.mock.calls.at(-1)![0] as {
			messages: Array<{
				role: string
				content: Array<{ type: string; text: string }>
			}>
		}
		expect(callArgs.messages.map((m) => m.content[0].text)).toEqual([
			'BUILT',
			COMPRESSION_PROMPT,
		])
	})
})

describe('resolveContextWindow', () => {
	it('prefers an explicit context limit', () => {
		expect(
			resolveContextWindow({
				limit: { context: 1_000_000, output: 8192 },
			} as never),
		).toBe(1_000_000)
	})

	it('falls back to the input limit when context metadata is missing', () => {
		expect(
			resolveContextWindow({
				limit: { context: 0, input: 131_072, output: 8192 },
			} as never),
		).toBe(131_072)
	})

	it('keeps the conservative default when no limit is published', () => {
		expect(
			resolveContextWindow({
				limit: { context: 0, output: 0 },
			} as never),
		).toBe(256 * 1024)
	})
})
