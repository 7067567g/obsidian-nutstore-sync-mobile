import { z } from 'zod/mini'
import type { App } from 'obsidian'
import { tool } from 'ai'
import { appDep } from './tool-context'
import {
	getNodeSize,
	isFileNode,
	normalizeVaultVirtualPath,
	toVaultPath,
} from './vault-native'

const DEFAULT_MAX_ENTRIES = 2000
const HARD_MAX_ENTRIES = 20000
const TOP_LARGEST = 5
export const VAULT_STAT_WALK_DEADLINE_MS = 10_000

export const vaultStatInputSchema = z.object({
	paths: z.array(z.string()),
	recursive: z.optional(z.boolean()),
	pattern: z.optional(z.string()),
	maxEntries: z.optional(z.number()),
})

interface StatRow {
	path: string
	size: number
	mtime?: number
}

interface StatResult {
	exists: boolean
	isDirectory: boolean
	size: number
	mtime?: number
	ctime?: number
}

function formatBytes(size: number) {
	if (size < 1024) return size + ' B'
	if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
	if (size < 1024 * 1024 * 1024) {
		return (size / (1024 * 1024)).toFixed(2) + ' MB'
	}
	return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

function formatTime(value: number | undefined) {
	if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
	return new Date(value).toISOString().replace('T', ' ').slice(0, 19)
}

function patternMatcher(pattern: string | undefined) {
	if (pattern === undefined || pattern === '') return () => true
	const source = pattern
		.split('')
		.map((char) => {
			if (char === '*') return '.*'
			if (char === '?') return '.'
			return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		})
		.join('')
	const regex = new RegExp(source, 'i')
	return (path: string) => regex.test(path)
}

async function statPath(app: App, vaultPath: string): Promise<StatResult> {
	// Prefer the adapter: TFile.stat is a cache that Obsidian does not refresh
	// for files written directly under .agents/ through the adapter, so a newly
	// replaced meta/index can still report the old size (including 0 B).
	const adapterStat = await app.vault.adapter.stat(vaultPath)
	const node = app.vault.getAbstractFileByPath(vaultPath)
	if (isFileNode(node)) {
		const fileStat = (node as { stat?: { mtime?: number; ctime?: number } })
			.stat
		return {
			exists: true,
			isDirectory: false,
			size: adapterStat?.size ?? getNodeSize(node) ?? 0,
			mtime: adapterStat?.mtime ?? fileStat?.mtime,
			ctime: adapterStat?.ctime ?? fileStat?.ctime,
		}
	}
	if (!adapterStat) {
		return { exists: false, isDirectory: false, size: 0 }
	}
	return {
		exists: true,
		isDirectory: adapterStat.type === 'folder',
		size: adapterStat.size ?? 0,
		mtime: adapterStat.mtime,
		ctime: adapterStat.ctime,
	}
}

async function walk(
	app: App,
	vaultPath: string,
	matches: (path: string) => boolean,
	maxEntries: number,
	walkDeadlineMs: number,
) {
	const collected: StatRow[] = []
	const queue: string[] = [vaultPath]
	const visited = new Set<string>()
	const startedAt = Date.now()
	let truncated = false
	let reason: 'maxEntries' | 'deadline' | undefined
	while (queue.length > 0) {
		if (Date.now() - startedAt >= walkDeadlineMs) {
			truncated = true
			reason = 'deadline'
			break
		}
		const current = queue.shift()
		if (current === undefined) break
		if (visited.has(current)) continue
		visited.add(current)
		const listing = await app.vault.adapter.list(current)
		for (const folder of listing.folders) {
			if (!visited.has(folder)) queue.push(folder)
		}
		for (const file of listing.files) {
			if (!matches(file)) continue
			if (collected.length >= maxEntries) {
				truncated = true
				reason = 'maxEntries'
				break
			}
			const stat = await app.vault.adapter.stat(file)
			collected.push({
				path: file,
				size: stat?.size ?? 0,
				mtime: stat?.mtime,
			})
		}
		if (reason) break
	}
	return { collected, truncated, reason }
}

export async function executeVaultStat(
	app: App,
	paths: string[],
	options: {
		recursive?: boolean
		pattern?: string
		maxEntries?: number
		/** Test seam; production uses VAULT_STAT_WALK_DEADLINE_MS. */
		walkDeadlineMs?: number
	} = {},
) {
	const recursive = options.recursive === true
	const requested = Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES)
	const maxEntries = Math.max(1, Math.min(HARD_MAX_ENTRIES, requested))
	const walkDeadlineMs = Math.max(
		0,
		Math.floor(options.walkDeadlineMs ?? VAULT_STAT_WALK_DEADLINE_MS),
	)
	const matches = patternMatcher(options.pattern)
	const blocks: string[] = []

	for (const inputPath of paths) {
		const normalized = normalizeVaultVirtualPath(inputPath)
		const vaultPath = toVaultPath(normalized)
		const stat = await statPath(app, vaultPath)
		if (!stat.exists) {
			blocks.push(`${normalized}: not found`)
			continue
		}
		if (!stat.isDirectory) {
			blocks.push(
				`${normalized}: file, ${formatBytes(stat.size)} (${stat.size} B), mtime=${formatTime(stat.mtime)}, ctime=${formatTime(stat.ctime)}`,
			)
			continue
		}
		if (!recursive) {
			blocks.push(`${normalized}: folder (per-file sizes need recursive=true)`)
			continue
		}
		const { collected, truncated, reason } = await walk(
			app,
			vaultPath,
			matches,
			maxEntries,
			walkDeadlineMs,
		)
		const total = collected.reduce((sum, row) => sum + row.size, 0)
		const largest = [...collected]
			.sort((left, right) => right.size - left.size)
			.slice(0, TOP_LARGEST)
		const summary = [
			`${normalized}: folder, ${collected.length}${truncated ? '+' : ''} files, total ${formatBytes(total)} (${total} B)` +
				(options.pattern ? `, pattern=${options.pattern}` : ''),
			...largest.map(
				(row) =>
					`  ${formatBytes(row.size)}  ${row.path}  (mtime ${formatTime(row.mtime)})`,
			),
		]
		if (truncated) {
			summary.push(
				reason === 'deadline'
					? `  ... (stopped at ${walkDeadlineMs} ms walk budget)`
					: `  ... (stopped at maxEntries=${maxEntries})`,
			)
		}
		blocks.push(summary.join('\n'))
	}

	return blocks.join('\n')
}

export const vaultStatTool = tool({
	description: [
		'Read file and folder metadata from the Obsidian vault: size in bytes and human-readable form, mtime/ctime, and whether the path is a file or a folder.',
		'Use this instead of bash ls -la / du / find when you need file sizes, modification times, folder totals, or files matched by a name pattern.',
		'Use recursive=true on a folder to total its contents (largest 5 files listed); pattern supports * and ? wildcards and is matched against the vault path.',
		'Visible paths use the Obsidian index; hidden dot-paths (for example .agents) are walked through the vault adapter and are supported.',
		'Input paths are vault virtual paths: "/" is the vault root.',
	].join(' '),
	inputSchema: vaultStatInputSchema,
	contextSchema: z.object({ app: appDep }),
	outputSchema: z.string(),
	execute: async ({ paths, recursive, pattern, maxEntries }, { context }) =>
		executeVaultStat(context.app, paths, { recursive, pattern, maxEntries }),
})
