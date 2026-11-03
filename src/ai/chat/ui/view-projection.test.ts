import { describe, expect, it } from 'vitest'
import type { ChatSession } from '~/ai/chat/domain'
import {
	createEmptyMasterAgent,
	uiMessagesToModelMessages,
} from '~/ai/chat/messages/ui-message'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import { buildAgentViews, buildTimeline } from './view-projection'
import { taskTool } from '~/ai/tools/task'

describe('buildTimeline', () => {
	it('projects a detached snapshot of the canonical UI message', () => {
		const master = createEmptyMasterAgent(1)
		const message = {
			id: 'message',
			role: 'assistant' as const,
			parts: [
				{
					type: 'dynamic-tool' as const,
					toolName: 'task',
					toolCallId: 'task-call',
					state: 'output-available' as const,
					input: { subagent_type: 'explorer', prompt: 'inspect file' },
					output: { taskId: 'explorer-one', status: 'dispatched' },
				},
			],
		}
		master.timeline.push(message)
		master.toolTimings['task-call'] = { startedAt: 10, finishedAt: 25 }
		master.operations.message = [
			{
				vaultPath: 'note.md',
				operation: 'update',
				before: { kind: 'file', contentBase64: 'YQ==' },
				after: { kind: 'file', contentBase64: 'Yg==' },
				toolCallId: 'task-call',
			},
		]
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const item = buildTimeline(session)[0]
		if (!item) throw new Error('Expected message item')
		expect(item.message).not.toBe(message)
		expect(item.message.parts[0]).not.toBe(message.parts[0])
		expect(item.displayBlocks[0]?.kind).toBe('tool-call')

		const block = item.displayBlocks[0]
		if (block?.kind !== 'tool-call') throw new Error('Expected tool block')
		expect(block.toolCall).toBe(item.message.parts[0])
		expect(block.toolCall.output).not.toBe(message.parts[0].output)
		expect(block.timing).toEqual({ startedAt: 10, finishedAt: 25 })
		expect(block.fileChanges).toEqual(master.operations.message)
	})

	it('does not leak message snapshots across sessions (VIEW-01)', () => {
		const makeSession = (
			id: string,
			messageId: string,
			text: string,
		): ChatSession => {
			const master = createEmptyMasterAgent(1)
			master.timeline.push({
				id: messageId,
				role: 'assistant',
				parts: [{ type: 'text', text }],
			})
			return {
				schemaVersion: 2,
				id,
				createdAt: 1,
				updatedAt: 1,
				subagents: { master },
			}
		}

		const sessionA = makeSession('session-amic', 'a-1', 'amic content')
		const firstA = buildTimeline(sessionA)
		expect(
			(firstA[0]?.message.parts[0] as { text?: string } | undefined)?.text,
		).toBe('amic content')

		// A different session must never reuse A's detached part snapshots.
		const sessionB = makeSession('session-wander', 'b-1', 'wander content')
		const timelineB = buildTimeline(sessionB)
		expect(
			(timelineB[0]?.message.parts[0] as { text?: string } | undefined)?.text,
		).toBe('wander content')

		const secondA = buildTimeline(sessionA)
		expect(
			(secondA[0]?.message.parts[0] as { text?: string } | undefined)?.text,
		).toBe('amic content')
		expect(secondA[0]?.message).not.toBe(timelineB[0]?.message)
	})

	it('reuses the cached timeline until an immutable text-part update changes it', () => {
		const master = createEmptyMasterAgent(1)
		const message: AppUIMessage = {
			id: 'message',
			role: 'assistant',
			parts: [{ type: 'text', text: 'hello' }],
		}
		master.timeline.push(message)
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}

		const first = buildTimeline(session)
		expect(buildTimeline(session)).toBe(first)

		const part = message.parts[0]
		if (part?.type !== 'text') throw new Error('Expected text part')
		message.parts[0] = { ...part, text: 'hello world' }

		const second = buildTimeline(session)
		expect(second).not.toBe(first)
		const updated = second[0]?.message.parts[0]
		if (updated?.type !== 'text') throw new Error('Expected text part')
		expect(updated.text).toBe('hello world')
	})

	it('invalidates the projection when a message operations array is replaced', () => {
		const master = createEmptyMasterAgent(1)
		const message: AppUIMessage = {
			id: 'message',
			role: 'assistant',
			parts: [
				{
					type: 'dynamic-tool',
					toolName: 'apply_patch',
					toolCallId: 'call',
					state: 'output-available',
					input: {},
					output: {},
				},
			],
		}
		master.timeline.push(message)
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}

		const first = buildTimeline(session)
		const firstBlock = first[0]?.displayBlocks[0]
		if (firstBlock?.kind !== 'tool-call') throw new Error('Expected tool block')
		expect(firstBlock.fileChanges).toBeUndefined()

		master.operations.message = [
			{
				vaultPath: 'note.md',
				operation: 'update',
				before: { kind: 'file', contentBase64: 'YQ==' },
				after: { kind: 'file', contentBase64: 'Yg==' },
				toolCallId: 'call',
			},
		]

		const second = buildTimeline(session)
		expect(second).not.toBe(first)
		const secondBlock = second[0]?.displayBlocks[0]
		if (secondBlock?.kind !== 'tool-call')
			throw new Error('Expected tool block')
		expect(secondBlock.fileChanges).toHaveLength(1)
	})

	it('reuses cached child timelines in buildAgentViews', () => {
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = createEmptyMasterAgent(2)
		child.id = 'child'
		child.type = 'explorer'
		child.timeline.push({
			id: 'child-message',
			role: 'assistant',
			parts: [{ type: 'text', text: 'child output' }],
		})
		master.subagents.child = child
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}

		const first = buildAgentViews(session)
		const second = buildAgentViews(session)
		expect(second.child?.timeline).toBe(first.child?.timeline)

		child.timeline.push({
			id: 'child-message-2',
			role: 'assistant',
			parts: [{ type: 'text', text: 'more' }],
		})
		const third = buildAgentViews(session)
		expect(third.child?.timeline).not.toBe(first.child?.timeline)
	})
	it('keeps reactive metadata out of task results sent back to the model', async () => {
		const master = createEmptyMasterAgent(1)
		const output = { taskId: 'explorer-one', status: 'dispatched' }
		master.timeline.push({
			id: 'assistant',
			role: 'assistant',
			parts: [
				{
					type: 'dynamic-tool',
					toolName: 'task',
					toolCallId: 'task-call',
					state: 'output-available',
					input: { subagent_type: 'explorer', prompt: 'inspect file' },
					output,
				},
			],
		})

		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const item = buildTimeline(session)[0]
		if (!item) throw new Error('Expected message')
		const part = item.message.parts[0]
		if (part.type !== 'dynamic-tool' || part.state !== 'output-available') {
			throw new Error('Expected completed tool call')
		}

		Object.defineProperty(part.output as object, Symbol('solid-proxy'), {
			value: {},
		})
		Object.defineProperty(part.output as object, Symbol('store-node'), {
			value: {},
		})

		expect(Reflect.ownKeys(part.output as object)).toHaveLength(4)
		expect(Reflect.ownKeys(output)).toEqual(['taskId', 'status'])

		const messages = await uiMessagesToModelMessages(master.timeline)
		const toolMessage = messages[1]
		expect(toolMessage?.role).toBe('tool')
		if (toolMessage?.role !== 'tool') throw new Error('Expected tool message')
		const result = toolMessage.content[0]
		expect(result?.type).toBe('tool-result')
		if (result?.type !== 'tool-result') throw new Error('Expected tool result')
		expect(result.output).toEqual({ type: 'json', value: output })
		expect(Reflect.ownKeys((result.output as { value: object }).value)).toEqual(
			['taskId', 'status'],
		)
	})

	it('uses the task tool model output when rebuilding model history', async () => {
		const master = createEmptyMasterAgent(1)
		master.timeline.push({
			id: 'assistant',
			role: 'assistant',
			parts: [
				{
					type: 'dynamic-tool',
					toolName: 'task',
					toolCallId: 'task-call',
					state: 'output-available',
					input: { subagent_type: 'explorer', prompt: 'inspect file' },
					output: {
						taskId: 'explorer-one',
						subagentType: 'explorer',
						status: 'dispatched',
					},
				},
			],
		})
		const messages = await uiMessagesToModelMessages(master.timeline, {
			task: taskTool,
		})
		const toolMessage = messages[1]
		if (toolMessage?.role !== 'tool') throw new Error('Expected tool message')
		const result = toolMessage.content[0]
		if (result?.type !== 'tool-result') throw new Error('Expected tool result')
		expect(result.output).toEqual({
			type: 'text',
			value: expect.stringContaining('Task dispatched. Task ID: explorer-one.'),
		})
	})
})

describe('projection cache invalidation (H5)', () => {
	function sessionWith(master: ChatAgentState): ChatSession {
		return {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
	}

	it('CT-H5-1 rebuilds when a text part is mutated in place', () => {
		const master = createEmptyMasterAgent(1)
		const part = { type: 'text' as const, text: 'hello' }
		const message: AppUIMessage = { id: 'm', role: 'assistant', parts: [part] }
		master.timeline.push(message)
		const session = sessionWith(master)
		const first = buildTimeline(session)
		expect((first[0]?.message.parts[0] as { text: string }).text).toBe('hello')

		part.text = 'hello world'

		const second = buildTimeline(session)
		expect(second).not.toBe(first)
		expect((second[0]?.message.parts[0] as { text: string }).text).toBe(
			'hello world',
		)
	})

	it('CT-H5-2 rebuilds when message metadata is mutated in place', () => {
		const master = createEmptyMasterAgent(1)
		const message: AppUIMessage = {
			id: 'm',
			role: 'assistant',
			metadata: { createdAt: 111, llm: { modelId: 'model-a' } },
			parts: [{ type: 'text', text: 'hi' }],
		}
		master.timeline.push(message)
		const session = sessionWith(master)
		const first = buildTimeline(session)
		expect(first[0]?.createdAt).toBe(111)

		const metadata = message.metadata
		if (!metadata) throw new Error('Expected metadata')
		metadata.createdAt = 999
		metadata.llm = { modelId: 'model-b' }

		const second = buildTimeline(session)
		expect(second).not.toBe(first)
		expect(second[0]?.createdAt).toBe(999)
		expect(second[0]?.message.metadata?.llm?.modelId).toBe('model-b')
	})

	it('CT-H5-3 rebuilds when message role is mutated in place', () => {
		const master = createEmptyMasterAgent(1)
		const message: AppUIMessage = {
			id: 'm',
			role: 'assistant',
			parts: [{ type: 'text', text: 'hi' }],
		}
		master.timeline.push(message)
		const session = sessionWith(master)
		const first = buildTimeline(session)
		expect(first[0]?.message.role).toBe('assistant')

		message.role = 'user'

		const second = buildTimeline(session)
		expect(second).not.toBe(first)
		expect(second[0]?.message.role).toBe('user')
	})

	it('CT-H5-4 rebuilds when the operations array is pushed in place', () => {
		const master = createEmptyMasterAgent(1)
		const message: AppUIMessage = {
			id: 'm',
			role: 'assistant',
			parts: [
				{
					type: 'dynamic-tool',
					toolName: 'apply_patch',
					toolCallId: 'call',
					state: 'output-available',
					input: {},
					output: {},
				},
			],
		}
		master.timeline.push(message)
		master.operations.m = []
		const session = sessionWith(master)
		const first = buildTimeline(session)
		const firstBlock = first[0]?.displayBlocks[0]
		if (firstBlock?.kind !== 'tool-call') throw new Error('expected tool block')
		expect(firstBlock.fileChanges).toBeUndefined()

		master.operations.m.push({
			vaultPath: 'note.md',
			operation: 'update',
			before: { kind: 'file', contentBase64: 'YQ==' },
			after: { kind: 'file', contentBase64: 'Yg==' },
			toolCallId: 'call',
		})

		const second = buildTimeline(session)
		expect(second).not.toBe(first)
		const secondBlock = second[0]?.displayBlocks[0]
		if (secondBlock?.kind !== 'tool-call')
			throw new Error('expected tool block')
		expect(secondBlock.fileChanges).toHaveLength(1)
	})
})
