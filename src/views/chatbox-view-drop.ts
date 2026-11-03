import type { App, TAbstractFile } from 'obsidian'
import { normalizePath, TFile } from 'obsidian'
import { createImageContextItem } from '~/ai/chat/context/user-context'

export function normalizeDroppedVaultPath(path: string): string | null {
	let value = path.trim()
	if (!value) return null
	if (value.startsWith('obsidian://open?')) {
		try {
			const url = new URL(value)
			value = url.searchParams.get('file') ?? value
		} catch {
			// Keep the raw value as a fallback candidate.
		}
	}
	try {
		value = decodeURIComponent(value)
	} catch {
		// Keep the raw value when it is not URI-encoded.
	}
	value = value.replace(/^\[\[/, '').replace(/\]\]$/, '')
	value = value.split('|')[0]?.trim() ?? ''
	value = value.replace(/^\/+/, '').replace(/\/+$/, '').trim()
	return value ? normalizePath(value) : null
}

export function resolveDroppedAbstractFile(
	app: App,
	path: string,
): TAbstractFile | null {
	const normalized = normalizeDroppedVaultPath(path)
	if (!normalized) return null
	const candidates = [normalized]
	if (!/\.[^/]+$/.test(normalized)) {
		candidates.push(`${normalized}.md`)
	}
	for (const candidate of candidates) {
		const abstract = app.vault.getAbstractFileByPath(candidate)
		if (abstract) return abstract
	}

	const basename = normalized.split('/').pop()
	if (!basename) return null
	const matches = app.vault.getAllLoadedFiles().filter((file) => {
		const filePath = normalizePath(file.path)
		const filePathWithoutMd = filePath.replace(/\.md$/i, '')
		return (
			file.name === basename ||
			filePathWithoutMd === normalized ||
			filePathWithoutMd.endsWith(`/${basename}`)
		)
	})
	return matches.length === 1 ? matches[0] : null
}

export function isVaultImageFile(file: TFile): boolean {
	return file.path.match(/\.(png|jpe?g|gif|webp|bmp)$/i) !== null
}

export async function createDroppedImageContextItem(app: App, file: TFile) {
	const extension = file.extension.toLowerCase()
	const data = await app.vault.readBinary(file)
	return createImageContextItem(new Blob([data]), {
		mimeType: `image/${extension === 'jpg' ? 'jpeg' : extension}`,
		name: file.name,
		size: file.stat.size,
	})
}
