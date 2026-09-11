import { afterEach, describe, expect, it, vi } from 'vitest'
import type { App } from 'obsidian'
import type { ViewImageAttachment } from './view-image-attachments'
import {
	executeViewPdf,
	parsePdfPageRange,
	pdfTextItemsToLines,
	type PdfDocument,
	type PdfPage,
} from './view-pdf'

afterEach(() => {
	vi.unstubAllGlobals()
})

function createApp() {
	const file = { path: 'docs/a.pdf', name: 'a.pdf', extension: 'pdf' }
	const data = new Uint8Array([1, 2, 3])
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) =>
				path === file.path ? file : null,
			readBinary: async () => data.buffer,
			adapter: {
				readBinary: async () => data.buffer,
			},
		},
	} as unknown as App
	return app
}

function createFakeCanvas() {
	const context = {} as CanvasRenderingContext2D
	return {
		width: 0,
		height: 0,
		getContext: () => context,
		toDataURL: () =>
			'data:image/png;base64,' + Buffer.from([9, 9, 9]).toString('base64'),
	} as unknown as HTMLCanvasElement
}

function createPage(
	textItems: Array<{ str: string; transform: number[]; hasEOL?: boolean }>,
	options: { width?: number; height?: number } = {},
): PdfPage {
	const width = options.width ?? 600
	const height = options.height ?? 800
	return {
		getViewport: ({ scale }: { scale: number }) => ({
			width: width * scale,
			height: height * scale,
		}),
		getTextContent: async () => ({ items: textItems }),
		render: () => ({ promise: Promise.resolve() }),
	}
}

describe('parsePdfPageRange', () => {
	it('parses ranges, open ranges, dedupe, and maxPages', () => {
		expect(parsePdfPageRange('1-3,3,5-', 10, 5)).toEqual([1, 2, 3, 5, 6])
		expect(parsePdfPageRange('all', 4, 10)).toEqual([1, 2, 3, 4])
		expect(parsePdfPageRange(undefined, 10, 5)).toEqual([1])
	})

	it('rejects invalid or out-of-range pages', () => {
		expect(() => parsePdfPageRange('0', 2, 5)).toThrow('out of range')
		expect(() => parsePdfPageRange('abc', 2, 5)).toThrow('Invalid')
	})
})

describe('pdfTextItemsToLines', () => {
	it('reconstructs English lines and Chinese text without spaces', () => {
		const lines = pdfTextItemsToLines([
			{ str: 'Hello', transform: [1, 0, 0, 1, 0, 100] },
			{ str: 'world', transform: [1, 0, 0, 1, 40, 100] },
			{ str: '第二行', transform: [1, 0, 0, 1, 0, 80], hasEOL: true },
			{ str: '中文', transform: [1, 0, 0, 1, 50, 80] },
		])
		expect(lines).toEqual(['Hello world', '第二行', '中文'])
	})
})

describe('executeViewPdf', () => {
	it('extracts text first without rendering in auto mode', async () => {
		const doc: PdfDocument = {
			numPages: 2,
			getPage: async (_pageNumber) =>
				createPage([
					{
						str: 'This page has enough real text to avoid rendering.',
						transform: [1, 0, 0, 1, 0, 100],
					},
				]),
		}
		const result = await executeViewPdf(createApp(), {
			path: '/docs/a.pdf',
			pages: '1-2',
			mode: 'auto',
			supportsImageInput: true,
			toolCallId: 'pdf-1',
			loadPdf: async () => doc,
		})
		expect(result).toContain('[PDF] /docs/a.pdf')
		expect(result).toContain('total 2 page(s)')
		expect(result).toContain('avoid rendering')
		expect(result).not.toContain('image attached')
	})

	it('renders pages without text and registers labeled image attachments', async () => {
		vi.stubGlobal('document', {
			createElement: () => createFakeCanvas(),
		})
		const doc: PdfDocument = {
			numPages: 1,
			getPage: async () => createPage([], { width: 600, height: 800 }),
		}
		const attachments: ViewImageAttachment[][] = []
		const result = await executeViewPdf(createApp(), {
			path: '/docs/a.pdf',
			pages: '1',
			mode: 'auto',
			supportsImageInput: true,
			toolCallId: 'pdf-2',
			loadPdf: async () => doc,
			viewImageAttachments: {
				register: () => {},
				registerMany: (_toolCallId, next) => {
					attachments.push(next)
				},
				takeUninjected: () => [],
			},
		})
		expect(result).toContain('no text layer')
		expect(result).toContain('image attached')
		expect(attachments).toHaveLength(1)
		expect(attachments[0]).toHaveLength(1)
		expect(attachments[0][0].file.mediaType).toBe('image/png')
		expect(attachments[0][0].label).toContain('PDF page 1')
	})

	it('rejects image mode for models without image input', async () => {
		await expect(
			executeViewPdf(createApp(), {
				path: '/docs/a.pdf',
				mode: 'image',
				supportsImageInput: false,
				toolCallId: 'pdf-3',
				loadPdf: async () => ({
					numPages: 1,
					getPage: async () => createPage([]),
				}),
			}),
		).rejects.toThrow('does not support image input')
	})
})
