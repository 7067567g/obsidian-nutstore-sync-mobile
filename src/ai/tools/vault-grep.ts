import { z } from 'zod/mini'
import { tool } from 'ai'
import type { App } from 'obsidian'
import { appDep, readTrackerDep } from './tool-context'
import { throwIfAborted } from '~/ai/transport/abort'
import {
	clampInt,
	getNodeSize,
	isFileNode,
	isFolderNode,
	isHiddenVaultPath,
	normalizeVaultVirtualPath,
	readVaultText,
	toVaultPath,
} from './vault-native'

const DEFAULT_MAX_RESULTS = 100
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024

export const VAULT_GREP_DEFAULT_MAX_FILES = 1000
export const VAULT_GREP_DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024
export const VAULT_GREP_DEFAULT_DEADLINE_MS = 15_000
export const VAULT_GREP_MAX_PATTERN_LENGTH = 400

/**
 * Reject regex shapes that can backtrack catastrophically inside one
 * `regex.test()` call. JavaScript regex evaluation cannot be preempted, so a
 * shape guard is the only hard gate on this path; a conservative refusal is
 * preferable to a multi-second main-thread freeze. False positives direct the
 * caller to a literal substring or desktop MCP.
 */
export function assertSafeGrepPattern(pattern: string) {
	if (pattern.length > VAULT_GREP_MAX_PATTERN_LENGTH) {
		throw new Error(
			'REGEX_TOO_COMPLEX: pattern exceeds ' +
				VAULT_GREP_MAX_PATTERN_LENGTH +
				' characters; narrow the pattern or use desktop MCP.',
		)
	}
	const skeleton = pattern
		.replace(/\\./g, 'x')
		.replace(/\[(?:[^\]\\]|\\.)*\]/g, 'x')
		.replace(/\(\?(?::|=|!|<=|<!)/g, '(')
	const nestedQuantifier =
		/\([^()]*(?:[*+?]|\{\d+,\d*\})[^()]*\)\s*(?:[*+?]|\{\d)/.test(skeleton)
	if (nestedQuantifier) {
		throw new Error(
			'REGEX_TOO_COMPLEX: nested quantifiers can backtrack catastrophically; simplify the pattern, use a literal substring, or use desktop MCP.',
		)
	}
}

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

function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function wildcardToRegExp(glob: string) {
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

function normalizeExtensionFilter(extensions?: string[]) {
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

async function resolveGrepFiles(
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

export async function executeVaultGrep(
	app: App,
	virtualPath: string,
	pattern: string,
	options: {
		glob?: string
		extensions?: string[]
		includeAttachments?: boolean
		caseSensitive?: boolean
		maxResults?: number
		maxFiles?: number
		maxTotalBytes?: number
		deadlineMs?: number
		abortSignal?: AbortSignal
		onRead?: (path: string) => void
	} = {},
) {
	const normalized = normalizeVaultVirtualPath(virtualPath)
	const vaultPath = toVaultPath(normalized)
	const maxResults = clampInt(options.maxResults, DEFAULT_MAX_RESULTS, 1, 200)
	const maxFiles = Math.max(
		1,
		Math.floor(options.maxFiles ?? VAULT_GREP_DEFAULT_MAX_FILES),
	)
	const maxTotalBytes = Math.max(
		1,
		Math.floor(options.maxTotalBytes ?? VAULT_GREP_DEFAULT_MAX_TOTAL_BYTES),
	)
	const deadlineMs = Math.max(
		1,
		Math.floor(options.deadlineMs ?? VAULT_GREP_DEFAULT_DEADLINE_MS),
	)
	const glob = options.glob ? wildcardToRegExp(options.glob) : undefined
	const extensionFilter = normalizeExtensionFilter(options.extensions)
	assertSafeGrepPattern(pattern)
	const regex = new RegExp(pattern, options.caseSensitive ? '' : 'i')
	const node = vaultPath
		? app.vault.getAbstractFileByPath(vaultPath)
		: app.vault.getRoot()
	const { files, skippedLarge, skippedNonMd, folderSearch } =
		await resolveGrepFiles(app, vaultPath, normalized, node, {
			glob,
			extensionFilter,
			includeAttachments: options.includeAttachments,
		})

	const startedAt = Date.now()
	const matches: Array<{ path: string; line: number; text: string }> = []
	let scannedFiles = 0
	let scannedBytes = 0
	let stopped = false
	let maxResultsReached = false

	for (let index = 0; index < files.length; index += 1) {
		throwIfAborted(options.abortSignal)
		if (Date.now() - startedAt >= deadlineMs) {
			stopped = true
			break
		}
		const entry = files[index]
		if (glob && !glob.test(entry.path)) continue
		if (
			scannedFiles >= maxFiles ||
			scannedBytes >= maxTotalBytes ||
			(entry.size !== undefined && scannedBytes + entry.size > maxTotalBytes)
		) {
			stopped = true
			break
		}
		let text: string
		try {
			text = await readVaultText(app, entry.path)
		} catch {
			continue
		}
		options.onRead?.(entry.path)
		scannedFiles += 1
		scannedBytes += entry.size ?? text.length
		const lines = text.split('\n')
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
			if (!regex.test(lines[lineIndex])) continue
			matches.push({
				path: entry.path,
				line: lineIndex + 1,
				text: lines[lineIndex].slice(0, 500),
			})
			if (matches.length >= maxResults) {
				maxResultsReached = true
				break
			}
		}
		if (matches.length >= maxResults) break
	}

	const resultLines = matches.map(
		(match) => match.path + ':' + match.line + ': ' + match.text,
	)
	const matchHead =
		matches.length + (matches.length >= maxResults ? '+' : '') + ' matches'
	const skippedSuffix =
		skippedLarge > 0 ? ' (' + skippedLarge + ' large file(s) skipped)' : ''

	if (!folderSearch) {
		if (matches.length === 0) {
			return normalized + ': no matches for /' + pattern + '/' + skippedSuffix
		}
		return (
			normalized +
			': ' +
			matches.length +
			(matches.length >= maxResults ? '+' : '') +
			' matches' +
			skippedSuffix +
			'\n' +
			resultLines.join('\n')
		)
	}

	const stats =
		'scanned ' +
		scannedFiles +
		' file(s), skipped ' +
		skippedNonMd +
		' non-md, ' +
		skippedLarge +
		' large'
	if (maxResultsReached) {
		return (
			normalized +
			': ' +
			matchHead +
			'\n(stopped: maxResults=' +
			maxResults +
			' reached after ' +
			scannedFiles +
			' file(s); result incomplete; increase maxResults or narrow path/glob)' +
			(resultLines.length > 0 ? '\n' + resultLines.join('\n') : '')
		)
	}
	if (stopped) {
		const elapsedMs = Math.max(1, Date.now() - startedAt)
		const stoppedHead =
			matches.length === 0
				? normalized + ': stopped before completion: 0 matches so far'
				: normalized + ': ' + matchHead
		const stoppedStats =
			'(stopped after ' +
			scannedFiles +
			' file(s) / ' +
			formatBytes(scannedBytes) +
			' / ' +
			elapsedMs +
			' ms; result incomplete; narrow path/glob or use desktop MCP for a full vault search)'
		return (
			stoppedHead +
			'\n' +
			stoppedStats +
			(resultLines.length > 0 ? '\n' + resultLines.join('\n') : '')
		)
	}

	if (matches.length === 0) {
		return (
			normalized +
			': no matches for /' +
			pattern +
			'/ (complete: ' +
			stats +
			')'
		)
	}
	return (
		normalized +
		': ' +
		matchHead +
		' (complete: ' +
		stats +
		')\n' +
		resultLines.join('\n')
	)
}

export const vaultGrepTool = tool({
	description: [
		'Search text content in the Obsidian vault using the vault index and cachedRead; never builds a browser-bash filesystem.',
		'Use this instead of bash rg/grep for ordinary vault notes. Input path is a vault virtual path.',
		'pattern is a JavaScript regular expression; nested quantifiers and patterns longer than 400 characters are rejected before execution because regex evaluation cannot be preempted.',
		'Folder/root searches default to markdown files. Pass extensions (for example ["json","ts"]) or includeAttachments:true to widen the search; explicit glob still filters paths.',
		'Directory/root searches default to markdown files only and run under a bounded budget (1000 files / 64 MiB / 15 s). Pass an explicit glob (for example "*.json") to search other text formats; if the result says incomplete, narrow path/glob or use desktop MCP for a complete vault-wide search.',
		'Use vault_stat for filename searches instead of grepping for file names.',
		'Hidden dot-directories are only searchable one explicit file at a time; use desktop MCP for large minified bundles or repository-wide searches.',
	].join(' '),
	inputSchema: z.object({
		path: z.optional(z.string()),
		pattern: z.string(),
		glob: z.optional(z.string()),
		extensions: z.optional(z.array(z.string())),
		includeAttachments: z.optional(z.boolean()),
		caseSensitive: z.optional(z.boolean()),
		maxResults: z.optional(z.number()),
	}),
	contextSchema: z.object({
		app: appDep,
		readTracker: readTrackerDep,
	}),
	outputSchema: z.string(),
	execute: async (
		{
			path,
			pattern,
			glob,
			extensions,
			includeAttachments,
			caseSensitive,
			maxResults,
		},
		{ context, abortSignal },
	) => {
		const result = await executeVaultGrep(context.app, path ?? '/', pattern, {
			glob,
			extensions,
			includeAttachments,
			caseSensitive,
			maxResults,
			abortSignal,
			onRead: context.readTracker?.markRead.bind(context.readTracker),
		})
		return result
	},
})
