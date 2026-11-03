import { findLatestTodos, resolveUsedContextTokens } from '~/ai/chat/domain'
import { deriveTitle } from '~/ai/chat/messages/message-utils'
import { selectContextTimeline } from '~/ai/chat/messages/ui-message'
import type { ChatAgentState } from '~/ai/chat/types'
import type { AIModelConfig } from '~/ai/core/types'
import { resolveModelOutputLimit } from '~/ai/core/inference'
import {
	type CommitContextCompressionOptions,
	type ContextCompressionResult,
	type ContextPressure,
	type CompressContextRunnerOptions,
} from './context-compression-types'
import {
	resolveCompactionLead,
	resolveContextWindow,
	resolveEstimateFallbackMargin,
	resolveModelInputLimit,
	resolveSafetyMargin,
} from './context-compression-window'
import {
	createContextCompressionPlan,
	estimateContextTokens,
	isContextCompressionPlanCurrent,
} from './context-compression-plan'
import { generateContextCompression } from './context-compression-generate'

export {
	ContextCompressionFailedError,
	type ContextCompressionPlan,
	type ContextCompressionResult,
	type ContextPressure,
	type ContextSummaryBackend,
	type SummaryToolSet,
} from './context-compression-types'
export { resolveContextWindow } from './context-compression-window'
export {
	createContextCompressionPlan,
	estimateContextTokens,
	findRecentTurnStartIndex,
	findToolPairingSafeCut,
	isContextCompressionPlanCurrent,
} from './context-compression-plan'
export {
	generateContextCompression,
	resolveSummaryContext,
} from './context-compression-generate'

function resolveLatestContextUsage(agent: ChatAgentState) {
	const contextTimeline = selectContextTimeline(agent.timeline)
	const checkpointCreatedAt = contextTimeline[0]?.parts.some(
		(part) => part.type === 'data-context-checkpoint',
	)
		? contextTimeline[0].metadata?.createdAt
		: undefined
	return [...contextTimeline]
		.reverse()
		.find(
			(message) =>
				message.role === 'assistant' &&
				message.metadata?.llm?.usage &&
				(checkpointCreatedAt === undefined ||
					(message.metadata.createdAt ?? 0) > checkpointCreatedAt),
		)?.metadata?.llm?.usage
}

export function resolveContextPressure(
	agent: ChatAgentState,
	model?: AIModelConfig,
): ContextPressure {
	const reportedTokens = resolveUsedContextTokens(
		resolveLatestContextUsage(agent),
	)
	// Providers that omit usage (common on third-party OpenAI-compatible
	// endpoints) would otherwise pin pressure at `normal` forever, so fall back
	// to the script-aware local estimate and widen the safety margin to absorb
	// its error. A reported usage always wins over the estimate.
	const usingLocalEstimate = reportedTokens <= 0
	const usedTokens = usingLocalEstimate
		? estimateContextTokens(agent)
		: reportedTokens
	if (usedTokens <= 0) return 'normal'

	const contextWindow = resolveContextWindow(model)
	const outputBudget = resolveModelOutputLimit(model) ?? 0
	const modelInputLimit = resolveModelInputLimit(model)
	const availableInputTokens = Math.max(0, contextWindow - outputBudget)
	const inputCapacity = Math.min(
		modelInputLimit ?? availableInputTokens,
		availableInputTokens,
	)
	const safetyMargin =
		resolveSafetyMargin(contextWindow) +
		(usingLocalEstimate ? resolveEstimateFallbackMargin(contextWindow) : 0)
	const hardLimit = Math.max(0, inputCapacity - safetyMargin)
	const softLimit = Math.max(
		0,
		hardLimit - resolveCompactionLead(contextWindow),
	)
	if (usedTokens >= hardLimit) return 'hard'
	return usedTokens >= softLimit ? 'soft' : 'normal'
}

/** True only when continuing without a committed summary risks the next call. */
export function shouldAutoCompressAgent(
	agent: ChatAgentState,
	model?: AIModelConfig,
) {
	return resolveContextPressure(agent, model) === 'hard'
}

/** True when background compaction should start before reaching the hard limit. */
export function shouldStartContextCompaction(
	agent: ChatAgentState,
	model?: AIModelConfig,
) {
	return resolveContextPressure(agent, model) !== 'normal'
}

/** Commit a ready summary at a runtime safe point. */
export async function commitContextCompression({
	session,
	agent,
	plan,
	summary,
	store,
	messageFactory,
}: CommitContextCompressionOptions) {
	if (!isContextCompressionPlanCurrent(plan, agent)) return false
	const todos = findLatestTodos(session)
	const todoLines = todos.map(
		(todo) => `- [${todo.status}] ${todo.content} (${todo.priority})`,
	)
	const finalSummary =
		todos.length > 0
			? [
					summary,
					'',
					'<CurrentTodoList>',
					...todoLines,
					'</CurrentTodoList>',
				].join('\n')
			: summary
	messageFactory.appendContextBoundary(session, agent, {
		mode: 'summary',
		summary: finalSummary,
		summarizedThroughMessageId: plan.summarizedThroughMessageId,
		retainedMessageIds: plan.retainedMessageIds,
	})
	store.upsertSessionIndexItem(session, deriveTitle(session))
	await store.persistSession(session)
	await store.persistMetaAndIndex()
	return true
}

/** Manual compression keeps its synchronous UX but uses the same plan/commit path. */
export async function runContextCompression({
	agent,
	store,
	messageFactory,
	...options
}: CompressContextRunnerOptions): Promise<ContextCompressionResult> {
	const plan = await createContextCompressionPlan(agent, options.model, {
		allowFullContext: true,
	})
	if (!plan) return 'unavailable'
	if (options.isCancelled?.()) return 'cancelled'
	const summary = await generateContextCompression({ ...options, plan })
	if (options.isCancelled?.()) return 'cancelled'
	if (!summary) return 'failed'
	const committed = await commitContextCompression({
		session: options.session,
		agent,
		plan,
		summary,
		store,
		messageFactory,
	})
	return committed ? 'committed' : 'stale'
}
