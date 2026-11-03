import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import type { AIModelConfig } from '~/ai/core/types'
import { selectContextTimeline } from '~/ai/chat/messages/ui-message'
import type { ContextCompressionPlan } from './context-compression-types'
import {
	MAX_RECENT_TURNS,
	resolveContextWindow,
	resolveRecentTurnsTokenBudget,
} from './context-compression-window'
import { estimateTimelineTokensCjk } from './token-estimator'

function isContextCheckpoint(message: AppUIMessage) {
	return message.parts.some((part) => part.type === 'data-context-checkpoint')
}

function isIncompleteToolCall(part: AppUIMessage['parts'][number]) {
	return (
		part.type === 'dynamic-tool' &&
		part.state !== 'output-available' &&
		part.state !== 'output-error' &&
		part.state !== 'output-denied'
	)
}

function findFirstIncompleteToolCallIndex(
	messages: readonly AppUIMessage[],
	end: number,
) {
	for (let index = 0; index < end; index += 1) {
		if (messages[index]?.parts.some(isIncompleteToolCall)) return index
	}
	return -1
}

function findPreviousUserTurnStart(
	messages: readonly AppUIMessage[],
	index: number,
) {
	for (let current = index; current >= 0; current -= 1) {
		const message = messages[current]
		if (message?.role === 'user' && !isContextCheckpoint(message)) {
			return current
		}
	}
	return 0
}

/**
 * Move a proposed cut earlier until every summarized message is tool-pairing
 * balanced: an incomplete tool call must be retained, not replayed to the
 * summarizer without its result. Borrowed from the Harness compaction
 * `tool-pairing` invariant; returns 0 when no safe prefix exists.
 */
export function findToolPairingSafeCut(
	messages: readonly AppUIMessage[],
	cut: number,
) {
	let next = cut
	while (next > 0) {
		const openIndex = findFirstIncompleteToolCallIndex(messages, next)
		if (openIndex === -1) return next
		const turnStart = findPreviousUserTurnStart(messages, openIndex)
		if (turnStart >= next) return 0
		next = turnStart
	}
	return next
}

/** Stable local estimate used only to verify that compaction made progress. */
export function estimateContextTokens(agent: ChatAgentState) {
	return estimateTimelineTokensCjk(selectContextTimeline(agent.timeline))
}

export async function findRecentTurnStartIndex(
	messages: AppUIMessage[],
	tokenBudget: number,
) {
	const turnStarts = messages.flatMap((message, index) =>
		message.role === 'user' && !isContextCheckpoint(message) ? [index] : [],
	)
	if (turnStarts.length === 0) {
		const firstConversationMessage = messages.findIndex(
			(message) => !isContextCheckpoint(message),
		)
		return firstConversationMessage < 0
			? messages.length
			: firstConversationMessage
	}

	let firstPreservedTurn = turnStarts.at(-1)!
	let preservedTokens = 0
	let preservedTurns = 0
	for (let turn = turnStarts.length - 1; turn >= 0; turn -= 1) {
		const start = turnStarts[turn]
		const end = turnStarts[turn + 1] ?? messages.length
		const turnTokens = estimateTimelineTokensCjk(messages.slice(start, end))
		if (
			preservedTurns > 0 &&
			(preservedTurns >= MAX_RECENT_TURNS ||
				preservedTokens + turnTokens > tokenBudget)
		) {
			break
		}
		firstPreservedTurn = start
		preservedTokens += turnTokens
		preservedTurns += 1
	}
	return firstPreservedTurn
}

/**
 * Select a completed prefix to summarize. The selected message ids are stable
 * even if new turns arrive while the remote summarizer is running.
 */
export async function createContextCompressionPlan(
	agent: ChatAgentState,
	model: AIModelConfig,
	options: { allowFullContext?: boolean } = {},
): Promise<ContextCompressionPlan | undefined> {
	const contextTimeline = selectContextTimeline(agent.timeline)
	if (contextTimeline.length === 0) return undefined
	const preservedTurnIndex = await findRecentTurnStartIndex(
		contextTimeline,
		resolveRecentTurnsTokenBudget(resolveContextWindow(model)),
	)
	const proposedCut =
		preservedTurnIndex > 0
			? preservedTurnIndex
			: options.allowFullContext
				? contextTimeline.length
				: 0
	const summaryEndIndex =
		proposedCut > 0
			? findToolPairingSafeCut(contextTimeline, proposedCut)
			: proposedCut
	if (summaryEndIndex === 0) return undefined

	const messages = contextTimeline.slice(0, summaryEndIndex)
	const summarizedThroughMessageId = messages.at(-1)?.id
	if (!summarizedThroughMessageId) return undefined
	return {
		summarizedThroughMessageId,
		sourceMessageIds: messages.map((message) => message.id),
		retainedMessageIds: contextTimeline
			.slice(summaryEndIndex)
			.map((message) => message.id),
		messages,
	}
}

export function isContextCompressionPlanCurrent(
	plan: ContextCompressionPlan,
	agent: ChatAgentState,
) {
	const currentPrefix = selectContextTimeline(agent.timeline).slice(
		0,
		plan.sourceMessageIds.length,
	)
	return (
		currentPrefix.length === plan.sourceMessageIds.length &&
		currentPrefix.every(
			(message, index) => message.id === plan.sourceMessageIds[index],
		)
	)
}
