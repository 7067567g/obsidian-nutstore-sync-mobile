import type { DynamicToolUIPart } from 'ai'
import type { ChatSession } from '~/ai/chat/domain'
import { getSessionSubagents, isTerminalAgent } from '~/ai/chat/domain'
import {
	TOOL_OUTCOME_UNKNOWN,
	formatToolRecoveryText,
} from '~/ai/chat/tool-outcome'
import { isTerminalToolPart } from '~/ai/chat/messages/ui-message'
import type { ChatAgentState } from '~/ai/chat/types'

function isIncompleteToolPart(
	part: ChatAgentState['timeline'][number]['parts'][number],
): part is Extract<
	DynamicToolUIPart,
	{ state: 'input-streaming' | 'input-available' }
> &
	DynamicToolUIPart {
	return part.type === 'dynamic-tool' && !isTerminalToolPart(part)
}

/** Keep interrupted calls model-visible instead of deleting their evidence. */
function recoverIncompleteToolCalls(agent: ChatAgentState) {
	let changed = false
	for (const message of agent.timeline) {
		if (message.role !== 'assistant') continue
		let messageChanged = false
		const parts = message.parts.map((part) => {
			if (!isIncompleteToolPart(part)) return part
			const timing = agent.toolTimings[part.toolCallId]
			const now = Date.now()
			agent.toolTimings[part.toolCallId] = {
				startedAt: timing?.startedAt ?? now,
				finishedAt: now,
				outcome: TOOL_OUTCOME_UNKNOWN,
			}
			messageChanged = true
			changed = true
			const recovered: DynamicToolUIPart = {
				type: 'dynamic-tool',
				toolName: part.toolName,
				toolCallId: part.toolCallId,
				...('title' in part && part.title ? { title: part.title } : {}),
				...('toolMetadata' in part && part.toolMetadata
					? { toolMetadata: part.toolMetadata }
					: {}),
				...(part.providerExecuted === true ? { providerExecuted: true } : {}),
				...('callProviderMetadata' in part && part.callProviderMetadata
					? { callProviderMetadata: part.callProviderMetadata }
					: {}),
				state: 'output-error',
				input: 'input' in part ? part.input : null,
				errorText: formatToolRecoveryText(part.toolName, TOOL_OUTCOME_UNKNOWN),
			}
			return recovered
		})
		if (messageChanged) message.parts = parts
	}
	return changed
}

function synthesizeUnknownToolTimings(agent: ChatAgentState) {
	let changed = false
	for (const timing of Object.values(agent.toolTimings)) {
		if (timing.finishedAt !== undefined) continue
		timing.finishedAt = Date.now()
		timing.outcome = TOOL_OUTCOME_UNKNOWN
		changed = true
	}
	return changed
}

/** Runtime execution cannot resume from a persisted chat session. */
export function normalizeRehydratedExecution(session: ChatSession) {
	let changed = recoverIncompleteToolCalls(session.subagents.master)
	if (synthesizeUnknownToolTimings(session.subagents.master)) changed = true
	for (const agent of getSessionSubagents(session)) {
		if (recoverIncompleteToolCalls(agent)) changed = true
		if (synthesizeUnknownToolTimings(agent)) changed = true
		if (agent.pendingInputs.length > 0) {
			// Rehydration does not rebuild task origins or execution context, so
			// persisted continuation input would be an unconsumable orphan. Runtime
			// queued submissions live in the scheduler and never enter the session
			// file; `needs-input` resumption belongs to the #95 task-manager work.
			agent.pendingInputs = []
			changed = true
		}
		if (!isTerminalAgent(agent)) {
			agent.status = 'cancelled'
			agent.finishedAt = Date.now()
			changed = true
		}
	}
	return changed
}
