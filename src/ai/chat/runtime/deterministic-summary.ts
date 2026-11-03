import type { AppUIMessage } from '~/ai/chat/types'
import {
	collectFacts,
	DETERMINISTIC_SUMMARY_MAX_ITEM_CHARS,
	DETERMINISTIC_SUMMARY_MAX_ITEMS,
	DETERMINISTIC_SUMMARY_MAX_TOKENS,
} from './deterministic-summary-facts'
import { renderSummary, renderTerse } from './deterministic-summary-render'
import {
	estimateTextTokensCjk,
	estimateTimelineTokensCjk,
} from './token-estimator'

export {
	DETERMINISTIC_PROTECTED_TOOLS,
	DETERMINISTIC_SUMMARY_MAX_ITEM_CHARS,
	DETERMINISTIC_SUMMARY_MAX_ITEMS,
	DETERMINISTIC_SUMMARY_MAX_TOKENS,
} from './deterministic-summary-facts'

/**
 * Deterministic summary backend.
 *
 * Pure local extraction of recoverable facts (user wording, paths, commands,
 * errors, todos). No network, no model, no timestamps/randomness. The caller
 * still applies the same shrink validation and checkpoint commit path as the
 * LLM backend.
 */
/**
 * Generate a deterministic summary for a frozen compression plan.
 * Returns `undefined` when the result would not shrink the region.
 */
export function generateDeterministicSummary(
	messages: readonly AppUIMessage[],
	options: {
		maxItems?: number
		maxItemChars?: number
		maxSummaryTokens?: number
		regionTokens?: number
	} = {},
): string | undefined {
	if (messages.length === 0) return undefined
	const maxItems = options.maxItems ?? DETERMINISTIC_SUMMARY_MAX_ITEMS
	const maxItemChars =
		options.maxItemChars ?? DETERMINISTIC_SUMMARY_MAX_ITEM_CHARS
	const maxSummaryTokens =
		options.maxSummaryTokens ?? DETERMINISTIC_SUMMARY_MAX_TOKENS
	const regionTokens =
		options.regionTokens ?? estimateTimelineTokensCjk(messages)
	const targetTokens = Math.min(
		maxSummaryTokens,
		Math.max(1, Math.floor(regionTokens * 0.45)),
	)
	const facts = collectFacts(messages, { maxItems, maxItemChars })
	let summary = renderSummary(facts, { maxItems, maxItemChars })
	if (estimateTextTokensCjk(summary) > targetTokens) {
		summary = renderSummary(facts, {
			maxItems: Math.min(3, maxItems),
			maxItemChars: Math.min(80, maxItemChars),
		})
	}
	if (estimateTextTokensCjk(summary) > targetTokens) {
		summary = renderTerse(
			facts,
			`确定性压缩覆盖 ${facts.scannedMessages} 条消息 / ${facts.toolCallCount} 次工具调用`,
		)
	}
	const maxChars = Math.max(1, targetTokens * 3)
	if (summary.length > maxChars) summary = summary.slice(0, maxChars).trimEnd()
	if (estimateTextTokensCjk(summary) >= regionTokens) return undefined
	return summary
}
