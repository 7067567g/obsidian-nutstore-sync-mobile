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

export function estimateTextTokens(text: string) {
	return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function estimateJsonTokens(value: unknown) {
	if (value === undefined) return 0
	try {
		return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN)
	} catch {
		return BLOCK_OVERHEAD
	}
}

function estimateToolOutputTokens(output: unknown) {
	if (typeof output === 'string') return estimateTextTokens(output)
	if (!output || typeof output !== 'object') return 0
	const record = output as Record<string, unknown>
	if (
		(record.type === 'text' || record.type === 'error-text') &&
		typeof record.value === 'string'
	) {
		return estimateTextTokens(record.value)
	}
	if (record.type === 'json' || record.type === 'error-json') {
		return estimateJsonTokens(record.value)
	}
	return estimateJsonTokens(output)
}

function estimatePartTokens(part: AppUIMessagePart): number {
	switch (part.type) {
		case 'text':
		case 'reasoning':
			return estimateTextTokens(part.text) + BLOCK_OVERHEAD
		case 'dynamic-tool': {
			let tokens =
				estimateTextTokens(part.toolName) +
				estimateJsonTokens(part.input) +
				BLOCK_OVERHEAD
			if (part.state === 'output-available') {
				tokens += estimateToolOutputTokens(part.output)
			} else if (part.state === 'output-error') {
				tokens += estimateTextTokens(part.errorText)
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
						tokens += estimateTextTokens(item.selectedText) + BLOCK_OVERHEAD
						break
					case 'vault-path':
						tokens += estimateTextTokens(item.path) + BLOCK_OVERHEAD
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
			return estimateJsonTokens(part.data.deltas) + BLOCK_OVERHEAD
		case 'data-todos':
			return estimateJsonTokens(part.data.items) + BLOCK_OVERHEAD
		case 'data-system-notification':
			return estimateJsonTokens(part.data) + BLOCK_OVERHEAD
		case 'data-context-checkpoint':
			return (
				estimateTextTokens(part.data.summary ?? '') +
				estimateJsonTokens(part.data) +
				BLOCK_OVERHEAD
			)
		default:
			return estimateJsonTokens(part) + BLOCK_OVERHEAD
	}
}

export function estimateMessageTokens(message: AppUIMessage) {
	let tokens = ROLE_OVERHEAD
	for (const part of message.parts) tokens += estimatePartTokens(part)
	return tokens
}

export function estimateTimelineTokens(messages: readonly AppUIMessage[]) {
	let tokens = 0
	for (const message of messages) tokens += estimateMessageTokens(message)
	return tokens
}
