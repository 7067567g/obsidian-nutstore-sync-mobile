import type { FilePart, ToolCallPart, UserModelMessage } from 'ai'

export interface ViewImageAttachment {
	file: FilePart
	label?: string
}

export interface ViewImageAttachmentRegistry {
	register(toolCallId: string, file: FilePart, label?: string): void
	registerMany(toolCallId: string, attachments: ViewImageAttachment[]): void
	takeUninjected(toolCalls: ToolCallPart[]): ViewImageAttachment[]
}

const DEFAULT_ATTACHMENT_LABEL =
	'The image from the preceding view_image result is attached for visual inspection.'

export class InMemoryViewImageAttachmentRegistry implements ViewImageAttachmentRegistry {
	private attachments = new Map<string, ViewImageAttachment[]>()
	private injectedToolCallIds = new Set<string>()

	register(toolCallId: string, file: FilePart, label?: string) {
		this.registerMany(toolCallId, [{ file, label }])
	}

	registerMany(toolCallId: string, attachments: ViewImageAttachment[]) {
		const existing = this.attachments.get(toolCallId) ?? []
		this.attachments.set(toolCallId, [...existing, ...attachments])
	}

	takeUninjected(toolCalls: ToolCallPart[]) {
		const files: ViewImageAttachment[] = []
		for (const toolCall of toolCalls) {
			if (this.injectedToolCallIds.has(toolCall.toolCallId)) continue
			const attachments = this.attachments.get(toolCall.toolCallId)
			if (!attachments?.length) continue
			this.injectedToolCallIds.add(toolCall.toolCallId)
			files.push(...attachments)
		}
		return files
	}
}

export function createViewImageAttachmentMessage(
	attachments: ViewImageAttachment[],
): UserModelMessage | undefined {
	if (!attachments.length) return undefined
	return {
		role: 'user',
		content: attachments.flatMap((attachment) => [
			{
				type: 'text' as const,
				text: attachment.label || DEFAULT_ATTACHMENT_LABEL,
			},
			attachment.file,
		]),
	}
}
