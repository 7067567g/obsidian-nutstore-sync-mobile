import type {
	AssistantModelMessage,
	DynamicToolUIPart,
	FilePart,
	FinishReason,
	LanguageModelUsage,
	ModelMessage,
	UIMessage,
	UIMessagePart,
	UITools,
	TextPart,
	ToolCallPart,
} from 'ai'

import { z } from 'zod/mini'
import type { UserContextItem } from '~/ai/chat/context/user-context'
import type { ToolOutcome } from './tool-outcome'

type AssistantContentArray = Extract<
	AssistantModelMessage['content'],
	readonly unknown[]
>

export type ReasoningPart = Extract<
	AssistantContentArray[number],
	{ type: 'reasoning' }
>

export type ChatMessageContentPart =
	| TextPart
	| FilePart
	| ReasoningPart
	| ToolCallPart

interface ContextCheckpointData {
	mode: 'summary' | 'reset'
	summary?: string
	/**
	 * Last message represented by this summary. Newer messages remain in the
	 * model context even when the summary was generated in the background.
	 */
	summarizedThroughMessageId?: string
	/** Message ids retained outside the summary when the checkpoint was made. */
	retainedMessageIds?: string[]
	/** @deprecated Checkpoints created before snapshot compaction use this. */
	preservedTurnCount?: number
}

export interface SystemNotificationData {
	kind: 'task-result-ready'
	taskId: string
	resultPath: string
}

type ChatDataParts = {
	'workspace-context': { deltas: WorkspaceContextDelta[] }
	'user-context': { items: UserContextItem[] }
	'context-checkpoint': ContextCheckpointData
	'system-notification': SystemNotificationData
	'model-file': { file: FilePart }
	todos: { items: ChatTodoItem[] }
}

interface ChatMessageMetadata {
	createdAt: number
	llm?: ChatMessageMeta
	status?: 'error'
}

export type AppUIMessage = UIMessage<
	ChatMessageMetadata,
	ChatDataParts,
	UITools
>

export type AppUIMessagePart = UIMessagePart<ChatDataParts, UITools>

export interface ChatDisplayContentBlock {
	kind: 'content'
	parts: Array<Extract<AppUIMessagePart, { type: 'text' }> | FilePart>
}

export interface ChatDisplayReasoningBlock {
	kind: 'reasoning'
	part: Extract<AppUIMessagePart, { type: 'reasoning' }>
}

export interface ChatDisplayToolCallBlock {
	kind: 'tool-call'
	toolCall: DynamicToolUIPart
	timing?: ToolTiming
	todos?: ChatTodoItem[]
	fileChanges?: ReversibleToolOp[]
}

export interface ChatDisplaySystemNotificationBlock {
	kind: 'system-notification'
	notification: SystemNotificationData
}

export type ChatDisplayBlock =
	| ChatDisplayContentBlock
	| ChatDisplayReasoningBlock
	| ChatDisplayToolCallBlock
	| ChatDisplaySystemNotificationBlock

export interface ReversibleCompressedContent {
	compress: 'deflate'
	blob: Blob
}

export interface ReversibleSkippedSnapshot {
	/** Byte size of the file whose content was intentionally not retained. */
	size: number
	/** Why the snapshot content was omitted. */
	reason: 'too-large' | 'budget' | 'entries' | 'missing'
}

export interface ReversibleFileSnapshot {
	kind: 'file'
	contentCompressed?: ReversibleCompressedContent
	contentBase64?: string
	/**
	 * Set when the file was intentionally not read/compressed because of the
	 * mobile snapshot budget. Undo/diff for this operation is unavailable.
	 */
	skipped?: ReversibleSkippedSnapshot
}

export interface ReversibleDirSnapshot {
	kind: 'dir'
	/** Set when child contents were not traversed because of the budget. */
	skipped?: { entries: number; reason: 'entry-budget' | 'byte-budget' }
}

export type ReversibleToolOp =
	| {
			vaultPath: string
			operation: 'create'
			before: { kind: 'file' } | ReversibleDirSnapshot
			after?: ReversibleFileSnapshot | ReversibleDirSnapshot
			toolCallId?: string
	  }
	| {
			vaultPath: string
			operation: 'update'
			before: ReversibleFileSnapshot
			after?: ReversibleFileSnapshot
			toolCallId?: string
	  }
	| {
			vaultPath: string
			operation: 'delete'
			before: ReversibleFileSnapshot | ReversibleDirSnapshot
			toolCallId?: string
	  }

export type ChatRunState =
	| 'idle'
	| 'thinking'
	| 'compressing'
	| 'waiting_for_tools'

export interface ChatMessageMeta {
	providerId?: string
	providerName?: string
	modelId?: string
	modelName?: string
	usage?: LanguageModelUsage
	finishReason?: FinishReason
	responseId?: string
}

export interface WorkspaceContextDelta {
	hash: string
	key: string
	content: unknown
}

/** Persisted V1 record. Kept only for lossless on-load migration. */
export interface LegacyChatMessageRecord {
	id: string
	createdAt: number
	message: ModelMessage
	workspaceContextDelta?: WorkspaceContextDelta[]
	meta?: ChatMessageMeta
	isError?: boolean
	reversibleOps?: ReversibleToolOp[]
	userContext?: UserContextItem[]
	todos?: ChatTodoItem[]
}

export type ChatAgentStatus =
	| 'idle'
	| 'queued'
	| 'running'
	| 'completed'
	| 'failed'
	| 'cancelled'

export interface ToolTiming {
	startedAt: number
	finishedAt?: number
	/**
	 * Normal completion/error, or recovery classification (`unknown` /
	 * `not-started`) when the process was interrupted before a durable result.
	 */
	outcome?: ToolOutcome
}

export interface ChatAgentState {
	id: string
	type: string
	/** Model captured when this subagent was dispatched. */
	model?: { providerId: string; modelId: string }
	status: ChatAgentStatus
	createdAt: number
	startedAt?: number
	finishedAt?: number
	/** Persisted result artifact for a terminal task that can notify its parent. */
	resultPath?: string
	timeline: AppUIMessage[]
	/** Continuation inbox for non-master subagents; the master scheduler owns master input. */
	pendingInputs: AppUIMessage[]
	operations: Record<string, ReversibleToolOp[]>
	toolTimings: Record<string, ToolTiming>
	readVaultPaths?: string[]
	subagents: Record<string, ChatAgentState>
}

const chatTodoStatusSchema = z.enum([
	'pending',
	'in_progress',
	'completed',
	'cancelled',
])

const chatTodoPrioritySchema = z.enum(['high', 'medium', 'low'])

export const chatTodoItemSchema = z.object({
	content: z.string().check(z.trim(), z.minLength(1)),
	status: chatTodoStatusSchema,
	priority: z._default(chatTodoPrioritySchema, 'medium'),
})

export type ChatTodoStatus = z.infer<typeof chatTodoStatusSchema>
export type ChatTodoItem = z.infer<typeof chatTodoItemSchema>

export interface ChatSubmission {
	text: string
	userContext: UserContextItem[]
}
