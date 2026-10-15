import type { Vault } from 'obsidian'
import { describe, expect, it } from 'vitest'
import {
	BashResourceBudget,
	ObsidianVaultFs,
	createBashResourceBudget,
} from './fs'

function toArrayBuffer(bytes: Uint8Array) {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer
}

function createAdapter() {
	const files = new Map<string, Uint8Array>([
		['.agents/t1/x', new TextEncoder().encode('AAA')],
		['.agents/t2/x', new TextEncoder().encode('BBB')],
		['.agents/t1/y', new TextEncoder().encode('YYY')],
	])
	const folders = new Set([
		'.agents',
		'.agents/t1',
		'.agents/t2',
		'.agents/t2/dir',
	])
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
		async mkdir(path: string) {
			folders.add(path)
		},
		async writeBinary(path: string, data: ArrayBuffer) {
			files.set(path, new Uint8Array(data))
		},
		async readBinary(path: string) {
			const file = files.get(path)
			if (!file) throw new Error(`ENOENT: ${path}`)
			return toArrayBuffer(file)
		},
		async remove(path: string) {
			files.delete(path)
		},
		async rmdir(path: string, recursive?: boolean) {
			if (!recursive) {
				folders.delete(path)
				return
			}
			for (const file of [...files.keys()]) {
				if (file === path || file.startsWith(`${path}/`)) files.delete(file)
			}
			for (const folder of [...folders]) {
				if (folder === path || folder.startsWith(`${path}/`))
					folders.delete(folder)
			}
		},
		async list() {
			return { files: [], folders: [] }
		},
	}
	const vault = {
		configDir: '.obsidian',
		adapter,
		getAbstractFileByPath: () => null,
	}
	return { vault: vault as unknown as Vault, files, folders }
}

describe('ObsidianVaultFs mv overwrite semantics', () => {
	it('overwrites an existing destination file by copy + remove', async () => {
		const { vault, files } = createAdapter()
		const fs = new ObsidianVaultFs(vault, [])
		await fs.mv('/.agents/t1/x', '/.agents/t2/x')
		expect(new TextDecoder().decode(files.get('.agents/t2/x'))).toBe('AAA')
		expect(files.has('.agents/t1/x')).toBe(false)
	})

	it('rejects overwriting a directory', async () => {
		const { vault } = createAdapter()
		const fs = new ObsidianVaultFs(vault, [])
		await expect(fs.mv('/.agents/t1/y', '/.agents/t2/dir')).rejects.toThrow(
			/ENOTEMPTY|EISDIR/,
		)
	})

	it('treats an identical source and destination as a no-op', async () => {
		const { vault, files } = createAdapter()
		const fs = new ObsidianVaultFs(vault, [])
		await fs.mv('/.agents/t1/x', '/.agents/t1/x')
		expect(new TextDecoder().decode(files.get('.agents/t1/x'))).toBe('AAA')
	})
})

describe('BashResourceBudget', () => {
	it('rejects writes over the byte budget', () => {
		const budget = createBashResourceBudget({ maxWriteBytes: 2 })
		expect(() => budget.recordWrite(3)).toThrow('TOOL_RESOURCE_EXCEEDED')
	})

	it('rejects writes over the operation budget', () => {
		const budget = createBashResourceBudget({ maxWriteOperations: 1 })
		budget.recordWrite(1)
		expect(() => budget.recordWrite(1)).toThrow('write operation limit')
	})

	it('rejects recursion over the depth budget', () => {
		const budget = new BashResourceBudget({ maxRecursionDepth: 1 })
		expect(() => budget.checkRecursionDepth(1)).not.toThrow()
		expect(() => budget.checkRecursionDepth(2)).toThrow(
			'TOOL_RESOURCE_EXCEEDED',
		)
	})
})

describe('ObsidianVaultFs resource budgets', () => {
	it('blocks a write before touching the vault when the byte budget is exceeded', async () => {
		const { vault, files } = createAdapter()
		const fs = new ObsidianVaultFs(
			vault,
			[],
			undefined,
			undefined,
			createBashResourceBudget({ maxWriteBytes: 2 }),
		)
		await expect(fs.writeFile('/.agents/t1/new', 'ABC')).rejects.toThrow(
			'TOOL_RESOURCE_EXCEEDED',
		)
		expect(files.has('.agents/t1/new')).toBe(false)
	})
})
