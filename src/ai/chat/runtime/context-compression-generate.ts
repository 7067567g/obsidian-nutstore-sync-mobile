import { generateText, type ToolSet } from 'ai'
import type { App } from 'obsidian'
import type { ChatSession } from '~/ai/chat/domain'
import type { ChatAgentState } from '~/ai/chat/types'
import { uiMessagesToModelMessages } from '~/ai/chat/messages/ui-message'
import { buildAgentSystemPrompt, COMPRESSION_PROMPT } from '~/ai/chat/prompts'
import {
	type GenerateContextCompressionOptions,
	type SummaryToolSet,
} from './context-compression-types'
import {
	DETERMINISTIC_PROTECTED_TOOLS,
	generateDeterministicSummary,
} from './deterministic-summary'
import {
	estimateTextTokensCjk,
	estimateTimelineTokensCjk,
} from './token-estimator'
import { pruneToolResultsForSummary } from './tool-result-pruner'
import type { ToolExecutor } from './tool-executor'
import { resolveSummaryOutputTokenBudget } from '~/ai/core/inference'
import {
	prepareMessagesForModel,
	resolveLanguageModel,
} from '~/ai/core/runtime'
import type { AIModelConfig } from '~/ai/core/types'

/**
 * A summary replays prior tool calls for transcript conversion only.  Its
 * tools must therefore retain schemas while dropping every executable entry
 * point, including when a manual caller supplies an unfiltered tool set.
 */
function createSummaryToolSchemas(
	tools: ToolSet | undefined,
): SummaryToolSet | undefined {
	if (!tools) return undefined
	return Object.fromEntries(
		Object.entries(tools).map(([name, tool]) => {
			const { execute: _execute, ...schema } = tool
			return [name, schema]
		}),
	)
}

/**
 * Resolve the system prompt + per-agent tools both manual and background
 * callers reuse so the summarizer request retains the main loop's prefix.
 */
export async function resolveSummaryContext(
	agent: ChatAgentState,
	session: ChatSession,
	model: AIModelConfig,
	toolExecutor: ToolExecutor,
	app: App,
): Promise<{
	system?: string
	tools?: SummaryToolSet
}> {
	try {
		const definition = toolExecutor.getAgentDefinition(agent.type)
		const [system, tools] = await Promise.all([
			buildAgentSystemPrompt(app, agent.type, session.systemPrompt),
			toolExecutor.createTools(0, definition, session, model),
		])
		return {
			system,
			tools: createSummaryToolSchemas(tools),
		}
	} catch {
		return {}
	}
}

/** Generate a summary from a frozen source plan without mutating the session. */
export async function generateContextCompression(
	options: GenerateContextCompressionOptions,
): Promise<string | undefined> {
	if (options.backend === 'deterministic') {
		return generateDeterministicSummary(options.plan.messages)
	}
	const tools = createSummaryToolSchemas(options.tools)
	const { model: languageModel } = resolveLanguageModel(
		options.provider,
		options.model.id,
		{ sessionId: options.session.id },
	)
	// Summary-only pruning: huge historical tool outputs are replayed for the
	// summarizer but are pure cost there. The live timeline and persisted session
	// keep the original outputs (diff/undo unaffected).
	const summaryMessages = pruneToolResultsForSummary(options.plan.messages, {
		dedup: true,
		purgeErrors: true,
		protectedTools: DETERMINISTIC_PROTECTED_TOOLS,
	})
	const messageSequence =
		options.buildMessages && tools
			? await options.buildMessages(summaryMessages, tools)
			: await uiMessagesToModelMessages(summaryMessages, tools)
	const preparedMessages = prepareMessagesForModel(
		options.provider,
		options.model.id,
		messageSequence,
	)
	// This instruction belongs only to the summarizer branch, never the live timeline.
	const response = await generateText<SummaryToolSet>({
		model: languageModel,
		...(options.system === undefined ? {} : { system: options.system }),
		...(tools === undefined ? {} : { tools }),
		toolChoice: 'none',
		messages: [
			...preparedMessages,
			{
				role: 'user',
				content: [{ type: 'text', text: COMPRESSION_PROMPT }],
			},
		],
		abortSignal: options.abortSignal,
		maxOutputTokens: resolveSummaryOutputTokenBudget(options.model),
	})
	if (options.isCancelled?.()) return undefined
	const summary = response.text.trim()
	if (!summary) return undefined
	// Borrowed from DeepSeek Harness compaction: a replacement that is not
	// smaller than the range it shadows would increase pressure, so reject it
	// instead of committing a non-shrinking checkpoint.
	if (
		estimateTextTokensCjk(summary) >=
		estimateTimelineTokensCjk(options.plan.messages)
	) {
		return undefined
	}
	return summary
}
