import type { App } from 'obsidian'
import { throwIfAborted } from '~/ai/transport/abort'
import {
	DEFAULT_MAX_RESULTS,
	VAULT_GREP_DEFAULT_DEADLINE_MS,
	VAULT_GREP_DEFAULT_MAX_FILES,
	VAULT_GREP_DEFAULT_MAX_TOTAL_BYTES,
} from './vault-grep-constants'
import {
	formatBytes,
	normalizeExtensionFilter,
	resolveGrepFiles,
	wildcardToRegExp,
} from './vault-grep-files'
import { assertSafeGrepPattern } from './vault-grep-pattern'
import {
	clampInt,
	normalizeVaultVirtualPath,
	readVaultText,
	toVaultPath,
} from './vault-native'

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
