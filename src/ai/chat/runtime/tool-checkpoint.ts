import type { ToolSet } from 'ai'
import type { ChatSession } from '~/ai/chat/domain'
import type { SessionStore } from '~/ai/chat/session/session-store'
import {
	ABORTED_BEFORE_DISPATCH,
	TOOL_NOT_STARTED,
	ToolCheckpointError,
	isSideEffectToolName,
} from '~/ai/chat/tool-outcome'

type CheckpointStore = Pick<SessionStore, 'persistSession'>

interface ToolLike {
	execute?: (input: unknown, options: unknown) => unknown
}

/**
 * Wrap side-effecting tools so the recorded tool call is durable before the
 * tool body can run. The AI SDK swallows `onToolExecutionStart` callback
 * errors, so the barrier must live in `execute` to be fail-closed.
 */
export function createCheckpointedTools<TOOLS extends ToolSet>(
	tools: TOOLS,
	session: ChatSession,
	store: CheckpointStore,
	abortSignal?: AbortSignal,
): TOOLS {
	const guarded = {} as TOOLS
	for (const [name, tool] of Object.entries(tools)) {
		const candidate = tool as unknown as ToolLike
		if (
			typeof candidate.execute !== 'function' ||
			!isSideEffectToolName(name)
		) {
			Object.assign(guarded, { [name]: tool })
			continue
		}
		Object.assign(guarded, {
			[name]: {
				...tool,
				execute: async (input: unknown, options: unknown) => {
					try {
						await store.persistSession(session)
					} catch (error) {
						throw new ToolCheckpointError(
							TOOL_NOT_STARTED,
							`${TOOL_NOT_STARTED}: Tool checkpoint failed before ${name}: ${
								error instanceof Error ? error.message : String(error)
							}`,
						)
					}
					const signal =
						(options as { abortSignal?: AbortSignal } | undefined)
							?.abortSignal ?? abortSignal
					if (signal?.aborted) {
						throw new ToolCheckpointError(
							ABORTED_BEFORE_DISPATCH,
							`${ABORTED_BEFORE_DISPATCH}: Tool call ${name} aborted before dispatch`,
						)
					}
					return candidate.execute!(input, options)
				},
			},
		})
	}
	return guarded
}
