import type { ChatTimelineMessageItem } from './types'

/**
 * PERF-01 / #99 Phase1+2 conversation window.
 *
 * The previous implementation only returned `content-visibility: auto`, which
 * skips paint but keeps every block object and DOM node mounted. This module
 * implements the measurable part of the dsh design:
 *
 * 1. `CompactRecord` — bounded per-message summary (head preview, counts,
 *    estimated bytes). It never retains the full text/parts.
 * 2. `ConversationNodeAssembler` — folds message records into turn nodes and
 *    keeps stable node identities for unchanged history, so a streaming update
 *    only replaces the active (last) node.
 * 3. `TimelineWindowController` — pages from the tail ("最近 N 轮"), supports
 *    `loadEarlier()`, and evicts the oldest nodes when the retained-heap budget
 *    or page cap is exceeded.
 * 4. `estimateTimelineFootprint()` — local DOM/heap estimate used by the R4
 *    evidence report and the regression test. Real-device numbers are R8.
 */

export const WINDOWED_RENDERING_THRESHOLD = 80

/** Messages (turn nodes, not raw messages) loaded per page. */
export const DEFAULT_WINDOW_PAGE_SIZE = 20
/** Hard cap on retained pages; the heap budget normally binds first. */
export const DEFAULT_MAX_RETAINED_PAGES = 16
/**
 * Conservative retained-view budget. A full 598-message session was measured
 * at ~386 MB heap on device; the visible window must stay far below that.
 * This is a view-layer budget, not the canonical session budget.
 */
export const DEFAULT_RETAINED_HEAP_BUDGET_BYTES = 4 * 1024 * 1024
/** Preview is the only free text a compact record keeps. */
export const COMPACT_PREVIEW_CHARS = 96

export type ConversationNodeKind = 'user' | 'assistant' | 'system'

export interface CompactRecord {
	messageId: string
	role: string
	createdAt: number
	blockCount: number
	blockKinds: string[]
	textChars: number
	toolCallCount: number
	/** Bounded head text; never the full message body. */
	preview: string
	/** Estimated bytes of the full hydrated message in the view layer. */
	estimatedViewBytes: number
	/** Estimated bytes of this compact record. */
	estimatedCompactBytes: number
	/** Estimated number of DOM nodes once hydrated and mounted. */
	estimatedDomNodes: number
}

export interface ConversationNode {
	/** Stable across updates while the turn start message does not change. */
	id: string
	kind: ConversationNodeKind
	startedAt: number
	endedAt: number
	messageIds: string[]
	blockCount: number
	toolCallCount: number
	textChars: number
	preview: string
	estimatedViewBytes: number
	estimatedCompactBytes: number
	estimatedDomNodes: number
	/** Inclusive index into the timeline items. */
	startIndex: number
	/** Exclusive index into the timeline items. */
	endIndex: number
}

export interface TimelineWindowOptions {
	pageSize?: number
	maxRetainedPages?: number
	retainedHeapBudgetBytes?: number
}

export interface TimelineWindow {
	/** First retained node (0-based, inclusive). */
	startNode: number
	/** One past the last retained node. Always `totalNodes` today. */
	endNode: number
	/** Item index range of the mounted window. */
	startItem: number
	endItem: number
	totalNodes: number
	totalItems: number
	visibleNodes: number
	hiddenBefore: number
	hiddenAfter: number
	hasEarlier: boolean
	retainedBytes: number
	compactBytes: number
	budgetBytes: number
	pageSize: number
	maxRetainedPages: number
	/** Number of nodes evicted from the front by the budget/page cap. */
	trimmedNodes: number
	atBudget: boolean
}

export type TimelineFootprintOptions = TimelineWindowOptions

export interface TimelineFootprint {
	totalMessages: number
	totalNodes: number
	windowMessages: number
	windowNodes: number
	hiddenBefore: number
	hasEarlier: boolean
	fullViewBytes: number
	windowViewBytes: number
	compactBytes: number
	budgetBytes: number
	fullDomNodes: number
	windowDomNodes: number
	viewByteReduction: number
	domNodeReduction: number
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value))
}

function truncate(value: string, limit = COMPACT_PREVIEW_CHARS) {
	const normalized = value.replace(/\s+/g, ' ').trim()
	if (normalized.length <= limit) return normalized
	return `${normalized.slice(0, limit - 1)}…`
}

function estimateJsonBytes(value: unknown, depth = 0, budget = 400): number {
	if (value === null || value === undefined) return 0
	if (typeof value === 'string') return value.length * 2
	if (typeof value === 'number' || typeof value === 'boolean') return 8
	if (depth >= 4 || budget <= 0) return 32
	if (Array.isArray(value)) {
		let bytes = 16
		const limit = Math.min(value.length, 40)
		for (let index = 0; index < limit; index += 1) {
			bytes += estimateJsonBytes(value[index], depth + 1, budget - bytes)
		}
		if (value.length > limit) bytes += 16
		return bytes
	}
	if (typeof value === 'object') {
		let bytes = 32
		for (const [key, entry] of Object.entries(value)) {
			bytes += key.length * 2
			bytes += estimateJsonBytes(entry, depth + 1, budget - bytes)
			if (bytes >= budget) break
		}
		return Math.min(bytes, budget)
	}
	return 8
}

function messageTextChars(item: ChatTimelineMessageItem): number {
	let chars = 0
	for (const part of item.message.parts) {
		if (part.type === 'text' || part.type === 'reasoning') {
			chars += part.text.length
		}
	}
	return chars
}

function messagePreview(item: ChatTimelineMessageItem): string {
	for (const part of item.message.parts) {
		if (part.type === 'text' && part.text.trim()) return truncate(part.text)
		if (part.type === 'reasoning' && part.text.trim())
			return truncate(part.text)
	}
	for (const block of item.displayBlocks) {
		if (block.kind === 'content') {
			const text = block.parts
				.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join(' ')
			if (text.trim()) return truncate(text)
		}
		if (block.kind === 'tool-call')
			return truncate(`tool: ${block.toolCall.toolName}`)
		if (block.kind === 'system-notification') return 'system notification'
	}
	return ''
}

function countToolCalls(item: ChatTimelineMessageItem) {
	let count = 0
	for (const part of item.message.parts) {
		if (part.type === 'dynamic-tool') count += 1
	}
	return count
}

export function buildCompactRecord(
	item: ChatTimelineMessageItem,
): CompactRecord {
	const blockKinds = item.displayBlocks.map((block) => block.kind)
	const toolCallCount = countToolCalls(item)
	let viewBytes = 256
	viewBytes += messageTextChars(item) * 2
	viewBytes += item.displayBlocks.length * 96
	for (const part of item.message.parts) {
		if (part.type === 'dynamic-tool') {
			viewBytes += 128
			viewBytes += estimateJsonBytes(part.input)
			viewBytes += estimateJsonBytes('output' in part ? part.output : undefined)
		} else if (part.type === 'data-model-file') {
			viewBytes += 256
		} else if (part.type === 'data-user-context') {
			viewBytes += estimateJsonBytes(part.data.items)
		} else if (part.type === 'data-workspace-context') {
			viewBytes += estimateJsonBytes(part.data)
		} else if (part.type === 'data-context-checkpoint') {
			viewBytes += estimateJsonBytes(part.data)
		}
	}
	const preview = messagePreview(item)
	const compactBytes = 64 + preview.length * 2 + blockKinds.length * 8
	return {
		messageId: item.message.id,
		role: item.message.role,
		createdAt: item.createdAt,
		blockCount: item.displayBlocks.length,
		blockKinds,
		textChars: messageTextChars(item),
		toolCallCount,
		preview,
		estimatedViewBytes: viewBytes,
		estimatedCompactBytes: compactBytes,
		estimatedDomNodes: estimateMessageDomNodes(item),
	}
}

export function estimateMessageDomNodes(item: ChatTimelineMessageItem): number {
	let nodes = 6 // card + header
	for (const block of item.displayBlocks) {
		if (block.kind === 'content') {
			for (const part of block.parts) {
				if (part.type === 'text') {
					const chars = part.text.length
					nodes += 4 + Math.ceil(chars / 60) * 4
				} else {
					nodes += 4
				}
			}
		} else if (block.kind === 'reasoning') {
			nodes += 4 + Math.ceil(block.part.text.length / 80) * 3
		} else if (block.kind === 'tool-call') {
			nodes += 24
			const changes = block.fileChanges?.length ?? 0
			if (changes) nodes += Math.min(30, changes) * 2
		} else {
			nodes += 5
		}
	}
	return nodes
}

function nodeKind(role: string): ConversationNodeKind {
	if (role === 'user') return 'user'
	if (role === 'system') return 'system'
	return 'assistant'
}

function buildNode(
	records: readonly CompactRecord[],
	startIndex: number,
	endIndex: number,
): ConversationNode {
	const first = records[0]
	if (!first) throw new Error('Conversation node requires a record')
	const messageIds: string[] = []
	let blockCount = 0
	let toolCallCount = 0
	let textChars = 0
	let estimatedViewBytes = 0
	let estimatedCompactBytes = 0
	let estimatedDomNodes = 0
	let preview = ''
	for (const record of records) {
		messageIds.push(record.messageId)
		blockCount += record.blockCount
		toolCallCount += record.toolCallCount
		textChars += record.textChars
		estimatedViewBytes += record.estimatedViewBytes
		estimatedCompactBytes += record.estimatedCompactBytes
		estimatedDomNodes += record.estimatedDomNodes
		if (!preview && record.preview) preview = record.preview
	}
	return {
		id: `node:${first.messageId}`,
		kind: nodeKind(first.role),
		startedAt: first.createdAt,
		endedAt: records[records.length - 1]?.createdAt ?? first.createdAt,
		messageIds,
		blockCount,
		toolCallCount,
		textChars,
		preview,
		estimatedViewBytes,
		estimatedCompactBytes,
		estimatedDomNodes,
		startIndex,
		endIndex,
	}
}

function groupRecords(
	records: readonly CompactRecord[],
): Array<{ records: CompactRecord[]; startIndex: number; endIndex: number }> {
	const groups: Array<{
		records: CompactRecord[]
		startIndex: number
		endIndex: number
	}> = []
	let current: CompactRecord[] = []
	let currentStart = 0
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index]
		if (!record) continue
		const startsTurn =
			record.role === 'user' || (record.role === 'system' && current.length > 0)
		if (startsTurn && current.length > 0) {
			groups.push({
				records: current,
				startIndex: currentStart,
				endIndex: index,
			})
			current = []
			currentStart = index
		}
		current.push(record)
	}
	if (current.length > 0) {
		groups.push({
			records: current,
			startIndex: currentStart,
			endIndex: records.length,
		})
	}
	return groups
}

/**
 * Folds timeline items into turn nodes. Records/nodes for unchanged history are
 * reused by identity; replacing the streaming item only rebuilds the last node.
 */
export class ConversationNodeAssembler {
	private readonly recordCache = new WeakMap<
		ChatTimelineMessageItem,
		CompactRecord
	>()
	private nodes: ConversationNode[] = []
	private records: CompactRecord[] = []
	private readonly nodeRecords = new WeakMap<
		ConversationNode,
		readonly CompactRecord[]
	>()

	assemble(items: readonly ChatTimelineMessageItem[]): ConversationNode[] {
		const records = items.map((item) => this.record(item))
		this.records = records
		const groups = groupRecords(records)
		const next: ConversationNode[] = []
		for (let index = 0; index < groups.length; index += 1) {
			const group = groups[index]
			if (!group) continue
			const previous = this.nodes[index]
			if (previous && this.sameNode(previous, group)) {
				next.push(previous)
				continue
			}
			const node = buildNode(group.records, group.startIndex, group.endIndex)
			this.nodeRecords.set(node, group.records)
			next.push(node)
		}
		this.nodes = next
		return next
	}

	/**
	 * Streaming fast path: update only the active tail record/node without
	 * re-folding earlier history (mirrors dsh's active-node replace).
	 */
	replaceActive(item: ChatTimelineMessageItem): ConversationNode[] {
		const record = this.record(item)
		const lastRecord = this.records[this.records.length - 1]
		if (lastRecord && lastRecord.messageId === record.messageId) {
			this.records[this.records.length - 1] = record
		} else {
			this.records.push(record)
		}
		const groups = groupRecords(this.records)
		const tail = groups[groups.length - 1]
		const next = this.nodes.slice()
		if (!tail) {
			this.nodes = next
			return next
		}
		const rebuilt = buildNode(tail.records, tail.startIndex, tail.endIndex)
		this.nodeRecords.set(rebuilt, tail.records)
		if (next.length <= groups.length - 1) next.push(rebuilt)
		else next[groups.length - 1] = rebuilt
		this.nodes = next.slice(0, groups.length)
		return this.nodes
	}

	getNodes(): ConversationNode[] {
		return this.nodes
	}

	private record(item: ChatTimelineMessageItem): CompactRecord {
		const cached = this.recordCache.get(item)
		if (cached) return cached
		const record = buildCompactRecord(item)
		this.recordCache.set(item, record)
		return record
	}

	private sameNode(
		node: ConversationNode,
		group: { records: CompactRecord[]; startIndex: number; endIndex: number },
	) {
		if (node.startIndex !== group.startIndex) return false
		if (node.endIndex !== group.endIndex) return false
		const previous = this.nodeRecords.get(node)
		if (!previous || previous.length !== group.records.length) return false
		for (let index = 0; index < group.records.length; index += 1) {
			if (previous[index] !== group.records[index]) return false
		}
		return true
	}
}

export function shouldWindowTimeline(total: number): boolean {
	return total >= WINDOWED_RENDERING_THRESHOLD
}

/**
 * Stateful paging controller. `update()` keeps the oldest loaded node anchored
 * while new messages arrive, then applies the page cap and retained-heap budget
 * from the oldest side. The newest node is never evicted.
 */
export class TimelineWindowController {
	private readonly options: Required<TimelineWindowOptions>
	private nodes: ConversationNode[] = []
	private startNode = 0
	private initialized = false
	private trimmedByBudget = 0
	private trimmedByPages = 0

	constructor(options: TimelineWindowOptions = {}) {
		this.options = {
			pageSize: Math.max(1, options.pageSize ?? DEFAULT_WINDOW_PAGE_SIZE),
			maxRetainedPages: Math.max(
				1,
				options.maxRetainedPages ?? DEFAULT_MAX_RETAINED_PAGES,
			),
			retainedHeapBudgetBytes: Math.max(
				1,
				options.retainedHeapBudgetBytes ?? DEFAULT_RETAINED_HEAP_BUDGET_BYTES,
			),
		}
	}

	reset(): void {
		this.nodes = []
		this.startNode = 0
		this.initialized = false
		this.trimmedByBudget = 0
		this.trimmedByPages = 0
	}

	update(nodes: readonly ConversationNode[]): TimelineWindow {
		this.nodes = nodes.slice()
		const total = this.nodes.length
		if (total === 0) {
			this.startNode = 0
			this.initialized = false
			return this.snapshot(0, 0)
		}
		if (!this.initialized) {
			this.startNode = Math.max(0, total - this.options.pageSize)
			this.initialized = true
		} else if (this.startNode >= total) {
			this.startNode = Math.max(0, total - this.options.pageSize)
		}
		this.trim()
		return this.snapshot()
	}

	/** Adds one page of older nodes. Returns whether the window expanded. */
	loadEarlier(): TimelineWindow {
		this.startNode = Math.max(0, this.startNode - this.options.pageSize)
		this.trim()
		return this.snapshot()
	}

	getWindow(): TimelineWindow {
		return this.snapshot()
	}

	private trim(): void {
		const total = this.nodes.length
		if (total === 0) return
		const maxNodes = this.options.pageSize * this.options.maxRetainedPages
		if (total - this.startNode > maxNodes) {
			const nextStart = total - maxNodes
			this.trimmedByPages += Math.max(0, nextStart - this.startNode)
			this.startNode = nextStart
		}
		let bytes = this.retainedBytes()
		while (
			bytes > this.options.retainedHeapBudgetBytes &&
			this.startNode < total - 1
		) {
			bytes -= this.nodes[this.startNode]?.estimatedViewBytes ?? 0
			this.startNode += 1
			this.trimmedByBudget += 1
		}
	}

	private retainedBytes(): number {
		let bytes = 0
		for (let index = this.startNode; index < this.nodes.length; index += 1) {
			bytes += this.nodes[index]?.estimatedViewBytes ?? 0
		}
		return bytes
	}

	private snapshot(forcedStart?: number, forcedEnd?: number): TimelineWindow {
		const total = this.nodes.length
		const start =
			forcedStart ?? clamp(this.startNode, 0, Math.max(0, total - 1))
		const end = forcedEnd ?? total
		const first = this.nodes[start]
		const last = this.nodes[end - 1]
		const startItem = first?.startIndex ?? 0
		const endItem = last?.endIndex ?? 0
		let retainedBytes = 0
		let compactBytes = 0
		for (let index = 0; index < total; index += 1) {
			compactBytes += this.nodes[index]?.estimatedCompactBytes ?? 0
		}
		for (let index = start; index < end; index += 1) {
			retainedBytes += this.nodes[index]?.estimatedViewBytes ?? 0
		}
		return {
			startNode: start,
			endNode: end,
			startItem,
			endItem,
			totalNodes: total,
			totalItems: last?.endIndex ?? 0,
			visibleNodes: Math.max(0, end - start),
			hiddenBefore: startItem,
			hiddenAfter: 0,
			hasEarlier: start > 0,
			retainedBytes,
			compactBytes,
			budgetBytes: this.options.retainedHeapBudgetBytes,
			pageSize: this.options.pageSize,
			maxRetainedPages: this.options.maxRetainedPages,
			trimmedNodes: this.trimmedByBudget + this.trimmedByPages,
			atBudget:
				start > 0 &&
				(retainedBytes >= this.options.retainedHeapBudgetBytes ||
					end - start >= this.options.pageSize * this.options.maxRetainedPages),
		}
	}
}

export function estimateTimelineFootprint(
	items: readonly ChatTimelineMessageItem[],
	options: TimelineFootprintOptions = {},
): TimelineFootprint {
	const assembler = new ConversationNodeAssembler()
	const nodes = assembler.assemble(items)
	const controller = new TimelineWindowController(options)
	const window = controller.update(nodes)
	let fullViewBytes = 0
	let fullDomNodes = 0
	let windowViewBytes = 0
	let windowDomNodes = 0
	let compactBytes = 0
	for (let index = 0; index < nodes.length; index += 1) {
		const node = nodes[index]
		if (!node) continue
		fullViewBytes += node.estimatedViewBytes
		fullDomNodes += node.estimatedDomNodes
		compactBytes += node.estimatedCompactBytes
		if (index >= window.startNode && index < window.endNode) {
			windowViewBytes += node.estimatedViewBytes
			windowDomNodes += node.estimatedDomNodes
		}
	}
	return {
		totalMessages: items.length,
		totalNodes: nodes.length,
		windowMessages: window.endItem - window.startItem,
		windowNodes: window.visibleNodes,
		hiddenBefore: window.hiddenBefore,
		hasEarlier: window.hasEarlier,
		fullViewBytes,
		windowViewBytes,
		compactBytes,
		budgetBytes: window.budgetBytes,
		fullDomNodes,
		windowDomNodes,
		viewByteReduction:
			fullViewBytes > 0 ? 1 - windowViewBytes / fullViewBytes : 0,
		domNodeReduction: fullDomNodes > 0 ? 1 - windowDomNodes / fullDomNodes : 0,
	}
}
