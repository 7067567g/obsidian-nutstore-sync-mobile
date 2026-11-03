import type { AppUIMessage, AppUIMessagePart } from '~/ai/chat/types'

/**
 * Fixed-density content token estimator.
 *
 * The previous compression path serialized UI messages to JSON and divided the
 * byte count by 3. That overprices structural JSON and binary/base64 payloads,
 * so a large image or a tool schema could dominate the estimate. This module
 * prices model-visible content instead, following the DeepSeek Harness
 * token-meter heuristic (4 chars/token, small per-block and per-role overhead).
 *
 * It is intentionally a heuristic: `resolveUsedContextTokens()` remains the
 * authoritative pressure signal when the provider reports usage. This estimator
 * is for selecting a recent-turn budget and verifying that a summary shrinks.
 */
const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4
const IMAGE_TOKEN_ESTIMATE = 85

type TextTokenEstimator = (text: string) => number

export function estimateTextTokens(text: string) {
	return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function isCjkCodePoint(code: number) {
	return (
		(code >= 0x1100 && code <= 0x11ff) ||
		(code >= 0x2e80 && code <= 0x303f) ||
		(code >= 0x3040 && code <= 0x30ff) ||
		(code >= 0x3100 && code <= 0x31bf) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xac00 && code <= 0xd7af) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0x20000 && code <= 0x2fa1f)
	)
}

/**
 * CJK-aware heuristic: CJK consumes about 2 chars/token, ASCII about 4.
 * Uses a single charCode pass; no regex arrays or full-string copies.
 */
export function estimateTextTokensCjk(text: string) {
	let cjk = 0
	let ascii = 0
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index)
		if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
			const pairCode = text.codePointAt(index)!
			if (isCjkCodePoint(pairCode)) cjk += 1
			else ascii += 1
			index += 1
			continue
		}
		if (isCjkCodePoint(code)) cjk += 1
		else ascii += 1
	}
	return Math.ceil(cjk / 2 + ascii / CHARS_PER_TOKEN)
}

function estimateJsonTokens(value: unknown, estimator: TextTokenEstimator) {
	if (value === undefined) return 0
	try {
		return estimator(JSON.stringify(value))
	} catch {
		return BLOCK_OVERHEAD
	}
}

function estimateToolOutputTokens(
	output: unknown,
	estimator: TextTokenEstimator,
) {
	if (typeof output === 'string') return estimator(output)
	if (!output || typeof output !== 'object') return 0
	const record = output as Record<string, unknown>
	if (
		(record.type === 'text' || record.type === 'error-text') &&
		typeof record.value === 'string'
	) {
		return estimator(record.value)
	}
	if (record.type === 'json' || record.type === 'error-json') {
		return estimateJsonTokens(record.value, estimator)
	}
	return estimateJsonTokens(output, estimator)
}

function estimatePartTokens(
	part: AppUIMessagePart,
	estimator: TextTokenEstimator,
): number {
	switch (part.type) {
		case 'text':
		case 'reasoning':
			return estimator(part.text) + BLOCK_OVERHEAD
		case 'dynamic-tool': {
			let tokens =
				estimator(part.toolName) +
				estimateJsonTokens(part.input, estimator) +
				BLOCK_OVERHEAD
			if (part.state === 'output-available') {
				tokens += estimateToolOutputTokens(part.output, estimator)
			} else if (part.state === 'output-error') {
				tokens += estimator(part.errorText)
			}
			return tokens
		}
		case 'data-model-file':
			return IMAGE_TOKEN_ESTIMATE + BLOCK_OVERHEAD
		case 'data-user-context': {
			let tokens = BLOCK_OVERHEAD
			for (const item of part.data.items) {
				switch (item.type) {
					case 'selection':
						tokens += estimator(item.selectedText) + BLOCK_OVERHEAD
						break
					case 'vault-path':
						tokens += estimator(item.path) + BLOCK_OVERHEAD
						break
					case 'image':
						tokens += IMAGE_TOKEN_ESTIMATE + BLOCK_OVERHEAD
						break
					case 'file':
						tokens += BLOCK_OVERHEAD
						break
					case 'pending-context':
						tokens += BLOCK_OVERHEAD
						break
				}
			}
			return tokens
		}
		case 'data-workspace-context':
			return estimateJsonTokens(part.data.deltas, estimator) + BLOCK_OVERHEAD
		case 'data-todos':
			return estimateJsonTokens(part.data.items, estimator) + BLOCK_OVERHEAD
		case 'data-system-notification':
			return estimateJsonTokens(part.data, estimator) + BLOCK_OVERHEAD
		case 'data-context-checkpoint':
			return (
				estimator(part.data.summary ?? '') +
				estimateJsonTokens(part.data, estimator) +
				BLOCK_OVERHEAD
			)
		default:
			return estimateJsonTokens(part, estimator) + BLOCK_OVERHEAD
	}
}

export function estimateMessageTokens(
	message: AppUIMessage,
	estimator: TextTokenEstimator = estimateTextTokens,
) {
	let tokens = ROLE_OVERHEAD
	for (const part of message.parts)
		tokens += estimatePartTokens(part, estimator)
	return tokens
}

export function estimateTimelineTokens(
	messages: readonly AppUIMessage[],
	estimator: TextTokenEstimator = estimateTextTokens,
) {
	let tokens = 0
	for (const message of messages) {
		tokens += estimateMessageTokens(message, estimator)
	}
	return tokens
}

export function estimateMessageTokensCjk(message: AppUIMessage) {
	return estimateMessageTokens(message, estimateTextTokensCjk)
}

export function estimateTimelineTokensCjk(messages: readonly AppUIMessage[]) {
	return estimateTimelineTokens(messages, estimateTextTokensCjk)
}
