import type {
	FilePart,
	ModelMessage,
	ProviderMetadata,
	ToolCallPart,
	DynamicToolUIPart,
} from 'ai'
import type {
	AppUIMessage,
	AppUIMessagePart,
	ChatAgentState,
	ChatMessageMeta,
	ChatTodoItem,
	LegacyChatMessageRecord,
	ReversibleToolOp,
	WorkspaceContextDelta,
} from '~/ai/chat/types'
import {
	ABORTED_BEFORE_DISPATCH,
	TOOL_ABORTED,
	TOOL_NOT_STARTED,
	TOOL_OUTCOME_UNKNOWN,
	formatToolRecoveryText,
} from '~/ai/chat/tool-outcome'

function modelFilePartToDataPart(file: FilePart): AppUIMessagePart {
	return { type: 'data-model-file', data: { file } }
}

function modelPartToUIPart(part: unknown): AppUIMessagePart | undefined {
	if (!part || typeof part !== 'object') return undefined
	const value = part as Record<string, unknown>
	if (value.type === 'text') {
		return {
			type: 'text',
			text: typeof value.text === 'string' ? value.text : '',
			...(value.providerOptions
				? { providerMetadata: value.providerOptions as ProviderMetadata }
				: {}),
		}
	}
	if (value.type === 'reasoning') {
		return {
			type: 'reasoning',
			text: typeof value.text === 'string' ? value.text : '',
			state: 'done',
			...(value.providerOptions
				? { providerMetadata: value.providerOptions as ProviderMetadata }
				: {}),
		}
	}
	if (value.type === 'file') {
		return modelFilePartToDataPart(part as FilePart)
	}
	if (value.type === 'tool-call') {
		const toolCall = part as ToolCallPart
		return {
			type: 'dynamic-tool',
			toolName: toolCall.toolName,
			toolCallId: toolCall.toolCallId,
			state: 'input-available',
			input: toolCall.input,
			...(value.providerExecuted === true ? { providerExecuted: true } : {}),
			...(value.providerOptions
				? {
						callProviderMetadata: value.providerOptions as ProviderMetadata,
					}
				: {}),
		}
	}
	if (value.type === 'custom' && typeof value.kind === 'string') {
		return {
			type: 'custom',
			kind: value.kind as `${string}.${string}`,
			...(value.providerOptions
				? { providerMetadata: value.providerOptions as ProviderMetadata }
				: {}),
		}
	}
	return undefined
}

function messageContentParts(message: ModelMessage): unknown[] {
	if (typeof message.content === 'string') {
		return [{ type: 'text', text: message.content }]
	}
	return Array.isArray(message.content) ? [...message.content] : []
}

export function modelMessageToUIMessage(
	message: ModelMessage,
	options: {
		id: string
		createdAt: number
		meta?: ChatMessageMeta
		isError?: boolean
		workspaceContextDelta?: WorkspaceContextDelta[]
		userContext?: LegacyChatMessageRecord['userContext']
		todos?: ChatTodoItem[]
	},
): AppUIMessage {
	const parts = messageContentParts(message)
		.map(modelPartToUIPart)
		.filter((part): part is AppUIMessagePart => !!part)

	if (options.workspaceContextDelta?.length) {
		parts.unshift({
			type: 'data-workspace-context',
			data: { deltas: options.workspaceContextDelta },
		})
	}
	if (options.userContext?.length) {
		parts.unshift({
			type: 'data-user-context',
			data: { items: options.userContext },
		})
	}
	if (options.todos?.length) {
		parts.push({ type: 'data-todos', data: { items: options.todos } })
	}

	return {
		id: options.id,
		role: message.role === 'tool' ? 'assistant' : message.role,
		metadata: {
			createdAt: options.createdAt,
			...(options.meta ? { llm: options.meta } : {}),
			...(options.isError ? { status: 'error' as const } : {}),
		},
		parts,
	}
}

function toolOutputValue(output: unknown): unknown {
	if (!output || typeof output !== 'object') return output
	const value = output as Record<string, unknown>
	if (
		(value.type === 'text' || value.type === 'error-text') &&
		typeof value.value === 'string'
	) {
		return value.value
	}
	if (value.type === 'json' || value.type === 'error-json') return value.value
	return output
}

function legacyToolPart(
	result: Record<string, unknown>,
	toolCallId: string,
	previous: DynamicToolUIPart | undefined,
	isError: boolean,
): DynamicToolUIPart {
	const output = toolOutputValue(result.output)
	const common = {
		type: 'dynamic-tool' as const,
		toolName:
			typeof result.toolName === 'string'
				? result.toolName
				: (previous?.toolName ?? 'unknown-tool'),
		toolCallId,
		input: previous && 'input' in previous ? previous.input : undefined,
	}
	return isError
		? {
				...common,
				state: 'output-error',
				errorText:
					typeof output === 'string'
						? output
						: (JSON.stringify(output) ?? String(output)),
			}
		: { ...common, state: 'output-available', output }
}

export function mergeLegacyToolRecord(
	timeline: AppUIMessage[],
	record: LegacyChatMessageRecord,
	operations: Record<string, ReversibleToolOp[]>,
) {
	const rawParts = messageContentParts(record.message)
	const targets: AppUIMessage[] = []
	const orphanParts: DynamicToolUIPart[] = []
	for (const rawPart of rawParts) {
		if (!rawPart || typeof rawPart !== 'object') continue
		const result = rawPart as Record<string, unknown>
		if (
			result.type !== 'tool-result' ||
			typeof result.toolCallId !== 'string'
		) {
			continue
		}
		let target: AppUIMessage | undefined
		for (let index = timeline.length - 1; index >= 0; index -= 1) {
			const message = timeline[index]
			const partIndex = message.parts.findIndex(
				(part) =>
					part.type === 'dynamic-tool' && part.toolCallId === result.toolCallId,
			)
			if (partIndex < 0) continue
			const previous = message.parts[partIndex]
			if (previous.type !== 'dynamic-tool') continue
			message.parts[partIndex] = legacyToolPart(
				result,
				result.toolCallId,
				previous,
				Boolean(record.isError),
			)
			target = message
			break
		}
		if (target) {
			if (!targets.includes(target)) targets.push(target)
		} else {
			orphanParts.push(
				legacyToolPart(
					result,
					result.toolCallId,
					undefined,
					Boolean(record.isError),
				),
			)
		}
	}

	if (orphanParts.length) {
		const orphanMessage: AppUIMessage = {
			id: record.id,
			role: 'assistant',
			metadata: {
				createdAt: record.createdAt,
				...(record.isError ? { status: 'error' as const } : {}),
			},
			parts: orphanParts,
		}
		timeline.push(orphanMessage)
		targets.push(orphanMessage)
	}

	const metadataTarget = targets[targets.length - 1]
	if (metadataTarget) {
		if (record.todos?.length) {
			metadataTarget.parts.push({
				type: 'data-todos',
				data: { items: record.todos.map((todo) => ({ ...todo })) },
			})
		}
		if (record.reversibleOps?.length) {
			operations[metadataTarget.id] = [
				...(operations[metadataTarget.id] ?? []),
				...record.reversibleOps,
			]
		}
	}
}

export function getMessageText(message: AppUIMessage) {
	return message.parts
		.filter(
			(part): part is Extract<AppUIMessagePart, { type: 'text' }> =>
				part.type === 'text',
		)
		.map((part) => part.text)
		.join('\n')
}

/** Tool part states whose outcome is final and can be replayed to the model. */
export function isTerminalToolPart(
	part: Extract<AppUIMessagePart, { type: 'dynamic-tool' }>,
) {
	return (
		part.state === 'output-available' ||
		part.state === 'output-error' ||
		part.state === 'output-denied'
	)
}

/** True while any recorded tool call still lacks a terminal outcome. */
export function hasIncompleteToolCalls(agent: ChatAgentState) {
	return agent.timeline.some((message) =>
		message.parts.some(
			(part) => part.type === 'dynamic-tool' && !isTerminalToolPart(part),
		),
	)
}

/**
 * Convert every incomplete tool call into a durable terminal error part.
 *
 * UI cancellation must not delete the call. `mode: 'aborted'` records
 * `TOOL_ABORTED` when the call had a start marker, and `TOOL_NOT_STARTED`
 * otherwise. `mode: 'unknown'` is used by failure/recovery paths and records
 * `TOOL_OUTCOME_UNKNOWN` only when a start marker proves dispatch; a call that
 * never started keeps no synthetic `startedAt`.
 */
export function finalizeAbortedToolCalls(
	agent: ChatAgentState,
	mode: 'aborted' | 'unknown' = 'aborted',
) {
	let changed = false
	for (const message of agent.timeline) {
		if (message.role !== 'assistant') continue
		for (const part of message.parts) {
			if (part.type !== 'dynamic-tool' || isTerminalToolPart(part)) continue
			const timing = agent.toolTimings[part.toolCallId]
			const started = timing?.startedAt !== undefined
			const now = Date.now()
			const timingOutcome =
				mode === 'unknown'
					? started
						? TOOL_OUTCOME_UNKNOWN
						: TOOL_NOT_STARTED
					: started
						? TOOL_ABORTED
						: ABORTED_BEFORE_DISPATCH
			const recoveryOutcome =
				mode === 'unknown'
					? started
						? TOOL_OUTCOME_UNKNOWN
						: TOOL_NOT_STARTED
					: started
						? TOOL_ABORTED
						: TOOL_NOT_STARTED
			agent.toolTimings[part.toolCallId] = {
				...(started ? { startedAt: timing.startedAt } : {}),
				finishedAt: now,
				outcome: timingOutcome,
			}
			message.parts[message.parts.indexOf(part)] = {
				...part,
				state: 'output-error',
				errorText: formatToolRecoveryText(part.toolName, recoveryOutcome),
			} as AppUIMessagePart
			changed = true
		}
	}
	return changed
}

export function getWorkspaceContextDeltas(message: AppUIMessage) {
	return message.parts.flatMap((part) =>
		part.type === 'data-workspace-context' ? part.data.deltas : [],
	)
}

export function getUserContextItems(message: AppUIMessage) {
	return message.parts.flatMap((part) =>
		part.type === 'data-user-context' ? part.data.items : [],
	)
}
