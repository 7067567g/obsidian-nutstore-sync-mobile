import { toUint8Array } from 'js-base64'
import { loadPdfJs } from 'obsidian'
import type { App } from 'obsidian'
import { tool } from 'ai'
import { z } from 'zod/mini'
import type { ViewImageAttachmentRegistry } from './view-image-attachments'
import {
	appDep,
	readTrackerDep,
	supportsImageInputDep,
	viewImageAttachmentsDep,
} from './tool-context'
import {
	clampInt,
	normalizeVaultVirtualPath,
	readVaultBinary,
	toVaultPath,
} from './vault-native'

const DEFAULT_MAX_PAGES = 5
const MAX_PAGES = 10
const DEFAULT_MAX_CHARS_PER_PAGE = 4000
const MAX_CHARS_PER_PAGE = 20000
const AUTO_TEXT_THRESHOLD = 30
const MAX_PDF_BYTES = 50 * 1024 * 1024
const DEFAULT_TARGET_WIDTH = 1000
const MAX_RENDER_PIXELS = 4_000_000

export type ViewPdfMode = 'auto' | 'text' | 'image' | 'both'

export interface PdfTextItem {
	str?: string
	transform?: number[]
	hasEOL?: boolean
}

interface PdfTextContent {
	items?: PdfTextItem[]
}

interface PdfViewport {
	width: number
	height: number
}

export interface PdfPage {
	getViewport(params: { scale: number }): PdfViewport
	getTextContent(): Promise<PdfTextContent>
	render(params: {
		canvasContext: CanvasRenderingContext2D
		viewport: PdfViewport
	}): { promise: Promise<void>; cancel?: () => void }
	cleanup?: () => void
}

export interface PdfDocument {
	numPages: number
	getPage(pageNumber: number): Promise<PdfPage>
	destroy?: () => void
}

interface PdfJs {
	getDocument(params: { data: Uint8Array }): {
		promise: Promise<PdfDocument>
	}
}

const CJK_PATTERN = /[\u3000-\u9fff\uf900-\ufaff]/

export function parsePdfPageRange(
	input: string | undefined,
	totalPages: number,
	maxPages: number,
) {
	const limit = Math.max(1, Math.min(MAX_PAGES, Math.floor(maxPages)))
	const spec = (input ?? '').trim() || '1'
	const pages: number[] = []
	const pushPage = (page: number) => {
		if (page < 1 || page > totalPages) {
			throw new Error(
				'PDF page out of range: ' +
					page +
					' (total ' +
					totalPages +
					' page(s))',
			)
		}
		if (!pages.includes(page) && pages.length < limit) {
			pages.push(page)
		}
	}
	if (spec.toLowerCase() === 'all') {
		for (let page = 1; page <= totalPages && pages.length < limit; page++) {
			pushPage(page)
		}
	} else {
		for (const rawPart of spec.split(',')) {
			const part = rawPart.trim()
			if (!part) continue
			const match = /^(\d+)(?:-(\d*))?$/.exec(part)
			if (!match) {
				throw new Error('Invalid PDF pages expression: ' + part)
			}
			const start = Number.parseInt(match[1], 10)
			const end =
				match[2] === undefined
					? start
					: match[2] === ''
						? totalPages
						: Number.parseInt(match[2], 10)
			if (!Number.isFinite(start) || !Number.isFinite(end)) {
				throw new Error('Invalid PDF pages expression: ' + part)
			}
			const step = start <= end ? 1 : -1
			for (
				let page = start;
				step > 0 ? page <= end : page >= end;
				page += step
			) {
				pushPage(page)
				if (pages.length >= limit) break
			}
			if (pages.length >= limit) break
		}
	}
	if (pages.length === 0) {
		throw new Error('No PDF pages selected')
	}
	return pages
}

function needsTextSpace(previous: string, next: string) {
	const last = previous[previous.length - 1]
	const first = next[0]
	if (!last || !first) return false
	if (CJK_PATTERN.test(last) || CJK_PATTERN.test(first)) return false
	return /[A-Za-z0-9]$/.test(last) && /^[A-Za-z0-9]/.test(first)
}

function appendTextFragment(current: string, next: string) {
	if (!current) return next
	return needsTextSpace(current, next) ? current + ' ' + next : current + next
}

export function pdfTextItemsToLines(items: PdfTextItem[]) {
	const sorted = items
		.filter((item) => typeof item.str === 'string' && item.str.length > 0)
		.slice()
		.sort((left, right) => {
			const leftY = left.transform?.[5] ?? 0
			const rightY = right.transform?.[5] ?? 0
			if (Math.abs(leftY - rightY) > 0.5) return rightY - leftY
			const leftX = left.transform?.[4] ?? 0
			const rightX = right.transform?.[4] ?? 0
			return leftX - rightX
		})
	const lines: string[] = []
	let current = ''
	let currentY: number | undefined
	const flush = () => {
		const line = current.trim()
		if (line) lines.push(line)
		current = ''
	}
	for (const item of sorted) {
		const y = item.transform?.[5] ?? 0
		if (currentY === undefined || Math.abs(y - currentY) > 2.5) {
			flush()
			currentY = y
		}
		current = appendTextFragment(current, item.str ?? '')
		if (item.hasEOL) {
			flush()
			currentY = undefined
		}
	}
	flush()
	return lines
}

async function loadPdfDocument(data: Uint8Array): Promise<PdfDocument> {
	const pdfjs = (await loadPdfJs()) as PdfJs
	const loadingTask = pdfjs.getDocument({ data })
	return await loadingTask.promise
}

async function renderPdfPageToPng(page: PdfPage, scaleOption?: number) {
	const baseViewport = page.getViewport({ scale: 1 })
	let scale =
		typeof scaleOption === 'number' && Number.isFinite(scaleOption)
			? Math.max(0.5, Math.min(3, scaleOption))
			: DEFAULT_TARGET_WIDTH / baseViewport.width
	scale = Math.max(1, Math.min(2.5, scale))
	let viewport = page.getViewport({ scale })
	const pixels = viewport.width * viewport.height
	if (pixels > MAX_RENDER_PIXELS) {
		scale *= Math.sqrt(MAX_RENDER_PIXELS / pixels)
		viewport = page.getViewport({ scale })
	}
	const canvas = document.createElement('canvas')
	canvas.width = Math.max(1, Math.floor(viewport.width))
	canvas.height = Math.max(1, Math.floor(viewport.height))
	const canvasContext = canvas.getContext('2d')
	if (!canvasContext) {
		throw new Error('Canvas is unavailable for PDF rendering')
	}
	const renderTask = page.render({ canvasContext, viewport })
	let timeoutId: number | undefined
	try {
		await Promise.race([
			renderTask.promise,
			new Promise<never>((_resolve, reject) => {
				timeoutId = window.setTimeout(() => {
					reject(
						new Error(
							'PDF rendering timed out. Keep Obsidian visible while viewing PDF pages, or use desktop MCP for large/complex PDFs.',
						),
					)
				}, 30000)
			}),
		])
	} catch (error) {
		renderTask.cancel?.()
		throw error
	} finally {
		if (timeoutId !== undefined) window.clearTimeout(timeoutId)
	}
	// Obsidian mobile WebView can leave canvas.toBlob callbacks pending.
	// toDataURL is synchronous in the tested runtime; js-base64 decodes it.
	const dataUrl = canvas.toDataURL('image/png')
	const commaIndex = dataUrl.indexOf(',')
	if (commaIndex < 0) {
		throw new Error('Failed to encode rendered PDF page')
	}
	const data = toUint8Array(dataUrl.slice(commaIndex + 1))
	const width = canvas.width
	const height = canvas.height
	canvas.width = 0
	canvas.height = 0
	return { data, width, height }
}

function truncatePageText(text: string, maxChars: number) {
	if (text.length <= maxChars) return text
	return text.slice(0, maxChars) + '\n...[truncated]'
}

export interface ViewPdfOptions {
	path: string
	pages?: string
	mode?: ViewPdfMode
	scale?: number
	maxPages?: number
	maxCharsPerPage?: number
	supportsImageInput?: boolean
	readTracker?: { markRead(path: string): void }
	viewImageAttachments?: ViewImageAttachmentRegistry
	toolCallId: string
	loadPdf?: (data: Uint8Array) => Promise<PdfDocument>
}

export async function executeViewPdf(app: App, options: ViewPdfOptions) {
	const normalized = normalizeVaultVirtualPath(options.path)
	const vaultPath = toVaultPath(normalized)
	if (!vaultPath.toLowerCase().endsWith('.pdf')) {
		throw new Error('view_pdf requires a .pdf file: ' + normalized)
	}
	const mode = options.mode ?? 'auto'
	if (
		(mode === 'image' || mode === 'both') &&
		options.supportsImageInput === false
	) {
		throw new Error(
			'Current model does not support image input; use mode=text or switch to an image-capable model.',
		)
	}
	const data = await readVaultBinary(app, vaultPath)
	if (data.byteLength > MAX_PDF_BYTES) {
		throw new Error(
			'PDF is too large for mobile view_pdf (' +
				data.byteLength +
				' bytes). Use desktop MCP for this file.',
		)
	}
	let document: PdfDocument
	try {
		document = options.loadPdf
			? await options.loadPdf(data)
			: await loadPdfDocument(data)
	} catch (error) {
		throw new Error(
			'Failed to open PDF ' +
				normalized +
				': ' +
				(error instanceof Error ? error.message : String(error)),
			{ cause: error },
		)
	}
	const maxPages = clampInt(options.maxPages, DEFAULT_MAX_PAGES, 1, MAX_PAGES)
	const maxChars = clampInt(
		options.maxCharsPerPage,
		DEFAULT_MAX_CHARS_PER_PAGE,
		200,
		MAX_CHARS_PER_PAGE,
	)
	try {
		const pages = parsePdfPageRange(options.pages, document.numPages, maxPages)
		const sections: string[] = []
		const attachments: Array<{
			file: Parameters<
				ViewImageAttachmentRegistry['registerMany']
			>[1][number]['file']
			label: string
		}> = []
		for (const pageNumber of pages) {
			const page = await document.getPage(pageNumber)
			try {
				let text = ''
				if (mode !== 'image') {
					const content = await page.getTextContent()
					text = pdfTextItemsToLines(content.items ?? []).join('\n')
				}
				const cleanText = text.replace(/\s+/g, ' ').trim()
				const hasText = cleanText.length >= AUTO_TEXT_THRESHOLD
				const shouldRender =
					mode === 'image' || mode === 'both' || (mode === 'auto' && !hasText)
				if (mode !== 'image') {
					if (cleanText) {
						sections.push(
							'[Page ' +
								pageNumber +
								'] text:\n' +
								truncatePageText(cleanText, maxChars),
						)
					} else {
						sections.push('[Page ' + pageNumber + '] no text layer.')
					}
				}
				if (shouldRender) {
					if (options.supportsImageInput === false) {
						sections.push(
							'[Page ' +
								pageNumber +
								'] needs image input, but the current model does not support images.',
						)
					} else {
						const rendered = await renderPdfPageToPng(page, options.scale)
						attachments.push({
							file: {
								type: 'file',
								data: { type: 'data', data: rendered.data },
								filename:
									(vaultPath.split('/').pop() || 'document.pdf') +
									'-page-' +
									pageNumber +
									'.png',
								mediaType: 'image/png',
							},
							label:
								'PDF page ' +
								pageNumber +
								' of ' +
								normalized +
								' is attached for visual inspection.',
						})
						sections.push(
							'[Page ' +
								pageNumber +
								'] image attached (' +
								rendered.width +
								'x' +
								rendered.height +
								').',
						)
					}
				}
			} finally {
				page.cleanup?.()
			}
		}
		if (attachments.length > 0) {
			options.viewImageAttachments?.registerMany(
				options.toolCallId,
				attachments,
			)
		}
		options.readTracker?.markRead(vaultPath)
		return (
			'[PDF] ' +
			normalized +
			' (total ' +
			document.numPages +
			' page(s); requested ' +
			pages.join(', ') +
			'; mode ' +
			mode +
			')\n' +
			sections.join('\n\n')
		)
	} finally {
		document.destroy?.()
	}
}

export const viewPdfTool = tool({
	description: [
		'Read selected pages of a PDF stored in the Obsidian vault.',
		'Default mode auto extracts text first and renders a page to an image only when that page has no useful text layer.',
		'Use mode text for text extraction, image to render pages, and both for text plus rendered pages.',
		'pages accepts expressions such as "1", "1-3", "5-", or "1,3-5"; default is page 1.',
		'Rendered pages are attached as images for the next model step and require model image input support.',
		'The result reports total page count and which pages were text or image.',
	].join(' '),
	inputSchema: z.object({
		path: z.string(),
		pages: z.optional(z.string()),
		mode: z.optional(
			z.union([
				z.literal('auto'),
				z.literal('text'),
				z.literal('image'),
				z.literal('both'),
			]),
		),
		scale: z.optional(z.number()),
		maxPages: z.optional(z.number()),
		maxCharsPerPage: z.optional(z.number()),
	}),
	contextSchema: z.object({
		app: appDep,
		readTracker: readTrackerDep,
		viewImageAttachments: viewImageAttachmentsDep,
		supportsImageInput: supportsImageInputDep,
	}),
	outputSchema: z.string(),
	execute: async (
		{ path, pages, mode, scale, maxPages, maxCharsPerPage },
		{ context, toolCallId },
	) =>
		executeViewPdf(context.app, {
			path,
			pages,
			mode,
			scale,
			maxPages,
			maxCharsPerPage,
			supportsImageInput: context.supportsImageInput,
			readTracker: context.readTracker,
			viewImageAttachments: context.viewImageAttachments,
			toolCallId,
		}),
})
