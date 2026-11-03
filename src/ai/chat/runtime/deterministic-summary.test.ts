import { describe, expect, it } from 'vitest'
import type { AppUIMessage, ChatTodoItem } from '~/ai/chat/types'
import { generateDeterministicSummary } from './deterministic-summary'

function textMessage(
	role: 'user' | 'assistant',
	text: string,
	id = `${role}-${Math.random()}`,
): AppUIMessage {
	return {
		id,
		role,
		parts: [{ type: 'text', text }],
	} as unknown as AppUIMessage
}

function toolMessage(options: {
	toolName: string
	input: unknown
	output?: string
	errorText?: string
	id?: string
}): AppUIMessage {
	const state = options.errorText ? 'output-error' : 'output-available'
	const part = {
		type: 'dynamic-tool',
		toolName: options.toolName,
		toolCallId: options.id ?? `call-${options.toolName}`,
		state,
		input: options.input,
		...(state === 'output-available' ? { output: options.output ?? 'ok' } : {}),
		...(state === 'output-error' ? { errorText: options.errorText } : {}),
	}
	return {
		id: `message-${options.id ?? options.toolName}`,
		role: 'assistant',
		parts: [part],
	} as unknown as AppUIMessage
}

function todoMessage(items: ChatTodoItem[]): AppUIMessage {
	return {
		id: `todos-${items.length}`,
		role: 'assistant',
		parts: [{ type: 'data-todos', data: { items } }],
	} as unknown as AppUIMessage
}

describe('deterministic summary', () => {
	it('extracts verbatim facts and is stable across runs', () => {
		const messages: AppUIMessage[] = [
			textMessage('user', '请整理我的中文笔记，保留原话。', 'user-1'),
			textMessage(
				'assistant',
				'我先读取 notes/中文.md，再修改。',
				'assistant-1',
			),
			toolMessage({
				toolName: 'vault_read',
				input: { path: 'notes/中文.md' },
				output: 'ok',
				id: 'read-1',
			}),
			toolMessage({
				toolName: 'vault_batch_edit',
				input: { edits: [{ path: 'notes/中文.md' }] },
				output: 'done',
				id: 'edit-1',
			}),
			toolMessage({
				toolName: 'bash',
				input: { command: 'cat notes/中文.md' },
				output: 'Error: 权限不足',
				id: 'bash-1',
			}),
			todoMessage([
				{
					content: '完成 1.5.7 手机验收',
					status: 'in_progress',
					priority: 'high',
				},
				{
					content: '已经完成的事情',
					status: 'completed',
					priority: 'low',
				},
			]),
		]

		const first = generateDeterministicSummary(messages, {
			regionTokens: 10_000,
		})
		const second = generateDeterministicSummary(messages, {
			regionTokens: 10_000,
		})
		expect(first).toBeDefined()
		expect(second).toBe(first)
		expect(first).toContain('## User Goals')
		expect(first).toContain('## Vault Files Touched')
		expect(first).toContain('请整理我的中文笔记')
		expect(first).toContain('notes/中文.md')
		expect(first).toContain('完成 1.5.7 手机验收')
		expect(first).not.toContain('已经完成的事情')
		expect(first).toContain('Error: 权限不足')
	})

	it('carries prior checkpoint sections and current work', () => {
		const prior: AppUIMessage = {
			id: 'prior',
			role: 'user',
			parts: [
				{
					type: 'data-context-checkpoint',
					data: {
						mode: 'summary',
						summary: [
							'## User Goals',
							'- 维护 1.5.7 范围',
							'',
							'## Critical Context',
							'- 默认 deterministic',
							'',
							'## Pending Requests',
							'- 跑真机验收',
						].join('\n'),
					},
				},
			],
		} as unknown as AppUIMessage
		const messages: AppUIMessage[] = [
			prior,
			textMessage('user', '继续实现 DCP Phase1', 'user-2'),
			textMessage('assistant', '已经接好 deterministic 后端。', 'assistant-2'),
		]

		const summary = generateDeterministicSummary(messages, {
			regionTokens: 10_000,
		})
		expect(summary).toContain('维护 1.5.7 范围')
		expect(summary).toContain('默认 deterministic')
		expect(summary).toContain('跑真机验收')
		expect(summary).toContain('继续实现 DCP Phase1')
		expect(summary).toContain('已经接好 deterministic 后端。')
	})

	it('keeps earlier reasoning-only turns as explicit excerpts', () => {
		const reasoningOnly = {
			id: 'reasoning-only',
			role: 'assistant',
			metadata: { createdAt: 2 },
			parts: [
				{
					type: 'reasoning',
					text: '关键结论：1.5.7 的 retention 时序要按日志压实判据，不要按上下文压缩瞬间判。',
				},
			],
		} as unknown as AppUIMessage
		const messages: AppUIMessage[] = [
			textMessage('user', '先分析压缩时序', 'user-1'),
			reasoningOnly,
			textMessage('user', '继续检查 UI 输出', 'user-2'),
			textMessage('assistant', '已确认 reasoning 折叠问题。', 'assistant-2'),
		]

		const summary = generateDeterministicSummary(messages, {
			regionTokens: 10_000,
		})
		expect(summary).toContain('仅思考轮摘录')
		expect(summary).toContain('retention 时序要按日志压实判据')
	})

	it('folds duplicate calls but protects write-side tools', () => {
		const messages: AppUIMessage[] = [
			toolMessage({
				toolName: 'vault_read',
				input: { path: 'notes/a.md' },
				output: 'ok',
				id: 'read-1',
			}),
			toolMessage({
				toolName: 'vault_read',
				input: { path: 'notes/a.md' },
				output: 'ok',
				id: 'read-2',
			}),
			toolMessage({
				toolName: 'vault_batch_edit',
				input: { edits: [{ path: 'notes/a.md' }] },
				output: 'done',
				id: 'edit-1',
			}),
			toolMessage({
				toolName: 'vault_batch_edit',
				input: { edits: [{ path: 'notes/a.md' }] },
				output: 'done',
				id: 'edit-2',
			}),
		]

		const summary = generateDeterministicSummary(messages, {
			regionTokens: 10_000,
		})
		expect(summary).toContain('重复调用：vault_read')
		expect(summary).not.toContain('重复调用：vault_batch_edit')
	})

	it('returns undefined when the summary would not shrink the region', () => {
		const messages = [textMessage('user', '长内容', 'user-1')]
		expect(
			generateDeterministicSummary(messages, { regionTokens: 1 }),
		).toBeUndefined()
	})
})
