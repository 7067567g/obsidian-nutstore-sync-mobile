import { describe, expect, it } from 'vitest'
import type { AppUIMessage } from '~/ai/chat/types'
import {
	pruneToolResultsForSummary,
	SUMMARY_DUPLICATE_TOOL_MARKER,
	SUMMARY_ERROR_INPUT_MARKER,
	SUMMARY_TOOL_RESULT_MARKER,
} from './tool-result-pruner'

function message(id: string, output: unknown): AppUIMessage {
	return {
		id,
		role: 'assistant',
		parts: [
			{
				type: 'dynamic-tool',
				toolName: 'bash',
				toolCallId: `${id}-call`,
				state: 'output-available',
				input: {},
				output,
			},
		],
	}
}

function toolMessage(options: {
	id: string
	toolName: string
	input: unknown
	state: 'output-available' | 'output-error'
	output?: string
	errorText?: string
}): AppUIMessage {
	return {
		id: options.id,
		role: 'assistant',
		parts: [
			options.state === 'output-error'
				? {
						type: 'dynamic-tool',
						toolName: options.toolName,
						toolCallId: `${options.id}-call`,
						state: 'output-error',
						input: options.input,
						errorText: options.errorText ?? 'failed',
					}
				: {
						type: 'dynamic-tool',
						toolName: options.toolName,
						toolCallId: `${options.id}-call`,
						state: 'output-available',
						input: options.input,
						output: options.output ?? 'ok',
					},
		],
	} as unknown as AppUIMessage
}

function userMessage(id: string): AppUIMessage {
	return {
		id,
		role: 'user',
		parts: [{ type: 'text', text: 'continue' }],
	} as unknown as AppUIMessage
}

function getToolPart(messageItem: AppUIMessage) {
	const part = messageItem.parts[0]
	if (part?.type !== 'dynamic-tool') throw new Error('expected tool part')
	return part
}

describe('pruneToolResultsForSummary', () => {
	it('replaces the middle of an oversized string tool result', () => {
		const messages = [message('large', 'x'.repeat(20_000))]
		const pruned = pruneToolResultsForSummary(messages)
		const part = pruned[0]?.parts[0]
		if (part?.type !== 'dynamic-tool' || part.state !== 'output-available') {
			throw new Error('Expected completed tool part')
		}
		expect(typeof part.output).toBe('string')
		expect(part.output).toContain(SUMMARY_TOOL_RESULT_MARKER)
		expect((part.output as string).length).toBeLessThan(20_000)
		expect(pruned[0]).not.toBe(messages[0])
		expect(messages[0].parts[0]).toMatchObject({
			output: 'x'.repeat(20_000),
		})
	})

	it('leaves small or non-string results untouched', () => {
		const small = message('small', 'short output')
		const structured = message('structured', { text: 'x'.repeat(20_000) })
		const messages = [small, structured]
		expect(pruneToolResultsForSummary(messages)).toBe(messages)
		expect(pruneToolResultsForSummary(messages)[1]).toBe(structured)
	})

	it('folds older duplicate tool outputs but keeps the latest', () => {
		const messages = [
			toolMessage({
				id: 'read-1',
				toolName: 'vault_read',
				input: { path: 'notes/a.md' },
				state: 'output-available',
				output: 'old-1',
			}),
			toolMessage({
				id: 'read-2',
				toolName: 'vault_read',
				input: { path: 'notes/a.md' },
				state: 'output-available',
				output: 'old-2',
			}),
			toolMessage({
				id: 'read-3',
				toolName: 'vault_read',
				input: { path: 'notes/a.md' },
				state: 'output-available',
				output: 'latest',
			}),
		]
		const pruned = pruneToolResultsForSummary(messages, {
			dedup: true,
			protectedTools: ['vault_batch_edit'],
		})
		const parts = pruned.map(getToolPart)
		expect(parts[0]).toMatchObject({ output: SUMMARY_DUPLICATE_TOOL_MARKER })
		expect(parts[1]).toMatchObject({ output: SUMMARY_DUPLICATE_TOOL_MARKER })
		expect(parts[2]).toMatchObject({ output: 'latest' })
		expect(getToolPart(messages[0])).toMatchObject({ output: 'old-1' })
	})

	it('does not fold protected write tools or obvious bash writes', () => {
		const messages = [
			toolMessage({
				id: 'edit-1',
				toolName: 'vault_batch_edit',
				input: { edits: [{ path: 'notes/a.md' }] },
				state: 'output-available',
				output: 'done-1',
			}),
			toolMessage({
				id: 'edit-2',
				toolName: 'vault_batch_edit',
				input: { edits: [{ path: 'notes/a.md' }] },
				state: 'output-available',
				output: 'done-2',
			}),
			toolMessage({
				id: 'bash-1',
				toolName: 'bash',
				input: { script: 'echo x > notes/a.md' },
				state: 'output-available',
				output: 'done-3',
			}),
			toolMessage({
				id: 'bash-2',
				toolName: 'bash',
				input: { script: 'echo x > notes/a.md' },
				state: 'output-available',
				output: 'done-4',
			}),
		]
		const pruned = pruneToolResultsForSummary(messages, {
			dedup: true,
			protectedTools: ['vault_batch_edit'],
		})
		expect(pruned).toBe(messages)
	})

	it('purges old errored tool inputs after the configured turns', () => {
		const messages = [
			toolMessage({
				id: 'error-1',
				toolName: 'bash',
				input: { script: 'cat secret.md' },
				state: 'output-error',
				errorText: 'Error: failed',
			}),
			userMessage('user-1'),
			userMessage('user-2'),
			userMessage('user-3'),
			userMessage('user-4'),
		]
		const pruned = pruneToolResultsForSummary(messages, {
			purgeErrors: true,
			purgeErrorTurns: 4,
		})
		const part = getToolPart(pruned[0])
		expect(part).toMatchObject({
			state: 'output-error',
			errorText: 'Error: failed',
		})
		expect(JSON.stringify((part as { input: unknown }).input)).toContain(
			SUMMARY_ERROR_INPUT_MARKER,
		)
	})
})
