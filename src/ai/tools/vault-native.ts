import { posix as pathPosix } from 'path-browserify'
import type { App, TFile } from 'obsidian'

export interface VaultEntry {
	path: string
	name: string
	isDirectory: boolean
}

export function normalizeVaultVirtualPath(inputPath: string) {
	const normalized = pathPosix.normalize(
		pathPosix.resolve('/', inputPath || '/'),
	)
	if (!normalized.startsWith('/')) {
		throw new Error('Invalid vault path: ' + inputPath)
	}
	return normalized === '' ? '/' : normalized
}

export function toVaultPath(virtualPath: string) {
	const normalized = normalizeVaultVirtualPath(virtualPath)
	return normalized === '/' ? '' : normalized.slice(1)
}

export function toVirtualPath(vaultPath: string) {
	return vaultPath ? '/' + vaultPath.replace(/^\/+/, '') : '/'
}

export function clampInt(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
) {
	const numeric = Number.isFinite(value)
		? Math.floor(value as number)
		: fallback
	return Math.max(minimum, Math.min(maximum, numeric))
}

export function getNodeSize(node: unknown): number | undefined {
	if (!node || typeof node !== 'object') return undefined
	const size = (node as { stat?: { size?: unknown } }).stat?.size
	return typeof size === 'number' ? size : undefined
}

export function isHiddenVaultPath(vaultPath: string) {
	return vaultPath
		.split('/')
		.filter(Boolean)
		.some((segment) => segment.startsWith('.'))
}

export function isFolderNode(
	node: unknown,
): node is { path: string; name?: string; children: unknown[] } {
	return (
		!!node &&
		typeof node === 'object' &&
		Array.isArray((node as { children?: unknown }).children)
	)
}

export function isFileNode(
	node: unknown,
): node is { path: string; name?: string; extension?: string } {
	return (
		!!node &&
		typeof node === 'object' &&
		typeof (node as { path?: unknown }).path === 'string' &&
		!Array.isArray((node as { children?: unknown }).children)
	)
}

export function isVaultFileNode(node: unknown): node is TFile {
	return isFileNode(node)
}

export function entryFromNode(
	node: unknown,
	fallbackPath: string,
	fallbackIsDirectory = false,
): VaultEntry | undefined {
	if (isFolderNode(node)) {
		return {
			path: node.path,
			name: node.name || node.path.split('/').pop() || node.path,
			isDirectory: true,
		}
	}
	if (isFileNode(node)) {
		return {
			path: node.path,
			name: node.name || node.path.split('/').pop() || node.path,
			isDirectory: false,
		}
	}
	return fallbackPath
		? {
				path: fallbackPath,
				name: fallbackPath,
				isDirectory: fallbackIsDirectory,
			}
		: undefined
}

export async function readVaultBinary(
	app: App,
	vaultPath: string,
): Promise<Uint8Array> {
	const node = app.vault.getAbstractFileByPath(vaultPath)
	if (isVaultFileNode(node)) {
		return new Uint8Array(await app.vault.readBinary(node))
	}
	return new Uint8Array(await app.vault.adapter.readBinary(vaultPath))
}

export async function readVaultText(
	app: App,
	vaultPath: string,
): Promise<string> {
	const node = app.vault.getAbstractFileByPath(vaultPath)
	if (isVaultFileNode(node)) {
		if (typeof app.vault.cachedRead === 'function') {
			return await app.vault.cachedRead(node)
		}
		return await app.vault.read(node)
	}
	return await app.vault.adapter.read(vaultPath)
}

export function describeVaultEntries(
	entries: VaultEntry[],
	options: { basePath: string; truncated?: boolean },
) {
	const lines = entries.map((entry) => {
		const relative = options.basePath
			? entry.path.replace(
					new RegExp('^' + escapeRegExp(options.basePath) + '/?'),
					'',
				)
			: entry.path
		return (entry.isDirectory ? '[dir] ' : '      ') + (relative || entry.name)
	})
	if (options.truncated) {
		lines.push('... (truncated)')
	}
	return lines.join('\n')
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
