import { describe, expect, it } from 'vitest'
import type { App } from 'obsidian'
import {
	addMemoryItem,
	formatMemoryItems,
	MEMORY_FILE_PATH,
	MEMORY_LEGACY_ARCHIVE_DIR,
	MEMORY_LEGACY_CATALOG_DIR,
	MEMORY_LEGACY_MARKER_PATH,
	MEMORY_MAX_ITEM_CHARS,
	MEMORY_MAX_TOTAL_CHARS,
	memoryTool,
	parseLegacyArchiveFile,
	parseMemoryItems,
	removeMemoryItems,
} from './memory'

function createApp(options?: { latencyMs?: number }) {
	const files = new Map<string, string>()
	const folders = new Set<string>()
	const delay = async () => {
		if (options?.latencyMs) {
			await new Promise((resolve) =>
				window.setTimeout(resolve, options.latencyMs),
			)
		}
	}
	const list = async (path: string) => {
		const prefix = path.endsWith('/') ? path : `${path}/`
		const listedFiles: string[] = []
		const listedFolders = new Set<string>()
		for (const file of files.keys()) {
			if (!file.startsWith(prefix)) continue
			const rest = file.slice(prefix.length)
			if (rest.includes('/'))
				listedFolders.add(`${prefix}${rest.split('/')[0]}`)
			else listedFiles.push(file)
		}
		for (const folder of folders) {
			if (!folder.startsWith(prefix)) continue
			const rest = folder.slice(prefix.length)
			if (rest && !rest.includes('/')) listedFolders.add(folder)
		}
		return { files: listedFiles.sort(), folders: [...listedFolders].sort() }
	}
	const isFolder = (path: string) =>
		folders.has(path) ||
		[...files.keys()].some((file) => file.startsWith(`${path}/`))
	const adapter = {
		exists: async (path: string) => files.has(path) || isFolder(path),
		read: async (path: string) => {
			await delay()
			const value = files.get(path)
			if (value === undefined) throw new Error(`ENOENT: ${path}`)
			return value
		},
		write: async (path: string, data: string) => {
			await delay()
			files.set(path, data)
		},
		list,
		mkdir: async (path: string) => {
			folders.add(path)
		},
		remove: async (path: string) => {
			files.delete(path)
		},
		rmdir: async (path: string, recursive: boolean) => {
			if (!recursive) {
				if ((await list(path)).files.length > 0) {
					throw new Error(`ENOTEMPTY: ${path}`)
				}
				folders.delete(path)
				return
			}
			const prefix = `${path}/`
			for (const file of [...files.keys()]) {
				if (file.startsWith(prefix)) files.delete(file)
			}
			for (const folder of [...folders]) {
				if (folder === path || folder.startsWith(prefix)) folders.delete(folder)
			}
		},
		stat: async (path: string) =>
			files.has(path)
				? { type: 'file', size: files.get(path)!.length, mtime: Date.now() }
				: isFolder(path)
					? { type: 'folder', size: 0, mtime: Date.now() }
					: null,
	}
	const app = {
		vault: {
			configDir: '.obsidian',
			adapter,
			getAbstractFileByPath: () => null,
		},
	} as unknown as App
	return { app, files, folders }
}

type MemoryExecute = (
	params: {
		action: 'add' | 'remove' | 'list'
		content?: string
		query?: string
	},
	options: { context: { app: App }; toolCallId: string },
) => Promise<string>

describe('memory tool', () => {
	it('round-trips single-file items and dedupes adds', async () => {
		const { app, files } = createApp()
		const execute = memoryTool.execute as unknown as MemoryExecute

		await execute(
			{ action: 'add', content: '用户偏好中文回复' },
			{ context: { app }, toolCallId: 'call-1' },
		)
		await execute(
			{ action: 'add', content: '用户偏好中文回复' },
			{ context: { app }, toolCallId: 'call-2' },
		)
		const list = await execute(
			{ action: 'list' },
			{ context: { app }, toolCallId: 'call-3' },
		)
		expect(list).toContain('用户偏好中文回复')
		expect(parseMemoryItems(files.get(MEMORY_FILE_PATH) ?? '')).toHaveLength(1)

		const removed = await execute(
			{ action: 'remove', query: '中文回复' },
			{ context: { app }, toolCallId: 'call-4' },
		)
		expect(removed).toContain('Removed 1')
		expect(parseMemoryItems(files.get(MEMORY_FILE_PATH) ?? '')).toHaveLength(0)
	})

	it('serializes concurrent adds so both items survive', async () => {
		const { app, files } = createApp({ latencyMs: 5 })
		const execute = memoryTool.execute as unknown as MemoryExecute

		await Promise.all([
			execute(
				{ action: 'add', content: 'first fact' },
				{ context: { app }, toolCallId: 'call-a' },
			),
			execute(
				{ action: 'add', content: 'second fact' },
				{ context: { app }, toolCallId: 'call-b' },
			),
		])

		const items = parseMemoryItems(files.get(MEMORY_FILE_PATH) ?? '')
		expect(items).toHaveLength(2)
		expect(items).toEqual(expect.arrayContaining(['first fact', 'second fact']))
	})

	it('rejects items over 300 chars and totals over 8000', () => {
		expect(() =>
			addMemoryItem([], 'x'.repeat(MEMORY_MAX_ITEM_CHARS + 1)),
		).toThrow('MEMORY_ITEM_TOO_LONG')

		const items = Array.from({ length: 27 }, (_, index) =>
			`${index}`.padEnd(299, 'x'),
		)
		expect(() =>
			addMemoryItem(items, 'final item that would exceed the cap'),
		).toThrow('MEMORY_LIMIT_EXCEEDED')
		expect(formatMemoryItems(items).length).toBeGreaterThan(
			MEMORY_MAX_TOTAL_CHARS,
		)
		expect(removeMemoryItems(items, '0').length).toBeLessThan(items.length)
	})

	it('migrates legacy archive bullets, then removes archive/catalog only', async () => {
		const { app, files } = createApp()
		files.set(MEMORY_FILE_PATH, '- existing fact\n')
		files.set(
			`${MEMORY_LEGACY_ARCHIVE_DIR}/2026/2026-09-13.md`,
			'# 2026-09-13\n- legacy fact one\n- legacy fact two\n',
		)
		files.set(
			`${MEMORY_LEGACY_CATALOG_DIR}/2026.tsv`,
			'2026-09-13\tarchive/2026/2026-09-13.md\n',
		)
		const execute = memoryTool.execute as unknown as MemoryExecute

		const result = await execute(
			{ action: 'list' },
			{ context: { app }, toolCallId: 'call-migrate' },
		)

		expect(result).toContain('Migrated 2 legacy memory item(s)')
		const items = parseMemoryItems(files.get(MEMORY_FILE_PATH) ?? '')
		expect(items).toEqual(
			expect.arrayContaining([
				'existing fact',
				'legacy fact one',
				'legacy fact two',
			]),
		)
		expect(files.has(MEMORY_FILE_PATH)).toBe(true)
		expect(files.has(`${MEMORY_LEGACY_ARCHIVE_DIR}/2026/2026-09-13.md`)).toBe(
			false,
		)
		expect(files.has(`${MEMORY_LEGACY_CATALOG_DIR}/2026.tsv`)).toBe(false)
		expect(files.has(MEMORY_LEGACY_MARKER_PATH)).toBe(true)
	})

	it('does not rescan after a completed migration', async () => {
		const { app, files } = createApp()
		files.set(`${MEMORY_LEGACY_ARCHIVE_DIR}/old.md`, '- only fact\n')
		const execute = memoryTool.execute as unknown as MemoryExecute
		await execute({ action: 'list' }, { context: { app }, toolCallId: 'a' })
		const markerBefore = files.get(MEMORY_LEGACY_MARKER_PATH)
		await execute({ action: 'list' }, { context: { app }, toolCallId: 'b' })
		expect(files.get(MEMORY_LEGACY_MARKER_PATH)).toBe(markerBefore)
		expect(parseMemoryItems(files.get(MEMORY_FILE_PATH) ?? '')).toEqual([
			'only fact',
		])
	})

	it('keeps legacy files when an archive line is not representable', async () => {
		const { app, files } = createApp()
		files.set(
			`${MEMORY_LEGACY_ARCHIVE_DIR}/journal.md`,
			'- bullet fact\nfree-form journal line\n',
		)
		const execute = memoryTool.execute as unknown as MemoryExecute
		await execute({ action: 'list' }, { context: { app }, toolCallId: 'a' })

		expect(parseMemoryItems(files.get(MEMORY_FILE_PATH) ?? '')).toEqual([
			'bullet fact',
		])
		expect(files.has(`${MEMORY_LEGACY_ARCHIVE_DIR}/journal.md`)).toBe(true)
	})

	it('keeps legacy files when the total cap would drop an item', async () => {
		const { app, files } = createApp()
		const fullItems = Array.from({ length: 26 }, () =>
			'x'.repeat(MEMORY_MAX_ITEM_CHARS - 1),
		)
		files.set(MEMORY_FILE_PATH, formatMemoryItems(fullItems))
		files.set(
			`${MEMORY_LEGACY_ARCHIVE_DIR}/overflow.md`,
			`- ${'y'.repeat(MEMORY_MAX_ITEM_CHARS)}\n`,
		)
		const execute = memoryTool.execute as unknown as MemoryExecute
		await execute({ action: 'list' }, { context: { app }, toolCallId: 'a' })

		expect(parseMemoryItems(files.get(MEMORY_FILE_PATH) ?? '')).toHaveLength(26)
		expect(files.has(`${MEMORY_LEGACY_ARCHIVE_DIR}/overflow.md`)).toBe(true)
	})

	it('does not create MEMORY.md when there is no legacy tree', async () => {
		const { app, files } = createApp()
		const execute = memoryTool.execute as unknown as MemoryExecute
		await execute({ action: 'list' }, { context: { app }, toolCallId: 'a' })
		expect(files.has(MEMORY_FILE_PATH)).toBe(false)
	})

	it('counts non-bullet archive lines instead of silently dropping them', () => {
		const parsed = parseLegacyArchiveFile(
			'# heading\n- one\n* two\nprose\n---\n',
		)
		expect(parsed.items).toEqual(['one', 'two'])
		expect(parsed.unparsedLines).toBe(1)
	})
})
