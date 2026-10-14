import { describe, expect, it } from 'vitest'
import type { App } from 'obsidian'
import { executeVaultGrep } from './vault-grep'
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

	it('reports an empty range instead of inverting it past EOF', async () => {
		const { app } = createApp()
		const result = await executeVaultRead(app, '/notes/a.md', 100, 10)
		expect(result.header).toContain('no lines in range')
		expect(result.text).toBe('')
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
