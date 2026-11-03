import { normalizePath, requestUrl, TFile, Vault } from 'obsidian'
import { v7 as uuidv7 } from 'uuid'
import type { ChatSession } from '~/ai/chat/domain'
import type { UserContextItem } from '~/ai/chat/context/user-context'
import { imageFilePartSrc } from './message-utils'
import type { FilePart } from 'ai'
import { writeLocalBinary, writeLocalText } from '~/utils/local-vault-io'
import logger from '~/utils/logger'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import { buildSessionMarkdown } from './export-session-render'

interface ExportSessionParams {
	vault: Vault
	manifestId: string
	manifestVersion: string
	session: ChatSession
	title: string
	includeToolMessages: boolean
}

const MAX_EXPORT_TITLE_BYTES = 200

function formatExportTimestamp(date: Date) {
	const pad = (value: number) => String(value).padStart(2, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

function formatAssetsDirectory(date: Date) {
	const pad = (value: number) => String(value).padStart(2, '0')
	return normalizePath(
		`assets/${date.getFullYear()}/${pad(date.getMonth() + 1)}`,
	)
}

function truncateUtf8(input: string, maxBytes: number) {
	const encoder = new TextEncoder()
	let byteLength = 0
	let result = ''
	for (const character of input) {
		const characterBytes = encoder.encode(character).byteLength
		if (byteLength + characterBytes > maxBytes) break
		result += character
		byteLength += characterBytes
	}
	return result
}

export function sanitizeExportFileName(input: string) {
	const normalized = input
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/[\\/:*?"<>|]/g, '-')
		.replace(/^\.+/, '')
		.replace(/[. ]+$/, '')
	const truncated = truncateUtf8(normalized, MAX_EXPORT_TITLE_BYTES).replace(
		/[. ]+$/,
		'',
	)
	return truncated || 'chat-session'
}

function imageExtFromMimeType(mimeType: string | undefined) {
	switch ((mimeType || '').toLowerCase()) {
		case 'image/png':
			return 'png'
		case 'image/jpeg':
			return 'jpg'
		case 'image/webp':
			return 'webp'
		case 'image/gif':
			return 'gif'
		case 'image/svg+xml':
			return 'svg'
		case 'image/bmp':
			return 'bmp'
		case 'image/x-icon':
		case 'image/vnd.microsoft.icon':
			return 'ico'
		default:
			return 'png'
	}
}

function detectMimeTypeFromDataUrl(url: string) {
	const match = /^data:([^;,]+)[;,]/i.exec(url)
	return match?.[1]?.toLowerCase()
}

function detectImageExtensionFromUrl(url: string) {
	const dataUrlMime = detectMimeTypeFromDataUrl(url)
	if (dataUrlMime) {
		return imageExtFromMimeType(dataUrlMime)
	}
	const cleaned = url.split('?')[0]?.split('#')[0] || ''
	const extMatch = /\.([a-zA-Z0-9]+)$/.exec(cleaned)
	const ext = extMatch?.[1]?.toLowerCase()
	if (!ext) return 'png'
	if (
		['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'bmp', 'ico'].includes(ext)
	) {
		return ext === 'jpeg' ? 'jpg' : ext
	}
	return 'png'
}

async function resolveImageArrayBuffer(imagePart: FilePart) {
	const url = imageFilePartSrc(imagePart)
	if (!url) {
		throw new Error('Unable to read non-URL image content')
	}
	if (url.startsWith('data:')) {
		const response = await fetch(url)
		if (!response.ok) {
			throw new Error(`Unable to read image content: ${response.status}`)
		}
		return {
			arrayBuffer: await response.arrayBuffer(),
			mimeType:
				response.headers.get('content-type') || detectMimeTypeFromDataUrl(url),
		}
	}
	// requestUrl bypasses CORS restrictions in the Obsidian mobile WebView.
	const response = await requestUrl({ url, throw: false })
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Unable to read image content: ${response.status}`)
	}
	return {
		arrayBuffer: response.arrayBuffer,
		mimeType:
			response.headers?.['content-type'] || detectMimeTypeFromDataUrl(url),
	}
}

const MAX_UNIQUE_EXPORT_PATH_ATTEMPTS = 1000

function resolveUniqueExportPath(
	vault: Vault,
	directoryPath: string,
	baseFileName: string,
) {
	for (let index = 0; index < MAX_UNIQUE_EXPORT_PATH_ATTEMPTS; index += 1) {
		const suffix = index === 0 ? '' : `-${index + 1}`
		const fileStem = `${baseFileName}${suffix}`
		const filePath = normalizePath(`${directoryPath}/${fileStem}.md`)
		const existing = vault.getAbstractFileByPath(filePath)
		if (!existing) {
			return filePath
		}
	}
	throw new Error(
		`Unable to resolve a unique export path for '${baseFileName}' after ${MAX_UNIQUE_EXPORT_PATH_ATTEMPTS} attempts`,
	)
}

async function saveExportImage(
	vault: Vault,
	part: FilePart,
	assetsDirPath: string,
	assetsMarkdownPrefix: string,
) {
	const url = imageFilePartSrc(part)
	if (!url) return undefined
	try {
		const { arrayBuffer, mimeType } = await resolveImageArrayBuffer(part)
		await mkdirsVault(vault, assetsDirPath)
		const ext = mimeType
			? imageExtFromMimeType(mimeType)
			: detectImageExtensionFromUrl(url)
		const fileName = `${uuidv7()}.${ext}`
		const filePath = normalizePath(`${assetsDirPath}/${fileName}`)
		await writeLocalBinary(vault, filePath, arrayBuffer)
		return `${assetsMarkdownPrefix}/${fileName}`
	} catch (error) {
		logger.warn('Failed to persist export image, using source URL', error)
		return url
	}
}

async function saveExportUserContextImage(
	vault: Vault,
	item: Extract<UserContextItem, { type: 'image' }>,
	assetsDirPath: string,
	assetsMarkdownPrefix: string,
) {
	try {
		await mkdirsVault(vault, assetsDirPath)
		const fileName = `${uuidv7()}.${imageExtFromMimeType(item.mimeType)}`
		const filePath = normalizePath(`${assetsDirPath}/${fileName}`)
		await writeLocalBinary(vault, filePath, await item.blob.arrayBuffer())
		return `${assetsMarkdownPrefix}/${fileName}`
	} catch (error) {
		logger.warn('Failed to persist export image from user context', error)
		return undefined
	}
}

export async function exportSessionToMarkdownFile(params: ExportSessionParams) {
	const exportDirPath = normalizePath(`${params.manifestId}/conversations`)
	await mkdirsVault(params.vault, exportDirPath)
	const exportDate = new Date()
	const baseFileName = `${sanitizeExportFileName(params.title)}-${formatExportTimestamp(exportDate)}`
	const filePath = resolveUniqueExportPath(
		params.vault,
		exportDirPath,
		baseFileName,
	)
	const assetsMarkdownPrefix = formatAssetsDirectory(exportDate)
	const assetsDirPath = normalizePath(
		`${exportDirPath}/${assetsMarkdownPrefix}`,
	)
	const markdown = await buildSessionMarkdown(
		params.vault,
		params.session,
		params.title,
		params.includeToolMessages,
		params.manifestVersion,
		assetsDirPath,
		assetsMarkdownPrefix,
		{ saveExportImage, saveExportUserContextImage },
	)
	await writeLocalText(params.vault, filePath, markdown)
	const file = params.vault.getAbstractFileByPath(filePath)
	if (!(file instanceof TFile)) {
		throw new Error(`Unable to locate exported file: ${filePath}`)
	}
	return file
}
