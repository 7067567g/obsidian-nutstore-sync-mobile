import type { AppUIMessage, AppUIMessagePart } from '~/ai/chat/types'

/**
 * Summary-only deterministic tool-result pruning.
 *
 * Long tool outputs are useful for the live agent loop and the UI, but they are
 * pure cost when the context summarizer replays old history. This helper makes
 * a pruned *copy* of the plan messages for the summarizer only: the live
 * timeline, persisted session, and undo/diff data are untouched.
 *
 * Two optional passes borrowed from opencode-dcp / dsh-dcp:
 * - dedup: fold older identical tool calls in the summary copy;
 * - purgeErrors: drop the input of old errored tool calls while keeping the
 *   error text.
 * Both passes are conservative: write-side tools and obvious bash writes are
 * protected, and anything too large for a signature is not folded.
 */

export const SUMMARY_TOOL_RESULT_THRESHOLD_CHARS = 8192
export const SUMMARY_TOOL_RESULT_HEAD_CHARS = 4096
export const SUMMARY_TOOL_RESULT_TAIL_CHARS = 1024
export const SUMMARY_TOOL_RESULT_MARKER =
	'\n\n[... tool result middle omitted for context compression ...]\n\n'
export const SUMMARY_DUPLICATE_TOOL_MARKER =
	'[duplicate tool result omitted for context compression]'
export const SUMMARY_ERROR_INPUT_MARKER =
	'[errored tool input omitted for context compression]'

const MAX_SIGNATURE_INPUT_CHARS = 16_384

export interface SummaryPruneOptions {
	dedup?: boolean
	purgeErrors?: boolean
	/** Number of user turns after which an errored call loses its input. */
	purgeErrorTurns?: number
	protectedTools?: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stableToolInputKey(value: unknown, depth = 0): string {
	if (depth > 4) return '"[depth]"'
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableToolInputKey(item, depth + 1)).join(',')}]`
	}
	if (isRecord(value)) {
		const keys = Object.keys(value).sort()
		return `{${keys
			.map(
				(key) =>
					`${JSON.stringify(key)}:${stableToolInputKey(value[key], depth + 1)}`,
			)
			.join(',')}}`
	}
	if (typeof value === 'string') return JSON.stringify(value)
	return String(value)
}

function extractCommandStrings(value: unknown, depth = 0): string[] {
	if (depth > 3 || !isRecord(value)) return []
	const commands: string[] = []
	for (const [key, nested] of Object.entries(value)) {
		const normalizedKey = key.toLowerCase()
		if (
			normalizedKey === 'command' ||
			normalizedKey === 'cmd' ||
			normalizedKey === 'script'
		) {
			if (typeof nested === 'string') commands.push(nested)
			continue
		}
		if (isRecord(nested) || Array.isArray(nested)) {
			commands.push(...extractCommandStrings(nested, depth + 1))
		}
	}
	return commands
}

function isObviousBashWrite(input: unknown) {
	for (const command of extractCommandStrings(input)) {
		if (
			command.includes('>') ||
			/\b(tee|rm|mv|cp|mkdir|touch|truncate|dd)\b/i.test(command) ||
			/\bsed\s+-i\b/i.test(command)
		) {
			return true
		}
	}
	return false
}

function isProtectedToolCall(
	part: Extract<AppUIMessagePart, { type: 'dynamic-tool' }>,
	protectedTools: ReadonlySet<string>,
) {
	if (protectedTools.has(part.toolName)) return true
	return part.toolName === 'bash' && isObviousBashWrite(part.input)
}

function toolCallSignature(
	part: Extract<AppUIMessagePart, { type: 'dynamic-tool' }>,
	protectedTools: ReadonlySet<string>,
) {
	if (part.state !== 'output-available' && part.state !== 'output-error') {
		return undefined
	}
	if (isProtectedToolCall(part, protectedTools)) return undefined
	let serialized: string
	try {
		serialized = stableToolInputKey(part.input)
	} catch {
		return undefined
	}
	if (serialized.length > MAX_SIGNATURE_INPUT_CHARS) return undefined
	return `${part.toolName}:${serialized}`
}

function cloneMessageAt(messages: AppUIMessage[], index: number) {
	const current = messages[index]
	if (!current) return undefined
	if (messages[index] === current) {
		messages[index] = { ...current, parts: [...current.parts] }
	}
	return messages[index]
}

function clonePartAt(
	messages: AppUIMessage[],
	messageIndex: number,
	partIndex: number,
) {
	const message = cloneMessageAt(messages, messageIndex)
	if (!message) return undefined
	const part = message.parts[partIndex]
	if (!part) return undefined
	return { message, part }
}

function dedupToolResults(
	messages: AppUIMessage[],
	protectedTools: ReadonlySet<string>,
) {
	const lastBySignature = new Map<string, { message: number; part: number }>()
	for (
		let messageIndex = 0;
		messageIndex < messages.length;
		messageIndex += 1
	) {
		const parts = messages[messageIndex].parts
		for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
			const part = parts[partIndex]
			if (part.type !== 'dynamic-tool') continue
			const signature = toolCallSignature(part, protectedTools)
			if (!signature) continue
			lastBySignature.set(signature, { message: messageIndex, part: partIndex })
		}
	}
	if (lastBySignature.size === 0) return undefined

	const next = [...messages]
	let changed = false
	for (
		let messageIndex = 0;
		messageIndex < messages.length;
		messageIndex += 1
	) {
		const parts = messages[messageIndex].parts
		for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
			const part = parts[partIndex]
			if (part.type !== 'dynamic-tool') continue
			const signature = toolCallSignature(part, protectedTools)
			if (!signature) continue
			const last = lastBySignature.get(signature)
			if (!last || (last.message === messageIndex && last.part === partIndex)) {
				continue
			}
			const clone = clonePartAt(next, messageIndex, partIndex)
			if (!clone) continue
			if (part.state === 'output-error') {
				clone.message.parts[partIndex] = {
					...part,
					errorText: SUMMARY_DUPLICATE_TOOL_MARKER,
				}
			} else if (part.state === 'output-available') {
				clone.message.parts[partIndex] = {
					...part,
					output: SUMMARY_DUPLICATE_TOOL_MARKER,
				}
			}
			changed = true
		}
	}
	return changed ? next : undefined
}

function purgeErroredInputs(
	messages: AppUIMessage[],
	protectedTools: ReadonlySet<string>,
	purgeErrorTurns: number,
) {
	const userMessageIndices = messages.flatMap((message, index) =>
		message.role === 'user' ? [index] : [],
	)
	const next = [...messages]
	let changed = false
	for (
		let messageIndex = 0;
		messageIndex < messages.length;
		messageIndex += 1
	) {
		const parts = messages[messageIndex].parts
		for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
			const part = parts[partIndex]
			if (
				part.type !== 'dynamic-tool' ||
				part.state !== 'output-error' ||
				isProtectedToolCall(part, protectedTools)
			) {
				continue
			}
			const turnsAfter = userMessageIndices.filter(
				(index) => index > messageIndex,
			).length
			if (turnsAfter < purgeErrorTurns) continue
			const clone = clonePartAt(next, messageIndex, partIndex)
			if (!clone) continue
			clone.message.parts[partIndex] = {
				...part,
				input: { omitted: SUMMARY_ERROR_INPUT_MARKER },
			}
			changed = true
		}
	}
	return changed ? next : undefined
}

function pruneToolOutputText(text: string) {
	const points = Array.from(text)
	if (points.length <= SUMMARY_TOOL_RESULT_THRESHOLD_CHARS) return undefined
	const head = points.slice(0, SUMMARY_TOOL_RESULT_HEAD_CHARS).join('')
	const tail = points.slice(-SUMMARY_TOOL_RESULT_TAIL_CHARS).join('')
	const pruned = `${head}${SUMMARY_TOOL_RESULT_MARKER}${tail}`
	return pruned.length < text.length ? pruned : undefined
}

/**
 * Replace oversized string tool results in a *copy* of the plan messages.
 *
 * Only completed `dynamic-tool` parts with a string output are considered.
 * Non-string outputs (structured JSON, images, etc.) are left untouched so the
 * summarizer still sees their original shape.
 */
export function pruneToolResultsForSummary(
	messages: AppUIMessage[],
	options: SummaryPruneOptions = {},
): AppUIMessage[] {
	const protectedTools = new Set(options.protectedTools ?? [])
	let current = messages
	if (options.dedup) {
		current = dedupToolResults(current, protectedTools) ?? current
	}
	if (options.purgeErrors) {
		current =
			purgeErroredInputs(
				current,
				protectedTools,
				options.purgeErrorTurns ?? 4,
			) ?? current
	}

	let changed = current !== messages
	const prunedMessages = current.map((message) => {
		let messageChanged = false
		const parts = message.parts.map((part) => {
			if (
				part.type !== 'dynamic-tool' ||
				part.state !== 'output-available' ||
				typeof part.output !== 'string'
			) {
				return part
			}
			const pruned = pruneToolOutputText(part.output)
			if (!pruned) return part
			messageChanged = true
			return { ...part, output: pruned }
		})
		if (!messageChanged) return message
		changed = true
		return { ...message, parts }
	})
	return changed ? prunedMessages : messages
}
