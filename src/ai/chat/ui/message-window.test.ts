import { describe, expect, it } from 'vitest'
import type {
	AppUIMessage,
	AppUIMessagePart,
	ChatDisplayBlock,
} from '~/ai/chat/types'
import type { ChatTimelineMessageItem } from './types'
import {
	COMPACT_PREVIEW_CHARS,
	ConversationNodeAssembler,
	DEFAULT_WINDOW_PAGE_SIZE,
	TimelineWindowController,
	WINDOWED_RENDERING_THRESHOLD,
	buildCompactRecord,
	estimateTimelineFootprint,
	shouldWindowTimeline,
} from './message-window'

function textItem(
	id: string,
	role: 'user' | 'assistant' | 'system',
	text: string,
	createdAt = 1,
): ChatTimelineMessageItem {
	const part: AppUIMessagePart = { type: 'text', text }
	const block: ChatDisplayBlock = { kind: 'content', parts: [part] }
	const message: AppUIMessage = { id, role, parts: [part] }
	return {
		id,
		createdAt,
		message,
		displayBlocks: [block],
		showHeader: true,
	}
}

function toolItem(
	id: string,
	outputChars: number,
	createdAt = 1,
): ChatTimelineMessageItem {
	const toolPart: AppUIMessagePart = {
		type: 'dynamic-tool',
		toolName: 'vault_read',
		toolCallId: `call-${id}`,
		state: 'output-available',
		input: { path: 'notes/a.md' },
		output: { text: 'x'.repeat(outputChars) },
	}
	const reasoningPart: AppUIMessagePart = {
		type: 'reasoning',
		text: 'r'.repeat(300),
	}
	const textPart: AppUIMessagePart = {
		type: 'text',
		text: 'assistant reply '.repeat(10),
	}
	const blocks: ChatDisplayBlock[] = [
		{ kind: 'reasoning', part: reasoningPart },
		{ kind: 'tool-call', toolCall: toolPart },
		{ kind: 'content', parts: [textPart] },
	]
	const message: AppUIMessage = {
		id,
		role: 'assistant',
		parts: [reasoningPart, toolPart, textPart],
	}
	return {
		id,
		createdAt,
		message,
		displayBlocks: blocks,
		showHeader: true,
	}
}

function firstNode(nodes: ReturnType<ConversationNodeAssembler['assemble']>) {
	const node = nodes[0]
	if (!node) throw new Error('Expected a conversation node')
	return node
}

describe('message window threshold', () => {
	it('enables windowing only above the configured threshold', () => {
		expect(shouldWindowTimeline(WINDOWED_RENDERING_THRESHOLD - 1)).toBe(false)
		expect(shouldWindowTimeline(WINDOWED_RENDERING_THRESHOLD)).toBe(true)
	})
})

describe('compact records', () => {
	it('keeps only a bounded preview instead of the full body', () => {
		const item = textItem('m1', 'assistant', 'y'.repeat(50_000))
		const record = buildCompactRecord(item)
		expect(record.preview.length).toBeLessThanOrEqual(COMPACT_PREVIEW_CHARS)
		expect(record.preview.endsWith('…')).toBe(true)
		expect(record.estimatedCompactBytes).toBeLessThan(1_000)
		expect(record.textChars).toBe(50_000)
		expect(record.estimatedViewBytes).toBeGreaterThan(90_000)
	})

	it('counts tool calls and estimates DOM nodes from display blocks', () => {
		const record = buildCompactRecord(toolItem('tool', 800))
		expect(record.toolCallCount).toBe(1)
		expect(record.blockKinds).toEqual(['reasoning', 'tool-call', 'content'])
		expect(record.estimatedDomNodes).toBeGreaterThan(20)
	})
})

describe('conversation node assembler', () => {
	it('groups a user turn with its assistant reply and keeps item ranges', () => {
		const assembler = new ConversationNodeAssembler()
		const items = [
			textItem('u1', 'user', 'hello'),
			textItem('a1', 'assistant', 'hi there'),
			textItem('u2', 'user', 'again'),
			textItem('a2', 'assistant', 'second reply'),
		]
		const nodes = assembler.assemble(items)
		expect(nodes).toHaveLength(2)
		expect(firstNode(nodes)).toMatchObject({
			id: 'node:u1',
			kind: 'user',
			messageIds: ['u1', 'a1'],
			startIndex: 0,
			endIndex: 2,
		})
		expect(nodes[1]).toMatchObject({
			id: 'node:u2',
			kind: 'user',
			messageIds: ['u2', 'a2'],
			startIndex: 2,
			endIndex: 4,
		})
	})

	it('reuses unchanged node identities when a message is appended', () => {
		const assembler = new ConversationNodeAssembler()
		const items = [
			textItem('u1', 'user', 'hello'),
			textItem('a1', 'assistant', 'hi'),
		]
		const first = assembler.assemble(items)
		const second = assembler.assemble([
			...items,
			textItem('u2', 'user', 'more'),
		])
		expect(firstNode(second)).toBe(firstNode(first))
		expect(second).toHaveLength(2)
	})

	it('rebuilds the active node when equal-length text changes', () => {
		const assembler = new ConversationNodeAssembler()
		const items = [
			textItem('u1', 'user', 'hello'),
			textItem('a1', 'assistant', 'AAAA'),
		]
		const before = assembler.assemble(items)
		const next = assembler.assemble([
			items[0] as ChatTimelineMessageItem,
			textItem('a1', 'assistant', 'BBBB'),
		])
		expect(next[0]).not.toBe(before[0])
		expect(next[0]?.messageIds).toEqual(['u1', 'a1'])
		expect(next[0]?.preview).toBe('hello')
	})

	it('replaces only the active streaming node', () => {
		const assembler = new ConversationNodeAssembler()
		const items = [
			textItem('u1', 'user', 'hello'),
			textItem('a1', 'assistant', 'partial'),
			textItem('u2', 'user', 'again'),
			textItem('a2', 'assistant', 'working'),
		]
		const nodes = assembler.assemble(items)
		const history = firstNode(nodes)
		const streaming = textItem('a2', 'assistant', 'working and now complete')
		const next = assembler.replaceActive(streaming)
		expect(firstNode(next)).toBe(history)
		expect(next).toHaveLength(2)
		const tail = next[1]
		if (!tail) throw new Error('Expected tail node')
		expect(tail.messageIds).toEqual(['u2', 'a2'])
		expect(tail.textChars).toBe(
			'again'.length + 'working and now complete'.length,
		)
		expect(assembler.getNodes()).toHaveLength(2)
	})
})

describe('timeline window controller', () => {
	function nodes(count: number) {
		const assembler = new ConversationNodeAssembler()
		return assembler.assemble(
			Array.from({ length: count }, (_, index) =>
				textItem(`m${index}`, 'user', `message ${index}`),
			),
		)
	}

	it('starts at the tail page and reports hidden history', () => {
		const controller = new TimelineWindowController({ pageSize: 10 })
		const window = controller.update(nodes(100))
		expect(window.startItem).toBe(90)
		expect(window.endItem).toBe(100)
		expect(window.hiddenBefore).toBe(90)
		expect(window.hasEarlier).toBe(true)
		expect(window.visibleNodes).toBe(10)
	})

	it('loads one earlier page at a time and keeps the tail', () => {
		const controller = new TimelineWindowController({ pageSize: 10 })
		controller.update(nodes(60))
		const earlier = controller.loadEarlier()
		expect(earlier.startItem).toBe(40)
		expect(earlier.endItem).toBe(60)
		expect(earlier.visibleNodes).toBe(20)
		expect(earlier.hasEarlier).toBe(true)
		const top = controller.loadEarlier()
		expect(top.startItem).toBe(30)
		expect(top.visibleNodes).toBe(30)
	})

	it('stops loading earlier at the first message', () => {
		const controller = new TimelineWindowController({ pageSize: 10 })
		controller.update(nodes(25))
		expect(controller.loadEarlier().startItem).toBe(5)
		expect(controller.loadEarlier().startItem).toBe(0)
		expect(controller.loadEarlier().startItem).toBe(0)
		const window = controller.getWindow()
		expect(window.hasEarlier).toBe(false)
		expect(window.hiddenBefore).toBe(0)
	})

	it('evicts the oldest nodes when the retained budget is exceeded', () => {
		const controller = new TimelineWindowController({
			pageSize: 10,
			maxRetainedPages: 16,
			retainedHeapBudgetBytes: 900,
		})
		const window = controller.update(nodes(50))
		expect(window.retainedBytes).toBeLessThanOrEqual(900)
		expect(window.startItem).toBeGreaterThan(40)
		expect(window.endItem).toBe(50)
		expect(window.trimmedNodes).toBeGreaterThan(0)
		expect(window.hasEarlier).toBe(true)
	})

	it('never evicts the newest node even if it alone exceeds the budget', () => {
		const controller = new TimelineWindowController({
			pageSize: 10,
			retainedHeapBudgetBytes: 1,
		})
		const window = controller.update(nodes(5))
		expect(window.startItem).toBe(4)
		expect(window.endItem).toBe(5)
		expect(window.visibleNodes).toBe(1)
	})

	it('keeps the oldest loaded page anchored while new messages stream in', () => {
		const controller = new TimelineWindowController({ pageSize: 10 })
		controller.update(nodes(30))
		expect(controller.loadEarlier().startItem).toBe(10)
		const updated = controller.update(nodes(31))
		expect(updated.startItem).toBe(10)
		expect(updated.endItem).toBe(31)
	})

	it('resets back to the tail page for a new session', () => {
		const controller = new TimelineWindowController({ pageSize: 10 })
		controller.update(nodes(100))
		controller.loadEarlier()
		controller.reset()
		const window = controller.update(nodes(10))
		expect(window.startItem).toBe(0)
		expect(window.hasEarlier).toBe(false)
	})
})

describe('timeline footprint estimate', () => {
	function syntheticSession(turns: number) {
		const items: ChatTimelineMessageItem[] = []
		for (let index = 0; index < turns; index += 1) {
			items.push(
				textItem(
					`u${index}`,
					'user',
					`question ${index} `.repeat(6),
					index * 10,
				),
				toolItem(`a${index}`, 600, index * 10 + 1),
			)
		}
		return items
	}

	it('keeps a 598-message session inside the page and heap budget', () => {
		const footprint = estimateTimelineFootprint(syntheticSession(299))
		expect(footprint.totalMessages).toBe(598)
		expect(footprint.totalNodes).toBe(299)
		expect(footprint.windowMessages).toBeLessThanOrEqual(
			DEFAULT_WINDOW_PAGE_SIZE * 2,
		)
		expect(footprint.hiddenBefore).toBeGreaterThan(0)
		expect(footprint.windowViewBytes).toBeLessThanOrEqual(footprint.budgetBytes)
		expect(footprint.domNodeReduction).toBeGreaterThan(0.85)
		expect(footprint.viewByteReduction).toBeGreaterThan(0.85)
		expect(footprint.compactBytes).toBeLessThan(footprint.fullViewBytes / 4)
	})
})
