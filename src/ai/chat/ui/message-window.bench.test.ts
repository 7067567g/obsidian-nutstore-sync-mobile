import { describe, expect, it } from 'vitest'
import type {
	AppUIMessage,
	AppUIMessagePart,
	ChatDisplayBlock,
} from '~/ai/chat/types'
import type { ChatTimelineMessageItem } from './types'
import { estimateTimelineFootprint } from './message-window'

/**
 * PERF-01 local estimate. The synthetic session mirrors the 598-message
 * fixture recorded in docs/09 §4.2: alternating user turns and assistant
 * replies with reasoning + tool output. Numbers are model estimates from
 * `message-window.ts`; real-device PSS/DOM numbers stay in R8.
 */

function turnItems(index: number): ChatTimelineMessageItem[] {
	const userText: AppUIMessagePart = {
		type: 'text',
		text: `mobile long-session question ${index} `.repeat(6),
	}
	const userMessage: AppUIMessage = {
		id: `u${index}`,
		role: 'user',
		parts: [userText],
	}
	const userItem: ChatTimelineMessageItem = {
		id: `u${index}`,
		createdAt: index * 10,
		message: userMessage,
		displayBlocks: [{ kind: 'content', parts: [userText] }],
		showHeader: true,
	}

	const reasoning: AppUIMessagePart = {
		type: 'reasoning',
		text: 'reasoning '.repeat(38),
	}
	const tool: AppUIMessagePart = {
		type: 'dynamic-tool',
		toolName: 'vault_read',
		toolCallId: `call-${index}`,
		state: 'output-available',
		input: { path: `notes/${index}.md` },
		output: { text: 'tool output '.repeat(55) },
	}
	const answer: AppUIMessagePart = {
		type: 'text',
		text: `answer ${index} `.repeat(8),
	}
	const blocks: ChatDisplayBlock[] = [
		{ kind: 'reasoning', part: reasoning },
		{ kind: 'tool-call', toolCall: tool },
		{ kind: 'content', parts: [answer] },
	]
	const assistantMessage: AppUIMessage = {
		id: `a${index}`,
		role: 'assistant',
		parts: [reasoning, tool, answer],
	}
	const assistantItem: ChatTimelineMessageItem = {
		id: `a${index}`,
		createdAt: index * 10 + 1,
		message: assistantMessage,
		displayBlocks: blocks,
		showHeader: true,
	}
	return [userItem, assistantItem]
}

describe('PERF-01 local footprint estimate', () => {
	it('renders the tail page of a 598-message session within budget', () => {
		const items = Array.from({ length: 299 }, (_, index) =>
			turnItems(index),
		).flat()
		const footprint = estimateTimelineFootprint(items)
		process.stdout.write(
			`PERF-01 footprint ${JSON.stringify({
				messages: footprint.totalMessages,
				nodes: footprint.totalNodes,
				windowMessages: footprint.windowMessages,
				windowNodes: footprint.windowNodes,
				hiddenBefore: footprint.hiddenBefore,
				fullDomNodes: footprint.fullDomNodes,
				windowDomNodes: footprint.windowDomNodes,
				domNodeReduction: Number(footprint.domNodeReduction.toFixed(4)),
				fullViewBytes: footprint.fullViewBytes,
				windowViewBytes: footprint.windowViewBytes,
				viewByteReduction: Number(footprint.viewByteReduction.toFixed(4)),
				compactBytes: footprint.compactBytes,
				budgetBytes: footprint.budgetBytes,
			})}`,
		)
		expect(footprint.totalMessages).toBe(598)
		expect(footprint.windowMessages).toBeLessThanOrEqual(40)
		expect(footprint.windowDomNodes / footprint.fullDomNodes).toBeLessThan(0.1)
		expect(footprint.windowViewBytes).toBeLessThanOrEqual(footprint.budgetBytes)
		expect(footprint.compactBytes).toBeLessThan(200_000)
		expect(footprint.compactBytes).toBeLessThan(footprint.fullViewBytes / 4)
	})
})
