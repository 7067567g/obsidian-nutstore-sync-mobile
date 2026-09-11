import type { AppUIMessage } from '~/ai/chat/types'

/**
 * Summary-only deterministic tool-result pruning.
 *
 * Long tool outputs are useful for the live agent loop and the UI, but they are
 * pure cost when the context summarizer replays old history. This helper makes
 * a pruned *copy* of the plan messages for the summarizer only: the live
 * timeline, persisted session, and undo/diff data are untouched.
 *
 * This is a small, non-persistent adaptation of the DeepSeek Harness
 * `compaction-tool-result-pruner` (threshold 8192, head 4096, tail 1024).
 */

export const SUMMARY_TOOL_RESULT_THRESHOLD_CHARS = 8192
export const SUMMARY_TOOL_RESULT_HEAD_CHARS = 4096
export const SUMMARY_TOOL_RESULT_TAIL_CHARS = 1024
export const SUMMARY_TOOL_RESULT_MARKER =
	'\n\n[... tool result middle omitted for context compression ...]\n\n'

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
): AppUIMessage[] {
	let changed = false
	const prunedMessages = messages.map((message) => {
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
