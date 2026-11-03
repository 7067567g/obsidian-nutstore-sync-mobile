import {
	convertToModelMessages,
	type FilePart,
	type ModelMessage,
	type TextPart,
	type ToolSet,
	type UserModelMessage,
} from 'ai'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import { MASTER_AGENT_ID } from '~/ai/chat/agents/registry'
import { CHECKPOINT_PREAMBLE } from '~/ai/chat/prompts'
import type { UserContextManager } from '~/ai/chat/context/user-context-manager'
import { getUserContextItems } from './ui-message-projection'

export {
	modelMessageToUIMessage,
	mergeLegacyToolRecord,
	getMessageText,
	isTerminalToolPart,
	hasIncompleteToolCalls,
	finalizeAbortedToolCalls,
	getWorkspaceContextDeltas,
	getUserContextItems,
} from './ui-message-projection'

function findLastContextCheckpointIndex(messages: AppUIMessage[]) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (
			messages[index].parts.some(
				(part) => part.type === 'data-context-checkpoint',
			)
		) {
			return index
		}
	}
	return -1
}

export function selectContextTimeline(
	messages: AppUIMessage[],
): AppUIMessage[] {
	const checkpointIndex = findLastContextCheckpointIndex(messages)
	if (checkpointIndex < 0) return messages
	const checkpointMessage = messages[checkpointIndex]
	const checkpoint = checkpointMessage.parts.find(
		(part) => part.type === 'data-context-checkpoint',
	)
	if (checkpoint?.type !== 'data-context-checkpoint') return messages
	if (checkpoint.data.mode === 'reset') {
		return messages.slice(checkpointIndex + 1)
	}
	if (checkpoint.data.summarizedThroughMessageId) {
		const priorContext = selectContextTimeline(
			messages.slice(0, checkpointIndex),
		)
		const summarizedThroughIndex = priorContext.findIndex(
			(message) => message.id === checkpoint.data.summarizedThroughMessageId,
		)
		if (summarizedThroughIndex < 0) {
			const retainedIds = checkpoint.data.retainedMessageIds
			const retainedMessages = retainedIds
				? retainedIds.flatMap((id) => {
						const retained = priorContext.find((message) => message.id === id)
						return retained ? [retained] : []
					})
				: priorContext
			return [
				checkpointMessage,
				...retainedMessages,
				...messages.slice(checkpointIndex + 1),
			]
		}
		return [
			checkpointMessage,
			...priorContext.slice(summarizedThroughIndex + 1),
			...messages.slice(checkpointIndex + 1),
		]
	}
	if (checkpoint.data.preservedTurnCount === undefined) {
		return messages.slice(checkpointIndex)
	}

	const priorContext: AppUIMessage[] = selectContextTimeline(
		messages.slice(0, checkpointIndex),
	)
	let remainingTurns = checkpoint.data.preservedTurnCount
	let preservedStart = priorContext.length
	for (let index = priorContext.length - 1; index >= 0; index -= 1) {
		const message = priorContext[index]
		if (
			message.role !== 'user' ||
			message.parts.some((part) => part.type === 'data-context-checkpoint')
		) {
			continue
		}
		remainingTurns -= 1
		preservedStart = index
		if (remainingTurns === 0) break
	}
	return [
		checkpointMessage,
		...priorContext.slice(preservedStart),
		...messages.slice(checkpointIndex + 1),
	]
}

export async function uiMessagesToModelMessages(
	messages: AppUIMessage[],
	tools?: ToolSet,
) {
	return convertToModelMessages<AppUIMessage>(messages, {
		tools,
		convertDataPart(part): TextPart | FilePart | undefined {
			if (part.type === 'data-workspace-context') {
				return {
					type: 'text',
					text: `<AdditionalContext>${JSON.stringify(
						Object.fromEntries(
							part.data.deltas.map((entry) => [entry.key, entry.content]),
						),
					)}</AdditionalContext>`,
				}
			}
			if (part.type === 'data-context-checkpoint') {
				if (part.data.mode === 'reset' || !part.data.summary) return undefined
				return {
					type: 'text',
					text: `<ConversationSummary>\n${CHECKPOINT_PREAMBLE}\n\n${part.data.summary}\n</ConversationSummary>`,
				}
			}
			if (part.type === 'data-system-notification') {
				return {
					type: 'text',
					text: `<SystemNotification>${JSON.stringify(part.data)}</SystemNotification>`,
				}
			}
			if (part.type === 'data-model-file') {
				return part.data.file
			}
			return undefined
		},
	})
}

export function consumePendingInputs(agent: ChatAgentState) {
	const inputs = agent.pendingInputs.splice(0)
	agent.timeline.push(...inputs)
	return inputs.length > 0
}

export function assertMasterPendingInputsEmpty(agent: ChatAgentState) {
	if (agent.id === MASTER_AGENT_ID && agent.pendingInputs.length > 0) {
		throw new Error('Master agent pendingInputs must remain empty')
	}
}

/**
 * Build the model message transcript exactly as the agent loop does — the
 * shared builder behind both main turns and the compression summarizer call,
 * so both requests carry the same byte-for-byte prefix.
 */
export async function buildAgentMessages(
	agent: ChatAgentState,
	tools: ToolSet,
	userContextManager: UserContextManager,
	timeline = selectContextTimeline(agent.timeline),
): Promise<ModelMessage[]> {
	const messages = await Promise.all(
		timeline.map(async (item) => {
			const converted = await uiMessagesToModelMessages([item], tools)
			if (item.role !== 'user' || converted.length === 0) return converted
			const modelMessage = converted[0]
			const userContext = getUserContextItems(item)
			const dedupedContext = userContext.length
				? userContextManager.dedupeUserContextItems(userContext)
				: []
			const contextParts =
				await userContextManager.buildMessagePartsFromUserContext(
					dedupedContext,
				)
			if (!contextParts.length) return converted
			const userContent = Array.isArray(modelMessage.content)
				? (modelMessage as UserModelMessage).content
				: []
			return [
				{
					...modelMessage,
					content: [...contextParts, ...userContent],
				} as ModelMessage,
			]
		}),
	)
	return messages.flat()
}

export function createEmptyMasterAgent(createdAt: number): ChatAgentState {
	return {
		id: MASTER_AGENT_ID,
		type: MASTER_AGENT_ID,
		status: 'idle',
		createdAt,
		timeline: [],
		pendingInputs: [],
		operations: {},
		toolTimings: {},
		subagents: {},
	}
}
