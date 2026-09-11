import { z } from 'zod/mini'
import { tool } from 'ai'
import type { App } from 'obsidian'
import { appDep, readTrackerDep } from './tool-context'
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

function wildcardToRegExp(glob: string) {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\?/g, '.')
	return new RegExp(`^${escaped}$`)
}

async function resolveGrepFiles(
	app: App,
	vaultPath: string,
	normalized: string,
	node: unknown,
): Promise<{ files: Array<{ path: string }>; skippedLarge: number }> {
	if (isFileNode(node)) {
		const size = getNodeSize(node)
		if (size !== undefined && size > DEFAULT_MAX_FILE_BYTES) {
			throw new Error(
				'File is too large for mobile vault_grep (' +
					size +
					' bytes). Use desktop MCP/native grep for large binaries or minified bundles.',
			)
		}
		return { files: [{ path: node.path }], skippedLarge: 0 }
	}
	if (isFolderNode(node)) {
		const prefix = vaultPath ? vaultPath + '/' : ''
		const files: Array<{ path: string }> = []
		let skippedLarge = 0
		for (const file of app.vault.getFiles()) {
			if (isHiddenVaultPath(file.path)) continue
			if (prefix && !file.path.startsWith(prefix)) continue
			const size = getNodeSize(file)
			if (size !== undefined && size > DEFAULT_MAX_FILE_BYTES) {
				skippedLarge++
				continue
			}
			files.push({ path: file.path })
		}
		return { files, skippedLarge }
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
	return { files: [{ path: vaultPath }], skippedLarge: 0 }
}

export async function executeVaultGrep(
	app: App,
	virtualPath: string,
	pattern: string,
	options: {
		glob?: string
		caseSensitive?: boolean
		maxResults?: number
		onRead?: (path: string) => void
	} = {},
) {
	const normalized = normalizeVaultVirtualPath(virtualPath)
	const vaultPath = toVaultPath(normalized)
	const maxResults = clampInt(options.maxResults, DEFAULT_MAX_RESULTS, 1, 200)
	const glob = options.glob ? wildcardToRegExp(options.glob) : undefined
	const regex = new RegExp(pattern, options.caseSensitive ? '' : 'i')
	const node = vaultPath
		? app.vault.getAbstractFileByPath(vaultPath)
		: app.vault.getRoot()
	const { files, skippedLarge } = await resolveGrepFiles(
		app,
		vaultPath,
		normalized,
		node,
	)

	const matches: Array<{ path: string; line: number; text: string }> = []
	for (const entry of files) {
		if (glob && !glob.test(entry.path)) continue
		let text: string
		try {
			text = await readVaultText(app, entry.path)
		} catch {
			continue
		}
		options.onRead?.(entry.path)
		const lines = text.split('\n')
		for (let index = 0; index < lines.length; index += 1) {
			if (!regex.test(lines[index])) continue
			matches.push({
				path: entry.path,
				line: index + 1,
				text: lines[index].slice(0, 500),
			})
			if (matches.length >= maxResults) break
		}
		if (matches.length >= maxResults) break
	}

	const skipped =
		skippedLarge > 0 ? ' (' + skippedLarge + ' large file(s) skipped)' : ''
	if (matches.length === 0) {
		return normalized + ': no matches for /' + pattern + '/' + skipped
	}
	const resultLines = matches.map(
		(match) => match.path + ':' + match.line + ': ' + match.text,
	)
	return (
		normalized +
		': ' +
		matches.length +
		(matches.length >= maxResults ? '+' : '') +
		' matches' +
		skipped +
		'\n' +
		resultLines.join('\n')
	)
}

export const vaultGrepTool = tool({
	description: [
		'Search text content in the Obsidian vault using the vault index and cachedRead; never builds a browser-bash filesystem.',
		'Use this instead of bash rg/grep for ordinary vault notes. Input path is a vault virtual path.',
		'pattern is a JavaScript regular expression. Optional glob filters by file path (for example "*.md").',
		'Hidden dot-directories are only searchable one explicit file at a time; use desktop MCP for large minified bundles or repository-wide searches.',
	].join(' '),
	inputSchema: z.object({
		path: z.optional(z.string()),
		pattern: z.string(),
		glob: z.optional(z.string()),
		caseSensitive: z.optional(z.boolean()),
		maxResults: z.optional(z.number()),
	}),
	contextSchema: z.object({
		app: appDep,
		readTracker: readTrackerDep,
	}),
	outputSchema: z.string(),
	execute: async (
		{ path, pattern, glob, caseSensitive, maxResults },
		{ context },
	) => {
		const result = await executeVaultGrep(context.app, path ?? '/', pattern, {
			glob,
			caseSensitive,
			maxResults,
			onRead: context.readTracker?.markRead.bind(context.readTracker),
		})
		return result
	},
})
