import type { App } from 'obsidian'
import { tool } from 'ai'
import { z } from 'zod/mini'
import {
	readLocalText,
	removeLocalPath,
	writeLocalText,
} from '~/utils/local-vault-io'
import { appDep } from './tool-context'

/**
 * Single-file long-term memory.
 *
 * Replaces the previous memory subagent: the master agent owns a bounded
 * `MEMORY.md` file. Every item is one bullet line; total content and item
 * length are hard-capped so memory can never become a context sink.
 *
 * MEM-02: the old implementation also left `memory/archive/**` and
 * `memory/catalog/**` behind. The active tool only reads/writes `MEMORY.md`,
 * so the legacy tree is migrated once (bullets copied into MEMORY.md, deduped
 * and bounded) and only then removed. Removal is skipped when any archive line
 * could not be represented or a cap would drop an item; the legacy tree is the
 * backup, so `MEMORY.md` is never deleted or truncated by this path.
 */

export const MEMORY_DIR = '.agents/nutstore-sync/memory'
export const MEMORY_FILE_PATH = `${MEMORY_DIR}/MEMORY.md`
export const MEMORY_LEGACY_ARCHIVE_DIR = `${MEMORY_DIR}/archive`
export const MEMORY_LEGACY_CATALOG_DIR = `${MEMORY_DIR}/catalog`
export const MEMORY_LEGACY_MARKER_PATH = `${MEMORY_DIR}/.legacy-migration.json`
export const MEMORY_MAX_TOTAL_CHARS = 8000
export const MEMORY_MAX_ITEM_CHARS = 300

const LEGACY_SCAN_FILE_CAP = 500
const LEGACY_SCAN_MAX_DEPTH = 6

export const memoryInputSchema = z.object({
	action: z.enum(['add', 'remove', 'list']),
	content: z.optional(z.string()),
	query: z.optional(z.string()),
})

export function parseMemoryItems(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith('- '))
		.map((line) => line.slice(2).trim())
		.filter(Boolean)
}

export function formatMemoryItems(items: readonly string[]): string {
	if (items.length === 0) return ''
	return `${items.map((item) => `- ${item}`).join('\n')}\n`
}

function normalizeMemoryText(text: string) {
	return text.replace(/\s+/g, ' ').trim()
}

export function addMemoryItem(
	items: readonly string[],
	content: string,
): string[] {
	const normalized = normalizeMemoryText(content)
	if (!normalized) throw new Error('MEMORY_EMPTY_ITEM')
	if (normalized.length > MEMORY_MAX_ITEM_CHARS) {
		throw new Error(
			`MEMORY_ITEM_TOO_LONG: item exceeds ${MEMORY_MAX_ITEM_CHARS} characters`,
		)
	}
	const key = normalized.toLowerCase()
	if (items.some((item) => item.toLowerCase() === key)) return [...items]
	const next = [...items, normalized]
	if (formatMemoryItems(next).length > MEMORY_MAX_TOTAL_CHARS) {
		throw new Error(
			`MEMORY_LIMIT_EXCEEDED: total memory exceeds ${MEMORY_MAX_TOTAL_CHARS} characters`,
		)
	}
	return next
}

export function removeMemoryItems(
	items: readonly string[],
	query: string,
): string[] {
	const normalized = normalizeMemoryText(query).toLowerCase()
	if (!normalized) throw new Error('MEMORY_EMPTY_QUERY')
	return items.filter((item) => !item.toLowerCase().includes(normalized))
}

/**
 * Per-app serialization for read-modify-write calls. The model can issue two
 * `memory add` calls inside one assistant message; without a queue both read
 * the same snapshot and the second write silently drops the first item
 * (MEM-01). The queue is per App so parallel test/vault apps stay isolated.
 */
const memoryWriteQueues = new WeakMap<App, Promise<unknown>>()

function enqueueMemoryWrite<T>(app: App, task: () => Promise<T>): Promise<T> {
	const previous = memoryWriteQueues.get(app) ?? Promise.resolve()
	const next = previous.then(task, task)
	memoryWriteQueues.set(
		app,
		next.then(
			() => undefined,
			() => undefined,
		),
	)
	return next
}

async function readMemory(app: App) {
	try {
		return parseMemoryItems(await readLocalText(app.vault, MEMORY_FILE_PATH))
	} catch {
		return []
	}
}

/** One parsed legacy markdown file: bullet items plus non-bullet content lines. */
export function parseLegacyArchiveFile(text: string): {
	items: string[]
	unparsedLines: number
} {
	const items: string[] = []
	let unparsedLines = 0
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim()
		if (!line) continue
		if (/^#{1,6}\s/.test(line)) continue
		if (/^-{3,}$/.test(line)) continue
		if (line.startsWith('- ') || line.startsWith('* ')) {
			const item = line.slice(2).trim()
			if (item) items.push(item)
			else unparsedLines += 1
			continue
		}
		// A non-bullet content line means we cannot prove the archive is fully
		// represented by MEMORY.md, so cleanup must stay blocked.
		unparsedLines += 1
	}
	return { items, unparsedLines }
}

/** Copy legacy bullets into the bounded single file, stopping at the caps. */
export function mergeLegacyMemoryItems(
	items: readonly string[],
	legacyItems: readonly string[],
): { items: string[]; added: number; skipped: number } {
	let next = [...items]
	let added = 0
	let skipped = 0
	for (const legacy of legacyItems) {
		try {
			const merged = addMemoryItem(next, legacy)
			if (merged.length > next.length) {
				next = merged
				added += 1
			}
		} catch {
			skipped += 1
		}
	}
	return { items: next, added, skipped }
}

export interface LegacyMemoryMigrationResult {
	found: boolean
	archivedFiles: number
	catalogFiles: number
	migrated: number
	skipped: number
	/** none = no legacy tree; blocked = files kept because not fully represented. */
	cleanup: 'none' | 'completed' | 'blocked'
	errors: string[]
}

async function listLegacyFiles(app: App, root: string): Promise<string[]> {
	const files: string[] = []
	const stack: Array<{ path: string; depth: number }> = [
		{ path: root, depth: 0 },
	]
	while (stack.length > 0 && files.length < LEGACY_SCAN_FILE_CAP) {
		const current = stack.pop()
		if (!current) break
		let listed: { files: string[]; folders: string[] }
		try {
			listed = await app.vault.adapter.list(current.path)
		} catch {
			continue
		}
		for (const file of listed.files) {
			if (files.length >= LEGACY_SCAN_FILE_CAP) break
			files.push(file)
		}
		if (current.depth >= LEGACY_SCAN_MAX_DEPTH) continue
		for (const folder of listed.folders) {
			stack.push({ path: folder, depth: current.depth + 1 })
		}
	}
	return files
}

async function writeMigrationMarker(
	app: App,
	result: LegacyMemoryMigrationResult,
) {
	try {
		await writeLocalText(
			app.vault,
			MEMORY_LEGACY_MARKER_PATH,
			`${JSON.stringify({ version: 1, migratedAt: new Date().toISOString(), ...result })}\n`,
		)
	} catch {
		/* Marker is advisory; the legacy tree itself is the recovery path. */
	}
}

/**
 * Migrate the pre-1.5.7 `archive/` bullets into `MEMORY.md` and, only when the
 * migration is provably complete, remove `archive/` + `catalog/`. The catalog
 * is an index over the archive, not a second content source.
 */
export async function migrateLegacyMemory(
	app: App,
	options: { cleanup?: boolean } = {},
): Promise<LegacyMemoryMigrationResult> {
	const result: LegacyMemoryMigrationResult = {
		found: false,
		archivedFiles: 0,
		catalogFiles: 0,
		migrated: 0,
		skipped: 0,
		cleanup: 'none',
		errors: [],
	}
	// A completed migration leaves a marker; do not rescan on every call.
	try {
		if (await app.vault.adapter.exists(MEMORY_LEGACY_MARKER_PATH)) {
			const marker = JSON.parse(
				await readLocalText(app.vault, MEMORY_LEGACY_MARKER_PATH),
			) as { cleanup?: unknown }
			if (marker.cleanup === 'completed') return result
		}
	} catch {
		/* A corrupt marker just means "scan again". */
	}

	const archived = await listLegacyFiles(app, MEMORY_LEGACY_ARCHIVE_DIR)
	const catalog = await listLegacyFiles(app, MEMORY_LEGACY_CATALOG_DIR)
	result.archivedFiles = archived.length
	result.catalogFiles = catalog.length
	result.found = archived.length > 0 || catalog.length > 0
	if (!result.found) return result

	const legacyItems: string[] = []
	let unparsedLines = 0
	for (const file of archived) {
		try {
			const parsed = parseLegacyArchiveFile(
				await readLocalText(app.vault, file),
			)
			legacyItems.push(...parsed.items)
			unparsedLines += parsed.unparsedLines
		} catch (error) {
			result.errors.push(
				`${file}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	const merged = mergeLegacyMemoryItems(await readMemory(app), legacyItems)
	result.migrated = merged.added
	result.skipped = merged.skipped
	if (merged.added > 0) {
		try {
			await writeLocalText(
				app.vault,
				MEMORY_FILE_PATH,
				formatMemoryItems(merged.items),
			)
		} catch (error) {
			result.errors.push(
				`MEMORY.md: ${error instanceof Error ? error.message : String(error)}`,
			)
			result.skipped += merged.added
			result.migrated = 0
			return result
		}
	}

	const complete =
		options.cleanup === true &&
		result.skipped === 0 &&
		unparsedLines === 0 &&
		result.errors.length === 0
	if (!complete) {
		if (options.cleanup === true) result.cleanup = 'blocked'
		await writeMigrationMarker(app, result)
		return result
	}
	for (const root of [MEMORY_LEGACY_ARCHIVE_DIR, MEMORY_LEGACY_CATALOG_DIR]) {
		try {
			await removeLocalPath(app.vault, root, true)
		} catch (error) {
			result.errors.push(
				`${root}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
	result.cleanup = result.errors.length === 0 ? 'completed' : 'blocked'
	await writeMigrationMarker(app, result)
	return result
}

function migrationSuffix(result: LegacyMemoryMigrationResult) {
	if (result.migrated > 0) {
		return `\nMigrated ${result.migrated} legacy memory item(s) from archive/.`
	}
	if (result.cleanup === 'completed') {
		return '\nRemoved the empty legacy memory archive/catalog.'
	}
	return ''
}

export const memoryTool = tool({
	description: [
		'Add, list, or remove durable cross-session facts in the single external MEMORY.md file.',
		`Keep each item under ${MEMORY_MAX_ITEM_CHARS} characters and the whole memory under ${MEMORY_MAX_TOTAL_CHARS} characters.`,
		'Use list before add when unsure. Use remove with a distinctive substring; do not guess.',
		'Store important user preferences, decisions, and unfinished work — not transient task details or hidden file contents.',
	].join(' '),
	inputSchema: memoryInputSchema,
	contextSchema: z.object({ app: appDep }),
	outputSchema: z.string(),
	execute: async (params, { context }) =>
		enqueueMemoryWrite(context.app, async () => {
			const migration = await migrateLegacyMemory(context.app, {
				cleanup: true,
			})
			const items = await readMemory(context.app)
			if (params.action === 'list') {
				if (items.length === 0) return `(empty)${migrationSuffix(migration)}`
				return `${items.length} memory item(s):\n${items
					.map((item) => `- ${item}`)
					.join('\n')}${migrationSuffix(migration)}`
			}
			if (params.action === 'add') {
				const next = addMemoryItem(items, params.content ?? '')
				await writeLocalText(
					context.app.vault,
					MEMORY_FILE_PATH,
					formatMemoryItems(next),
				)
				return `Added memory item (${next.length} total).${migrationSuffix(migration)}`
			}
			const next = removeMemoryItems(items, params.query ?? '')
			await writeLocalText(
				context.app.vault,
				MEMORY_FILE_PATH,
				formatMemoryItems(next),
			)
			return `Removed ${items.length - next.length} memory item(s) (${next.length} left).${migrationSuffix(migration)}`
		}),
})
