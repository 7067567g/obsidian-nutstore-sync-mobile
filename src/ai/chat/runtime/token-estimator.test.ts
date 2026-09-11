import { describe, expect, it } from 'vitest'
import type { AppUIMessage } from '~/ai/chat/types'
import {
	estimateMessageTokens,
	estimateTextTokens,
	estimateTimelineTokens,
} from './token-estimator'

function textMessage(text: string): AppUIMessage {
	return {
		id: 'message',
		role: 'assistant',
		parts: [{ type: 'text', text }],
	}
}

describe('token estimator', () => {
	it('prices text by the fixed character density', () => {
		expect(estimateTextTokens('a'.repeat(400))).toBe(100)
	})

	it('prices a message by its content, not its JSON envelope', () => {
		const message = textMessage('a'.repeat(400))
		expect(estimateMessageTokens(message)).toBe(108)
	})

	it('prices tool calls and string tool outputs', () => {
		const message: AppUIMessage = {
			id: 'message',
			role: 'assistant',
			parts: [
				{
					type: 'dynamic-tool',
					toolName: 'bash',
					toolCallId: 'call',
					state: 'output-available',
					input: { script: 'ls' },
					output: 'x'.repeat(400),
				},
			],
		}
		expect(estimateMessageTokens(message)).toBeGreaterThan(100)
	})

	it('prices images at a fixed estimate instead of base64 length', () => {
		const message: AppUIMessage = {
			id: 'message',
			role: 'user',
			parts: [
				{
					type: 'data-user-context',
					data: {
						items: [
							{
								type: 'image',
								hash: 'hash',
								blob: new Blob(['x'.repeat(1_000_000)]),
								mimeType: 'image/png',
								size: 1_000_000,
							},
						],
					},
				},
			],
		}
		expect(estimateMessageTokens(message)).toBeLessThan(200)
	})

	it('sums a timeline', () => {
		expect(
			estimateTimelineTokens([
				textMessage('a'.repeat(40)),
				textMessage('b'.repeat(40)),
			]),
		).toBe(18 + 18)
	})
})
