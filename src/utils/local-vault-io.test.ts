import { afterEach, describe, expect, it } from 'vitest'
import { Platform, type Vault } from 'obsidian'
import {
	assertNoLocalPathTraversal,
	existsLocalPath,
	isAdapterPath,
	readLocalText,
	removeLocalPath,
	writeLocalText,
	writeLocalTextAtomic,
} from './local-vault-io'

class MemoryAdapter {
	files = new Map<string, string | ArrayBuffer>()
	dirs = new Set<string>()
	writes: string[] = []

	async exists(path: string) {
		return this.files.has(path) || this.dirs.has(path)
	}

	async mkdir(path: string) {
		this.dirs.add(path)
	}

	async list(path: string) {
		const prefix = path ? `${path}/` : ''
		const files: string[] = []
		const folders = new Set<string>()
		for (const file of this.files.keys()) {
			if (!file.startsWith(prefix)) continue
			const rest = file.slice(prefix.length)
			if (rest.includes('/')) folders.add(`${prefix}${rest.split('/')[0]}`)
			else files.push(file)
		}
		return { files, folders: [...folders] }
	}

	async read(path: string) {
		const content = this.files.get(path)
		if (typeof content !== 'string') throw new Error(`not a text file: ${path}`)
		return content
	}

	async readBinary(path: string) {
		const content = this.files.get(path)
		if (!(content instanceof ArrayBuffer)) {
			throw new Error(`not a binary file: ${path}`)
		}
		return content
	}

	async write(path: string, data: string) {
		this.writes.push(path)
		this.files.set(path, data)
	}

	async writeBinary(path: string, data: ArrayBuffer) {
		this.writes.push(path)
		this.files.set(path, data.slice(0))
	}

	async remove(path: string) {
		this.files.delete(path)
		this.dirs.delete(path)
	}

	async rename(from: string, to: string) {
		if (this.files.has(to)) {
			throw new Error('Destination file already exists!')
		}
		const content = this.files.get(from)
		if (content === undefined) throw new Error(`missing source: ${from}`)
		this.files.delete(from)
		this.files.set(to, content)
	}

	async stat(path: string) {
		const content = this.files.get(path)
		if (content === undefined) return null
		return {
			type: 'file',
			size: typeof content === 'string' ? content.length : content.byteLength,
		}
	}
}

function makeVault(adapter: MemoryAdapter) {
	return {
		configDir: '.obsidian',
		adapter,
		getAbstractFileByPath: () => null,
	} as unknown as Vault
}

const hiddenPath = '.agents/nutstore-sync/sessions/s1.json'

afterEach(() => {
	Platform.isMobileApp = false
})

describe('local vault io path traversal guard (A19)', () => {
	it('rejects explicit .. segments in the helper', () => {
		expect(() => assertNoLocalPathTraversal('.agents/../../x')).toThrow(
			'Path traversal is not allowed',
		)
		expect(() => assertNoLocalPathTraversal('notes/../outside.md')).toThrow(
			'Path traversal is not allowed',
		)
		expect(() => assertNoLocalPathTraversal('notes/a..b.md')).not.toThrow()
	})

	it.each([
		[
			'isAdapterPath',
			async (vault: Vault) => isAdapterPath(vault, '.agents/../../x'),
		],
		[
			'existsLocalPath',
			(vault: Vault) => existsLocalPath(vault, '.agents/../../x'),
		],
		[
			'readLocalText',
			(vault: Vault) => readLocalText(vault, '.agents/../../x'),
		],
		[
			'writeLocalText',
			(vault: Vault) => writeLocalText(vault, '.agents/../../x', 'x'),
		],
		[
			'writeLocalTextAtomic',
			(vault: Vault) => writeLocalTextAtomic(vault, '.agents/../../x', 'x'),
		],
		[
			'removeLocalPath',
			(vault: Vault) => removeLocalPath(vault, '.agents/../../x'),
		],
	])('%s rejects a traversal path', async (_name, call) => {
		await expect(call(makeVault(new MemoryAdapter()))).rejects.toThrow(
			'Path traversal is not allowed',
		)
	})
})

describe('local vault io mobile atomic write (A19)', () => {
	it('writes hidden paths through the atomic replace path on mobile', async () => {
		Platform.isMobileApp = true
		const adapter = new MemoryAdapter()
		const vault = makeVault(adapter)

		await writeLocalTextAtomic(vault, hiddenPath, '{"v":1}')

		expect(adapter.files.get(hiddenPath)).toBe('{"v":1}')
		expect([...adapter.files.keys()]).toEqual([hiddenPath])
		// The body was written to a temp sibling first, then renamed in place.
		expect(adapter.writes[0]).toContain('.nutstore-sync-temp-')
	})

	it('replaces an existing hidden file on mobile without leaving artifacts', async () => {
		Platform.isMobileApp = true
		const adapter = new MemoryAdapter()
		const vault = makeVault(adapter)
		await adapter.write(hiddenPath, '{"v":0}')

		await writeLocalTextAtomic(vault, hiddenPath, '{"v":2}')

		expect(adapter.files.get(hiddenPath)).toBe('{"v":2}')
		expect([...adapter.files.keys()]).toEqual([hiddenPath])
	})

	it('keeps the direct write path on desktop', async () => {
		Platform.isMobileApp = false
		const adapter = new MemoryAdapter()
		const vault = makeVault(adapter)

		await writeLocalTextAtomic(vault, hiddenPath, '{"v":3}')

		expect(adapter.files.get(hiddenPath)).toBe('{"v":3}')
		expect(adapter.writes).toEqual([hiddenPath])
	})
})
