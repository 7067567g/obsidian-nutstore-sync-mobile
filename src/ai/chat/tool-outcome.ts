/**
 * Shared outcome vocabulary for crash recovery and semantic checkpoints.
 *
 * `unknown` is used when a side-effecting tool was dispatched but no durable
 * result exists, so recovery must not assume success or retry automatically.
 */
export const TOOL_OUTCOME_UNKNOWN = 'unknown' as const
export const TOOL_NOT_STARTED = 'not-started' as const
export const ABORTED_BEFORE_DISPATCH = 'aborted-before-dispatch' as const
export const TOOL_TIMEOUT = 'timeout' as const
export const TOOL_ABORTED = 'aborted' as const
export const TOOL_DENIED = 'denied' as const

export type ToolOutcome =
	| 'completed'
	| 'error'
	| typeof TOOL_DENIED
	| typeof TOOL_OUTCOME_UNKNOWN
	| typeof TOOL_TIMEOUT
	| typeof TOOL_ABORTED
	| typeof TOOL_NOT_STARTED
	| typeof ABORTED_BEFORE_DISPATCH

/** Tools whose execution can mutate external state and must not be retried blindly. */
export const SIDE_EFFECT_TOOL_NAMES = new Set(['bash', 'apply_patch', 'task'])

export function isSideEffectToolName(toolName: string) {
	return SIDE_EFFECT_TOOL_NAMES.has(toolName) || toolName.startsWith('mcp__')
}

export type ToolCheckpointCode =
	| typeof TOOL_NOT_STARTED
	| typeof ABORTED_BEFORE_DISPATCH

/**
 * Raised at a semantic barrier when the durable prefix or dispatch precondition
 * failed. Recovery must treat the tool as not dispatched.
 */
export class ToolCheckpointError extends Error {
	constructor(
		readonly code: ToolCheckpointCode,
		message: string,
	) {
		super(message)
		this.name = 'ToolCheckpointError'
	}
}

/**
 * Permission denial raised before a guarded tool executed. Carries a
 * machine-readable `code` so the session log can distinguish user denial
 * (`outcome: denied`) from a tool/command execution failure (`outcome: error`).
 */
export class PermissionDeniedError extends Error {
	readonly code = 'PERMISSION_DENIED'

	constructor(message: string) {
		super(message)
		this.name = 'PermissionDeniedError'
	}
}

export function isPermissionDeniedError(error: unknown): boolean {
	if (error instanceof PermissionDeniedError) return true
	if (!error || typeof error !== 'object') return false
	return (error as { code?: unknown }).code === 'PERMISSION_DENIED'
}

/** Cooperative timeout raised when a per-tool wall-clock budget expires. */
export class ToolTimeoutError extends Error {
	readonly code = TOOL_TIMEOUT

	constructor(
		readonly toolName: string,
		readonly timeoutMs: number,
	) {
		super(`${TOOL_TIMEOUT}: ${toolName} exceeded ${timeoutMs}ms`)
		this.name = 'ToolTimeoutError'
	}
}

/** User/turn abort raised while a tool was already running. */
export class ToolAbortError extends Error {
	readonly code = TOOL_ABORTED

	constructor(readonly toolName: string) {
		super(`${TOOL_ABORTED}: ${toolName} was aborted`)
		this.name = 'ToolAbortError'
	}
}

/** Model-visible recovery text for an interrupted tool call. */
export function formatToolRecoveryText(
	toolName: string,
	outcome:
		| typeof TOOL_OUTCOME_UNKNOWN
		| typeof TOOL_NOT_STARTED
		| typeof TOOL_ABORTED,
) {
	if (outcome === TOOL_NOT_STARTED) {
		return `TOOL_NOT_STARTED: ${toolName} was not dispatched.`
	}
	if (outcome === TOOL_ABORTED) {
		return `TOOL_ABORTED: ${toolName} was aborted; it may have partially mutated state. Verify external state before retrying.`
	}
	return isSideEffectToolName(toolName)
		? `TOOL_OUTCOME_UNKNOWN: ${toolName} may have started before the crash; verify external state before retrying and do not auto-retry side effects.`
		: `TOOL_OUTCOME_UNKNOWN: the result of ${toolName} is unknown after the crash; verify before retrying.`
}
