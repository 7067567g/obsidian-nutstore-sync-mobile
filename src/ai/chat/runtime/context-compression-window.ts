import type { AIModelConfig } from '~/ai/core/types'

const FALLBACK_CONTEXT_WINDOW = 256 * 1024
const MIN_CONTEXT_SAFETY_MARGIN = 4096
const CONTEXT_SAFETY_MARGIN_RATIO = 0.05
const MIN_COMPACTION_LEAD_TOKENS = 4096
const COMPACTION_LEAD_CONTEXT_RATIO = 0.05
const RECENT_TURNS_CONTEXT_RATIO = 0.05
const MIN_RECENT_TURNS_TOKEN_BUDGET = 2048
const MAX_RECENT_TURNS_TOKEN_BUDGET = 4096 * 4
export const MAX_RECENT_TURNS = 8
/**
 * Extra headroom applied only when pressure falls back to the local estimator.
 * Providers that omit usage would otherwise pin pressure at `normal`; the local
 * estimate is script-aware but still a heuristic, so it gets a wider margin
 * than the provider-reported path.
 */
const MIN_ESTIMATE_FALLBACK_MARGIN = 8192
const ESTIMATE_FALLBACK_CONTEXT_RATIO = 0.1

/**
 * Resolve the effective context window.
 *
 * `limit.context` is authoritative when the provider metadata supplies it.
 * Some OpenAI-compatible endpoints only publish an input limit (or report a
 * zero context), so fall back to `limit.input` before the conservative default
 * rather than silently compressing a large-window model at 256K. Users can
 * always override `limit.context` in the model editor.
 */
export function resolveContextWindow(model?: AIModelConfig) {
	const configuredLimit = model?.limit?.context
	if (configuredLimit && configuredLimit > 0) return configuredLimit
	const configuredInputLimit = model?.limit?.input
	if (configuredInputLimit && configuredInputLimit > 0) {
		return configuredInputLimit
	}
	return FALLBACK_CONTEXT_WINDOW
}

export function resolveModelInputLimit(model: AIModelConfig | undefined) {
	const configuredLimit = model?.limit?.input
	return configuredLimit && configuredLimit > 0 ? configuredLimit : undefined
}

export function resolveRecentTurnsTokenBudget(contextWindow: number) {
	return Math.min(
		MAX_RECENT_TURNS_TOKEN_BUDGET,
		Math.max(
			MIN_RECENT_TURNS_TOKEN_BUDGET,
			contextWindow * RECENT_TURNS_CONTEXT_RATIO,
		),
	)
}

export function resolveSafetyMargin(contextWindow: number) {
	return Math.max(
		MIN_CONTEXT_SAFETY_MARGIN,
		Math.floor(contextWindow * CONTEXT_SAFETY_MARGIN_RATIO),
	)
}

export function resolveCompactionLead(contextWindow: number) {
	return Math.max(
		MIN_COMPACTION_LEAD_TOKENS,
		Math.floor(contextWindow * COMPACTION_LEAD_CONTEXT_RATIO),
	)
}

export function resolveEstimateFallbackMargin(contextWindow: number) {
	return Math.max(
		MIN_ESTIMATE_FALLBACK_MARGIN,
		Math.floor(contextWindow * ESTIMATE_FALLBACK_CONTEXT_RATIO),
	)
}
