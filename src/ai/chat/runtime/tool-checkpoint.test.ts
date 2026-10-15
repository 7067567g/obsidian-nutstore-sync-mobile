import { simulateReadableStream, streamText, tool, type ToolSet } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/mini'
import {
	ABORTED_BEFORE_DISPATCH,
	TOOL_NOT_STARTED,
	ToolCheckpointError,
} from '~/ai/chat/tool-outcome'
import { createCheckpointedTools } from './tool-checkpoint'

const session = { id: 'session' } as never

function makeStore() {
	return {
		persistSession: vi.fn(async () => undefined),
	}
}

function makeTools(execute: ReturnType<typeof vi.fn>) {
	return {
		bash: tool({
			description: 'probe side effect',
			inputSchema: z.object({}),
			execute,
		}),
		view_image: tool({
			description: 'read only',
			inputSchema: z.object({}),
			execute,
		}),
	} as ToolSet
}

describe('createCheckpointedTools', () => {
	it('persists before a side-effecting tool body and preserves the result', async () => {
		const order: string[] = []
		const execute = vi.fn(async () => {
			order.push('body')
			return 'probe-result'
		})
		const store = makeStore()
		store.persistSession.mockImplementation(async () => {
			order.push('persist')
		})
		const guarded = createCheckpointedTools(makeTools(execute), session, store)
		await expect(
			guarded.bash!.execute!({} as never, {} as never),
		).resolves.toBe('probe-result')
		expect(store.persistSession).toHaveBeenCalledWith(session)
		expect(order).toEqual(['persist', 'body'])
		expect(execute).toHaveBeenCalledTimes(1)
	})

	it('does not run the tool body when the checkpoint fails', async () => {
		const execute = vi.fn(async () => 'probe-result')
		const store = makeStore()
		store.persistSession.mockRejectedValueOnce(new Error('disk full'))
		const guarded = createCheckpointedTools(makeTools(execute), session, store)
		await expect(
			guarded.bash!.execute!({} as never, {} as never),
		).rejects.toMatchObject({
			code: TOOL_NOT_STARTED,
		} satisfies Partial<ToolCheckpointError>)
		expect(execute).not.toHaveBeenCalled()
	})

	it('does not run the tool body when aborted before dispatch', async () => {
		const execute = vi.fn(async () => 'probe-result')
		const store = makeStore()
		const controller = new AbortController()
		controller.abort()
		const guarded = createCheckpointedTools(
			makeTools(execute),
			session,
			store,
			controller.signal,
		)
		await expect(
			guarded.bash!.execute!({} as never, {} as never),
		).rejects.toMatchObject({
			code: ABORTED_BEFORE_DISPATCH,
		} satisfies Partial<ToolCheckpointError>)
		expect(store.persistSession).toHaveBeenCalledWith(session)
		expect(execute).not.toHaveBeenCalled()
	})

	it('leaves read-only tools unwrapped', async () => {
		const execute = vi.fn(async () => 'view-result')
		const store = makeStore()
		const guarded = createCheckpointedTools(makeTools(execute), session, store)
		await expect(
			guarded.view_image!.execute!({} as never, {} as never),
		).resolves.toBe('view-result')
		expect(store.persistSession).not.toHaveBeenCalled()
		expect(execute).toHaveBeenCalledTimes(1)
	})

	it('keeps the AI SDK tool body blocked when the checkpoint fails (probe integration)', async () => {
		const execute = vi.fn(async () => 'probe-result')
		const store = makeStore()
		store.persistSession.mockRejectedValueOnce(new Error('disk full'))
		const guarded = createCheckpointedTools(makeTools(execute), session, store)
		const model = new MockLanguageModelV4({
			provider: 'test',
			modelId: 'test',
			doStream: async () => ({
				stream: simulateReadableStream({
					chunks: [
						{ type: 'stream-start', warnings: [] },
						{ type: 'tool-input-start', id: 'tool-1', toolName: 'bash' },
						{ type: 'tool-input-delta', id: 'tool-1', delta: '{}' },
						{ type: 'tool-input-end', id: 'tool-1' },
						{
							type: 'tool-call',
							toolCallId: 'call-1',
							toolName: 'bash',
							input: '{}',
						},
						{
							type: 'finish',
							finishReason: { unified: 'tool-calls', raw: undefined },
							usage: {
								inputTokens: {
									total: 3,
									noCache: 3,
									cacheRead: undefined,
									cacheWrite: undefined,
								},
								outputTokens: {
									total: 0,
									text: 0,
									reasoning: undefined,
								},
							},
						},
					],
				}),
			}),
		})

		const result = streamText({
			model,
			tools: guarded,
			prompt: 'run the probe',
		})

		await result.text
		expect(execute).not.toHaveBeenCalled()
	})
})
