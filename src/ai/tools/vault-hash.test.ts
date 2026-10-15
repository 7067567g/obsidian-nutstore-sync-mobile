import type { App } from 'obsidian'
import { describe, expect, it } from 'vitest'
import { executeVaultHash } from './vault-hash'

function toArrayBuffer(bytes: Uint8Array) {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer
}

function createFakeApp(
	options: {
		files?: Record<string, Uint8Array>
		folders?: string[]
	} = {},
) {
	const files = new Map(Object.entries(options.files ?? {}))
	const folders = new Set(options.folders ?? [])
	const adapter = {
		async exists(path: string) {
			return files.has(path) || folders.has(path)
		},
		async stat(path: string) {
			const file = files.get(path)
			if (file) {
				return { type: 'file', size: file.byteLength, mtime: 1, ctime: 1 }
			}
			if (folders.has(path)) {
				return { type: 'folder', size: 0, mtime: 1, ctime: 1 }
			}
			return null
		},
		async readBinary(path: string) {
			const file = files.get(path)
			if (!file) throw new Error(`ENOENT: ${path}`)
			return toArrayBuffer(file)
		},
	}
	const nodes = new Map<string, unknown>()
	for (const [path, file] of files) {
		nodes.set(path, {
			path,
			stat: { size: file.byteLength, mtime: 1, ctime: 1 },
		})
	}
	for (const folder of folders)
		nodes.set(folder, { path: folder, children: [] })
	const vault = {
		getAbstractFileByPath: (path: string) => nodes.get(path) ?? null,
		readBinary: async (node: { path: string }) => adapter.readBinary(node.path),
		adapter,
	}
	return { vault } as unknown as App
}

const encoder = new TextEncoder()

describe('vault_hash contract', () => {
	it('returns an explicit message for an empty path list', async () => {
		expect(await executeVaultHash(createFakeApp(), [])).toBe(
			'No paths provided.',
		)
	})

	it('rejects more than 200 paths', async () => {
		await expect(
			executeVaultHash(
				createFakeApp(),
				Array.from({ length: 201 }, (_, index) => `/file-${index}.txt`),
			),
		).rejects.toThrow('Too many paths: 201 (max 200).')
	})

	it('reports missing paths and folders without throwing', async () => {
		const app = createFakeApp({ folders: ['docs'] })
		const missing = await executeVaultHash(app, ['/missing.md'])
		expect(missing).toBe('/missing.md: not found')
		const folder = await executeVaultHash(app, ['/docs'])
		expect(folder).toBe('/docs: not a file (use vault_stat for folders)')
	})

	it('skips files above the effective maxFileBytes limit', async () => {
		const app = createFakeApp({
			files: { 'big.bin': new Uint8Array(2000) },
		})
		expect(await executeVaultHash(app, ['/big.bin'], { maxFileBytes: 1 })).toBe(
			'/big.bin: skipped, 2000 bytes exceeds maxFileBytes=1024',
		)
	})

	it('hashes visible files with the documented line format', async () => {
		const app = createFakeApp({ files: { 'note.txt': encoder.encode('abc') } })
		expect(await executeVaultHash(app, ['/note.txt'])).toBe(
			'sha256  ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  /note.txt (3 B)',
		)
	})
})
