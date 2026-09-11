import { describe, expect, it, vi } from 'vitest'
import type { App } from 'obsidian'
import { executeVaultBatchEdit } from './vault-batch-edit'

function createApp() {
	const fileA = { path: 'notes/a.md', name: 'a.md', extension: 'md' }
	const fileB = { path: 'notes/b.md', name: 'b.md', extension: 'md' }
	const contents = new Map<string, string>([
		[fileA.path, 'alpha beta alpha'],
		[fileB.path, 'gamma alpha'],
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
			getRoot: () => ({ path: '', children: [] }),
			getAbstractFileByPath: (path: string) => {
				if (path === 'notes') {
					return { path: 'notes', children: [fileA, fileB] }
				}
				if (path === fileA.path) return fileA
				if (path === fileB.path) return fileB
				return null
			},
			getFiles: () => [fileA, fileB],
			read: async (file: { path: string }) => contents.get(file.path) ?? '',
			process,
			modify: async (file: { path: string }, data: string) => {
				contents.set(file.path, data)
			},
		},
	} as unknown as App
	return { app, contents, process }
}

describe('vault_batch_edit', () => {
	it('applies exact replacements with one batch permission', async () => {
		const { app, contents, process } = createApp()
		const permissionGuard = vi.fn(async () => {})
		const result = await executeVaultBatchEdit(app, {
			path: '/notes',
			replacements: [{ find: 'alpha', replace: 'omega' }],
			permissionGuard,
		})
		expect(result).toContain('Updated 2 file(s), 3 replacement(s)')
		expect(process).toHaveBeenCalledTimes(2)
		expect(permissionGuard).toHaveBeenCalledTimes(1)
		expect(permissionGuard).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'fs',
				fs: {
					kind: 'edit',
					paths: ['notes/a.md', 'notes/b.md'],
				},
			}),
		)
		expect(contents.get('notes/a.md')).toBe('omega beta omega')
		expect(contents.get('notes/b.md')).toBe('gamma omega')
	})

	it('previews without writing or requesting permission', async () => {
		const { app, process } = createApp()
		const permissionGuard = vi.fn(async () => {})
		const result = await executeVaultBatchEdit(app, {
			path: '/notes',
			replacements: [{ find: 'alpha', replace: 'omega' }],
			dryRun: true,
			permissionGuard,
		})
		expect(result).toContain('2 file(s) would change, 3 replacement(s)')
		expect(process).not.toHaveBeenCalled()
		expect(permissionGuard).not.toHaveBeenCalled()
	})

	it('rejects empty find strings', async () => {
		const { app } = createApp()
		await expect(
			executeVaultBatchEdit(app, {
				path: '/notes',
				replacements: [{ find: '', replace: 'x' }],
			}),
		).rejects.toThrow('must not be empty')
	})
})
