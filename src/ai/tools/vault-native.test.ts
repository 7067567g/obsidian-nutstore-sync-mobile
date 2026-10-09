import { describe, expect, it } from 'vitest'
import type { App } from 'obsidian'
import { assertSafeGrepPattern, executeVaultGrep } from './vault-grep'
import { executeVaultList } from './vault-list'
import { executeVaultRead } from './vault-read'

function createApp() {
	const visibleFiles = new Map<string, string>([
		['notes/a.md', '# A\nhello world\nsecond line'],
		['notes/b.md', '# B\nnothing here'],
		['.obsidian/app.json', '{"theme":"dark"}'],
	])
	const fileA = { path: 'notes/a.md', name: 'a.md', extension: 'md' }
	const fileB = { path: 'notes/b.md', name: 'b.md', extension: 'md' }
	const notes = { path: 'notes', name: 'notes', children: [fileA, fileB] }
	const root = { path: '', name: '', children: [notes] }
	const adapter = {
		async exists(path: string) {
			return path === '.agents' || visibleFiles.has(path)
		},
		async read(path: string) {
			const value = visibleFiles.get(path)
			if (value === undefined) throw new Error('missing')
			return value
		},
		async stat(path: string) {
			if (!visibleFiles.has(path)) return null
			return { type: 'file' as const, size: visibleFiles.get(path)!.length }
		},
		async list(path: string) {
			if (path === '.obsidian') {
				return { files: ['.obsidian/app.json'], folders: [] }
			}
			if (path === '.agents') {
				return { files: ['.agents/state.json'], folders: ['.agents/tmp'] }
			}
			return { files: [], folders: [] }
		},
	}
	const vault = {
		getRoot: () => root,
		getAbstractFileByPath: (path: string) =>
			path === 'notes'
				? notes
				: path === 'notes/a.md'
					? fileA
					: path === 'notes/b.md'
						? fileB
						: null,
		getFiles: () => [fileA, fileB],
		cachedRead: async (file: { path: string }) =>
			visibleFiles.get(file.path) ?? '',
		read: async (file: { path: string }) => visibleFiles.get(file.path) ?? '',
		adapter,
	}
	return { app: { vault } as unknown as App, visibleFiles }
}

describe('native vault tools', () => {
	it('lists visible vault folders without adapter recursion', async () => {
		const { app } = createApp()
		const result = await executeVaultList(app, '/', 1)
		expect(result).toContain('[dir] notes')
		expect(result).toContain('notes/a.md')
		expect(result).toContain('notes/b.md')
	})

	it('reads a visible vault file by line range', async () => {
		const { app } = createApp()
		const result = await executeVaultRead(app, '/notes/a.md', 2, 1)
		expect(result.header).toContain('lines 2-2 of 3')
		expect(result.text).toBe('2 | hello world')
	})

	it('greps visible vault files without browser-bash', async () => {
		const { app } = createApp()
		const result = await executeVaultGrep(app, '/notes', 'hello')
		expect(result).toContain('notes/a.md:2')
		expect(result).toContain('hello world')
		expect(result).not.toContain('notes/b.md')
	})

	it('reads explicit hidden files through the adapter only', async () => {
		const { app } = createApp()
		const result = await executeVaultRead(app, '/.obsidian/app.json', 1, 10)
		expect(result.text).toContain('theme')
	})

	it('marks hidden adapter directories as directories', async () => {
		const { app } = createApp()
		const result = await executeVaultList(app, '/.agents', 0)
		expect(result).toContain('[dir] tmp')
		expect(result).toContain('state.json')
	})
})

function createGrepFixture(extra: Record<string, string> = {}) {
	const contents = new Map<string, string>([
		['notes/a.md', '# A\nhello markdown'],
		['notes/b.md', '# B\nhello markdown second'],
		['notes/c.json', '{"note":"hello json"}'],
		...Object.entries(extra),
	])
	const makeFile = (path: string) => ({
		path,
		name: path.split('/').at(-1) ?? path,
		extension: path.split('.').at(-1) ?? '',
		stat: { size: contents.get(path)?.length ?? 0 },
	})
	const files = [...contents.keys()].map(makeFile)
	const byPath = new Map(files.map((file) => [file.path, file]))
	const notesFolder = {
		path: 'notes',
		name: 'notes',
		children: files,
	}
	const vault = {
		getRoot: () => ({ path: '', name: '', children: [notesFolder] }),
		getAbstractFileByPath: (path: string) =>
			path === 'notes' ? notesFolder : (byPath.get(path) ?? null),
		getFiles: () => files,
		getMarkdownFiles: () => files.filter((file) => file.extension === 'md'),
		cachedRead: async (file: { path: string }) => contents.get(file.path) ?? '',
		read: async (file: { path: string }) => contents.get(file.path) ?? '',
		adapter: {
			stat: async (path: string) =>
				contents.has(path)
					? { type: 'file' as const, size: contents.get(path)!.length }
					: null,
			read: async (path: string) => contents.get(path) ?? '',
			exists: async (path: string) => contents.has(path),
		},
	}
	return {
		app: { vault } as unknown as App,
		contents,
		files,
	}
}

describe('vault_grep budgeted scope', () => {
	it('defaults folder/root searches to markdown and reports skipped non-md', async () => {
		const { app } = createGrepFixture()
		const result = await executeVaultGrep(app, '/notes', 'hello')
		expect(result).toContain('notes/a.md')
		expect(result).not.toContain('notes/c.json')
		expect(result).toContain('complete: scanned 2 file(s)')
		expect(result).toContain('skipped 1 non-md')
	})

	it('explicit glob expands to other text formats', async () => {
		const { app } = createGrepFixture()
		const result = await executeVaultGrep(app, '/notes', 'hello', {
			glob: '*.json',
		})
		expect(result).toContain('notes/c.json:1')
		expect(result).not.toContain('notes/a.md')
	})

	it('limits folder search to requested extensions', async () => {
		const { app } = createGrepFixture()
		const result = await executeVaultGrep(app, '/notes', 'hello', {
			extensions: ['json'],
		})
		expect(result).toContain('notes/c.json')
		expect(result).not.toContain('notes/a.md')
	})

	it('widens to attachments only when explicitly requested', async () => {
		const { app } = createGrepFixture({ 'notes/d.png': 'hello png' })
		const defaultResult = await executeVaultGrep(app, '/notes', 'hello')
		expect(defaultResult).not.toContain('notes/d.png')
		const result = await executeVaultGrep(app, '/notes', 'hello', {
			includeAttachments: true,
		})
		expect(result).toContain('notes/d.png')
	})

	it('orders shallow markdown candidates before deeper files', async () => {
		const { app } = createGrepFixture({
			'notes/deep/z.md': '# Z\nhello deep',
		})
		const result = await executeVaultGrep(app, '/notes', 'hello')
		const shallow = result.indexOf('notes/a.md')
		const deep = result.indexOf('notes/deep/z.md')
		expect(shallow).toBeGreaterThanOrEqual(0)
		expect(deep).toBeGreaterThan(shallow)
	})

	it('keeps explicit single-file behavior unchanged', async () => {
		const { app } = createGrepFixture()
		const result = await executeVaultGrep(app, '/notes/c.json', 'hello')
		expect(result).toContain('notes/c.json:1')
	})

	it('marks maxFiles stoppage as incomplete, never as no matches', async () => {
		const { app } = createGrepFixture()
		const result = await executeVaultGrep(app, '/notes', 'hello', {
			maxFiles: 1,
		})
		expect(result).toContain('matches')
		expect(result).toContain('result incomplete')
		expect(result).not.toContain(': no matches')
	})

	it('marks maxResults stoppage as incomplete, never complete', async () => {
		const { app } = createGrepFixture()
		const result = await executeVaultGrep(app, '/notes', 'hello', {
			maxResults: 1,
		})
		expect(result).toContain('result incomplete')
		expect(result).toContain('maxResults=1')
		expect(result).not.toContain('(complete:')
	})

	it('marks byte-budget stoppage as incomplete', async () => {
		const { app } = createGrepFixture()
		const result = await executeVaultGrep(app, '/notes', 'hello', {
			maxTotalBytes: 1,
		})
		expect(result).toContain('stopped before completion')
		expect(result).toContain('result incomplete')
		expect(result).not.toContain(': no matches')
	})

	it('rejects nested-quantifier patterns before scanning', async () => {
		const { app } = createGrepFixture()
		await expect(executeVaultGrep(app, '/notes', '^(a+)+b$')).rejects.toThrow(
			'REGEX_TOO_COMPLEX',
		)
	})

	it('rejects overlong patterns before scanning', async () => {
		const { app } = createGrepFixture()
		await expect(
			executeVaultGrep(app, '/notes', 'a'.repeat(401)),
		).rejects.toThrow('pattern exceeds')
	})

	it('allows ordinary anchored patterns', () => {
		expect(() => assertSafeGrepPattern('^hello\\s+world$')).not.toThrow()
		expect(() => assertSafeGrepPattern('(?:foo|bar)+')).not.toThrow()
		expect(() => assertSafeGrepPattern('(\\d{4})+')).not.toThrow()
	})

	it('honors abortSignal before reading a file', async () => {
		const { app } = createGrepFixture()
		const controller = new AbortController()
		controller.abort()
		await expect(
			executeVaultGrep(app, '/notes', 'hello', {
				abortSignal: controller.signal,
			}),
		).rejects.toMatchObject({ name: 'AbortError' })
	})
})
