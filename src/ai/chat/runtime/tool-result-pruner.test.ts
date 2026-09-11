import { describe, expect, it } from 'vitest'
import type { AppUIMessage } from '~/ai/chat/types'
import {
	pruneToolResultsForSummary,
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
})
