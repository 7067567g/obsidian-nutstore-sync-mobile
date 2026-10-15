import type { App } from 'obsidian'
import { describe, expect, it } from 'vitest'
import { executeVaultJson } from './vault-json'

function createFakeApp(files: Record<string, string>) {
	const nodes = new Map<string, { path: string; stat: { size: number } }>()
	for (const path of Object.keys(files)) {
		nodes.set(path, { path, stat: { size: files[path]!.length } })
	}
	const vault = {
		getAbstractFileByPath: (path: string) => nodes.get(path) ?? null,
		cachedRead: async (node: { path: string }) => files[node.path],
		read: async (node: { path: string }) => files[node.path],
		adapter: {
			async read(path: string) {
				const text = files[path]
				if (text === undefined) throw new Error(`ENOENT: ${path}`)
				return text
			},
			async stat(path: string) {
				const text = files[path]
				if (text === undefined) return null
				return { type: 'file' as const, size: text.length }
			},
		},
	}
	return { vault } as unknown as App
}

describe('vault_json contract', () => {
	it('queries keys and one aggregate from a JSON file', async () => {
		const app = createFakeApp({
			'data.json': '{"a":1,"b":[2,3]}',
		})
		expect(await executeVaultJson(app, '/data.json', '.a')).toContain('1')
		expect(await executeVaultJson(app, '/data.json', '.b[*] | sum')).toContain(
			'5',
		)
	})

	it('counts matched values while length returns collection length', async () => {
		const app = createFakeApp({ 'data.json': '{"pad":[1,2,3]}' })
		expect(await executeVaultJson(app, '/data.json', '.pad | count')).toContain(
			'\n1',
		)
		expect(
			await executeVaultJson(app, '/data.json', '.pad | length'),
		).toContain('\n3')
	})

	it('rejects oversized files before reading them', async () => {
		let readCalls = 0
		const bigNode = {
			path: 'big.json',
			stat: { size: 21 * 1024 * 1024 },
		}
		const app = {
			vault: {
				getAbstractFileByPath: () => bigNode,
				cachedRead: async () => {
					readCalls += 1
					return '{}'
				},
				read: async () => {
					readCalls += 1
					return '{}'
				},
				adapter: {
					stat: async () => ({ type: 'file' as const, size: 22 * 1024 * 1024 }),
					read: async () => {
						readCalls += 1
						return '{}'
					},
				},
			},
		} as unknown as App
		await expect(executeVaultJson(app, '/big.json', '.a')).rejects.toThrow(
			'File is too large for vault_json',
		)
		expect(readCalls).toBe(0)
	})

	it('rejects multiple aggregates explicitly', async () => {
		const app = createFakeApp({ 'data.json': '{"a":{"b":{"c":1}}}' })
		await expect(
			executeVaultJson(app, '/data.json', '.a | .b | .c'),
		).rejects.toThrow('Only one aggregate is supported')
	})
})
