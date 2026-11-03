import type { ModelMessage, ToolSet } from 'ai'
import type { ChatSession } from '~/ai/chat/domain'
import type { MessageFactory } from '~/ai/chat/messages/message-factory'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import type { AIModelConfig, AIProviderConfig } from '~/ai/core/types'

export type SummaryToolSet = ToolSet

export type ContextSummaryBackend = 'deterministic' | 'llm'

export type ContextPressure = 'normal' | 'soft' | 'hard'

/** Immutable compression source selected at the trigger point. */
export interface ContextCompressionPlan {
	summarizedThroughMessageId: string
	/** Exact source prefix identity, used to reject stale background results. */
	sourceMessageIds: string[]
	/** Exact retained suffix identity, used if the anchor is later deleted. */
	retainedMessageIds: string[]
	messages: AppUIMessage[]
}

export type ContextCompressionResult =
	| 'committed'
	| 'unavailable'
	| 'cancelled'
	| 'failed'
	| 'stale'

export class ContextCompressionFailedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ContextCompressionFailedError'
	}
}

export interface GenerateContextCompressionOptions {
	provider: AIProviderConfig
	backend?: ContextSummaryBackend
	model: AIModelConfig
	session: ChatSession
	plan: ContextCompressionPlan
	/** System prompt identical to the main loop's, so the summarizer replays the warm prefix. */
	system?: string
	/** Per-agent tool schemas, retained only to interpret the transcript. */
	tools?: SummaryToolSet
	/** Builds the source transcript exactly like the agent loop (user-context aware). */
	buildMessages?: (
		messages: AppUIMessage[],
		tools: ToolSet,
	) => Promise<ModelMessage[]>
	isCancelled?: () => boolean
	abortSignal?: AbortSignal
}

export interface CommitContextCompressionOptions {
	session: ChatSession
	agent: ChatAgentState
	plan: ContextCompressionPlan
	summary: string
	store: SessionStore
	messageFactory: MessageFactory
}

export interface CompressContextRunnerOptions extends Omit<
	GenerateContextCompressionOptions,
	'plan'
> {
	agent: ChatAgentState
	store: SessionStore
	messageFactory: MessageFactory
}
