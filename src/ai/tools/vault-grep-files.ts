import type { App } from 'obsidian'
import {
	getNodeSize,
	isFileNode,
	isFolderNode,
	isHiddenVaultPath,
} from './vault-native'

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024

interface GrepCandidate {
	path: string
	size?: number
}

interface ResolvedGrepFiles {
	files: GrepCandidate[]
	skippedLarge: number
	skippedNonMd: number
	folderSearch: boolean
}

function isMarkdownPath(path: string) {
	return /\.md$/i.test(path)
}

export function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function wildcardToRegExp(glob: string) {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\?/g, '.')
	return new RegExp(`^${escaped}$`)
}

const TEXT_EXTENSIONS = new Set([
	'md',
	'txt',
	'json',
	'jsonl',
	'csv',
	'ts',
	'tsx',
	'js',
	'jsx',
	'css',
	'html',
	'xml',
	'yaml',
	'yml',
	'toml',
	'sh',
	'py',
	'log',
])

function getExtension(path: string) {
	const name = path.split('/').pop() ?? path
	const dot = name.lastIndexOf('.')
	return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function normalizeExtensionFilter(extensions?: string[]) {
	if (!extensions?.length) return undefined
	return new Set(
		extensions
			.map((extension) => extension.trim().toLowerCase().replace(/^\./, ''))
			.filter(Boolean),
	)
}

function extensionRank(path: string) {
	const extension = getExtension(path)
	if (extension === 'md') return 0
	if (TEXT_EXTENSIONS.has(extension)) return 1
	return 2
}

function sortGrepCandidates(files: GrepCandidate[]) {
	return files.sort((a, b) => {
		const depthA = a.path.split('/').length
		const depthB = b.path.split('/').length
		if (depthA !== depthB) return depthA - depthB
		const rankA = extensionRank(a.path)
		const rankB = extensionRank(b.path)
		if (rankA !== rankB) return rankA - rankB
		if (a.size !== undefined && b.size !== undefined && a.size !== b.size) {
			return a.size - b.size
		}
		return a.path.localeCompare(b.path)
	})
}

export async function resolveGrepFiles(
	app: App,
	vaultPath: string,
	normalized: string,
	node: unknown,
	options: {
		glob?: RegExp
		extensionFilter?: Set<string>
		includeAttachments?: boolean
	},
): Promise<ResolvedGrepFiles> {
	const { glob, extensionFilter, includeAttachments } = options
	if (isFileNode(node)) {
		const size = getNodeSize(node)
		if (size !== undefined && size > DEFAULT_MAX_FILE_BYTES) {
			throw new Error(
				'File is too large for mobile vault_grep (' +
					size +
					' bytes). Use desktop MCP/native grep for large binaries or minified bundles.',
			)
		}
		return {
			files: [{ path: node.path, size }],
			skippedLarge: 0,
			skippedNonMd: 0,
			folderSearch: false,
		}
	}
	if (isFolderNode(node)) {
		const prefix = vaultPath ? vaultPath + '/' : ''
		const visibleFiles = app.vault.getFiles()
		const defaultMarkdownSearch =
			!glob && !extensionFilter && !includeAttachments
		const candidates = visibleFiles
		let skippedLarge = 0
		let skippedNonMd = 0
		const files: GrepCandidate[] = []
		for (const file of candidates) {
			if (isHiddenVaultPath(file.path)) continue
			if (prefix && !file.path.startsWith(prefix)) continue
			const size = getNodeSize(file)
			if (size !== undefined && size > DEFAULT_MAX_FILE_BYTES) {
				skippedLarge++
				continue
			}
			const extension = getExtension(file.path)
			if (defaultMarkdownSearch && !isMarkdownPath(file.path)) {
				skippedNonMd++
				continue
			}
			if (extensionFilter && !extensionFilter.has(extension)) {
				skippedNonMd++
				continue
			}
			if (glob && !glob.test(file.path)) {
				skippedNonMd++
				continue
			}
			files.push({ path: file.path, size })
		}
		return {
			files: sortGrepCandidates(files),
			skippedLarge,
			skippedNonMd,
			folderSearch: true,
		}
	}
	const stat = await app.vault.adapter.stat(vaultPath)
	if (!stat || stat.type !== 'file') {
		throw new Error(
			'vault_grep only searches visible vault folders or an explicit hidden file path; got: ' +
				normalized,
		)
	}
	if (stat.size > DEFAULT_MAX_FILE_BYTES) {
		throw new Error(
			'File is too large for mobile vault_grep (' +
				stat.size +
				' bytes). Use desktop MCP/native grep for large binaries or minified bundles.',
		)
	}
	return {
		files: [{ path: vaultPath, size: stat.size }],
		skippedLarge: 0,
		skippedNonMd: 0,
		folderSearch: false,
	}
}
