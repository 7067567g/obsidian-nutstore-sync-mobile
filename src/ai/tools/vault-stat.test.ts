import type { App } from 'obsidian'
import { describe, expect, it } from 'vitest'
import { executeVaultStat } from './vault-stat'

function createFakeApp(files: Record<string, number>, folders: string[]) {
	const adapter = {
		async stat(path: string) {
			const size = files[path]
			if (typeof size === 'number') {
				return { type: 'file', size, mtime: 1, ctime: 1 }
			}
			if (folders.includes(path)) {
				return { type: 'folder', size: 0, mtime: 1, ctime: 1 }
			}
			return null
		},
		async list(path: string) {
			const prefix = path ? `${path}/` : ''
			return {
				files: Object.keys(files).filter((file) => file.startsWith(prefix)),
				folders: folders.filter((folder) => folder.startsWith(prefix)),
			}
		},
	}
	const nodes = new Map<string, unknown>()
	for (const [path, size] of Object.entries(files)) {
		nodes.set(path, { path, stat: { size, mtime: 1, ctime: 1 } })
	}
	for (const folder of folders)
		nodes.set(folder, { path: folder, children: [] })
	const vault = {
		getAbstractFileByPath: (path: string) => nodes.get(path) ?? null,
		adapter,
	}
	return { vault } as unknown as App
}

describe('vault_stat contract', () => {
	it('reports file size and not-found paths', async () => {
		const app = createFakeApp({ 'note.md': 3 }, [])
		expect(await executeVaultStat(app, ['/note.md'])).toContain('3 B')
		expect(await executeVaultStat(app, ['/missing.md'])).toBe(
			'/missing.md: not found',
		)
	})

	it('totals a recursive folder listing', async () => {
		const app = createFakeApp({ 'docs/a.txt': 5, 'docs/b.txt': 7 }, ['docs'])
		const result = await executeVaultStat(app, ['/docs'], { recursive: true })
		expect(result).toContain('2 files')
		expect(result).toContain('total 12 B')
	})
})

describe('vault_stat walk budget', () => {
	it('reports a deadline stop instead of walking forever', async () => {
		const app = createFakeApp({ 'docs/a.txt': 5 }, ['docs'])
		const result = await executeVaultStat(app, ['/docs'], {
			recursive: true,
			walkDeadlineMs: 0,
		})
		expect(result).toContain('walk budget')
		expect(result).toContain('0+ files')
	})
})

describe('vault_stat stale node cache', () => {
	it('prefers adapter size over a stale TFile.stat size', async () => {
		const app = {
			vault: {
				getAbstractFileByPath: (path: string) =>
					path === 'meta.json'
						? { path, stat: { size: 0, mtime: 1, ctime: 1 } }
						: null,
				adapter: {
					async stat(path: string) {
						return path === 'meta.json'
							? { type: 'file', size: 3114, mtime: 2, ctime: 2 }
							: null
					},
				},
			},
		} as unknown as App
		const result = await executeVaultStat(app, ['/meta.json'])
		expect(result).toContain('3.0 KB')
		expect(result).toContain('3114 B')
		expect(result).not.toContain('0 B')
	})
})
