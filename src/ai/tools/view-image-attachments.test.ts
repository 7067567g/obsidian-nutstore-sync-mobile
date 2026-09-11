import { describe, expect, it } from 'vitest'
import type { FilePart, ToolCallPart } from 'ai'
import {
	InMemoryViewImageAttachmentRegistry,
	createViewImageAttachmentMessage,
} from './view-image-attachments'

function filePart(name: string): FilePart {
	return {
		type: 'file',
		data: { type: 'data', data: new Uint8Array([1]) },
		filename: name,
		mediaType: 'image/png',
	}
}

describe('view image attachments', () => {
	it('returns multiple labeled attachments once', () => {
		const registry = new InMemoryViewImageAttachmentRegistry()
		registry.registerMany('call-1', [
			{ file: filePart('p1.png'), label: 'PDF page 1' },
			{ file: filePart('p2.png'), label: 'PDF page 2' },
		])
		const toolCalls = [{ toolCallId: 'call-1' } as ToolCallPart]
		const taken = registry.takeUninjected(toolCalls)
		expect(taken).toHaveLength(2)
		expect(taken[1].label).toBe('PDF page 2')
		expect(registry.takeUninjected(toolCalls)).toHaveLength(0)
		const message = createViewImageAttachmentMessage(taken)
		expect(message?.content).toEqual([
			{ type: 'text', text: 'PDF page 1' },
			filePart('p1.png'),
			{ type: 'text', text: 'PDF page 2' },
			filePart('p2.png'),
		])
	})
})
