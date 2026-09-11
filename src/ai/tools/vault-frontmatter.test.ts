import { describe, expect, it, vi } from 'vitest'
import type { App } from 'obsidian'
import { executeVaultFrontmatter } from './vault-frontmatter'

function createApp() {
	const fileA = { path: 'notes/a.md', name: 'a.md', extension: 'md' }
	const fileB = { path: 'notes/b.md', name: 'b.md', extension: 'md' }
	const contents = new Map<string, string>([
		[fileA.path, '---\ntitle: A\ntags:\n  - alpha\n---\n# A\n'],
		[fileB.path, '# B\n'],
	])
	const frontmatter = new Map<string, Record<string, unknown>>([
		[fileA.path, { title: 'A', tags: ['alpha'] }],
		[fileB.path, {}],
	])
	const process = vi.fn(
		async (file: { path: string }, fn: (data: string) => string) => {
			const next = fn(contents.get(file.path) ?? '')
			contents.set(file.path, next)
			return next
		},
	)
	const app = {
		vault: {
			getRoot: () => ({ path: '', name: '', children: [] }),
			getAbstractFileByPath: (path: string) => {
				if (path === 'notes') {
					return { path: 'notes', name: 'notes', children: [fileA, fileB] }
				}
				if (path === fileA.path) return fileA
				if (path === fileB.path) return fileB
				return null
			},
			getMarkdownFiles: () => [fileA, fileB],
			read: async (file: { path: string }) => contents.get(file.path) ?? '',
			process,
			modify: async (file: { path: string }, data: string) => {
				contents.set(file.path, data)
			},
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => ({
				frontmatter: frontmatter.get(file.path) ?? {},
			}),
		},
	} as unknown as App
	return { app, contents, process }
}

describe('vault_frontmatter', () => {
	it('reads selected frontmatter fields', async () => {
		const { app } = createApp()
		const result = await executeVaultFrontmatter(app, {
			action: 'read',
			path: '/notes',
			keys: ['title'],
		})
		expect(JSON.parse(result)).toEqual([
			{ path: 'notes/a.md', frontmatter: { title: 'A' } },
			{ path: 'notes/b.md', frontmatter: {} },
		])
	})

	it('batch updates frontmatter with one write per file', async () => {
		const { app, contents, process } = createApp()
		const permissionGuard = vi.fn(async () => {})
		const result = await executeVaultFrontmatter(app, {
			action: 'update',
			path: '/notes',
			set: { review: '2026-09-11' },
			permissionGuard,
		})
		expect(result).toContain('Updated frontmatter in 2 file(s)')
		expect(process).toHaveBeenCalledTimes(2)
		expect(permissionGuard).toHaveBeenCalledTimes(1)
		expect(permissionGuard).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'fs',
				fs: expect.objectContaining({
					kind: 'write',
					paths: ['notes/a.md', 'notes/b.md'],
				}),
			}),
		)
		expect(contents.get('notes/b.md')).toContain('review')
	})

	it('deletes frontmatter fields', async () => {
		const { app, contents } = createApp()
		const result = await executeVaultFrontmatter(app, {
			action: 'update',
			path: '/notes/a.md',
			deleteKeys: ['tags'],
		})
		expect(result).toContain('notes/a.md')
		expect(contents.get('notes/a.md')).not.toContain('tags')
	})

	it('preserves frontmatter fields when metadata cache is stale', async () => {
		const file = { path: 'notes/a.md', name: 'a.md', extension: 'md' }
		const contents = new Map([
			[file.path, '---\ntitle: A\nkeep: yes\n---\n# A\n'],
		])
		const app = {
			vault: {
				getRoot: () => ({ path: '', name: '', children: [] }),
				getAbstractFileByPath: (path: string) =>
					path === file.path ? file : null,
				getMarkdownFiles: () => [file],
				read: async () => contents.get(file.path) ?? '',
				process: async (
					_target: { path: string },
					fn: (data: string) => string,
				) => {
					const next = fn(contents.get(file.path) ?? '')
					contents.set(file.path, next)
					return next
				},
				modify: async (_target: { path: string }, data: string) => {
					contents.set(file.path, data)
				},
			},
			metadataCache: {
				getFileCache: () => ({ frontmatter: {} }),
			},
		} as unknown as App
		await executeVaultFrontmatter(app, {
			action: 'update',
			path: '/notes/a.md',
			set: { reviewed: 'yes' },
		})
		const updated = contents.get(file.path) ?? ''
		expect(updated).toContain('title')
		expect(updated).toContain('keep')
		expect(updated).toContain('reviewed')
	})
})
