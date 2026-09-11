import { describe, expect, it } from 'vitest'
import type { Vault } from 'obsidian'
import { atomicReplaceContent, atomicReplaceFromTemp } from './atomic-replace'

class MemoryAdapter {
	files = new Map<string, string | ArrayBuffer>()
	dirs = new Set<string>()
	shouldFailTempRename: ((from: string, to: string) => boolean) | undefined

	async exists(path: string) {
		return this.files.has(path) || this.dirs.has(path)
	}

	async mkdir(path: string) {
		this.dirs.add(path)
	}

	async write(path: string, data: string) {
		this.files.set(path, data)
	}

	async writeBinary(path: string, data: ArrayBuffer) {
		this.files.set(path, data.slice(0))
	}

	async remove(path: string) {
		this.files.delete(path)
		this.dirs.delete(path)
	}

	async rename(from: string, to: string) {
		if (this.shouldFailTempRename?.(from, to)) {
			throw new Error('synthetic rename failure')
		}
		const content = this.files.get(from)
		if (content === undefined) throw new Error(`missing source: ${from}`)
		this.files.delete(from)
		this.files.set(to, content)
	}
}

function makeVault(adapter: MemoryAdapter) {
	return {
		configDir: '.obsidian',
		adapter,
	} as unknown as Vault
}

const target = '.agents/nutstore-sync/notes/replace.txt'

describe('atomic replace', () => {
	it('replaces content without leaving temp or backup files', async () => {
		const adapter = new MemoryAdapter()
		const vault = makeVault(adapter)
		await adapter.write(target, 'old')
		await atomicReplaceContent(vault, target, 'new', 'text')
		expect(adapter.files.get(target)).toBe('new')
		expect([...adapter.files.keys()]).toEqual([target])
	})

	it('restores the original target when the final rename fails', async () => {
		const adapter = new MemoryAdapter()
		const vault = makeVault(adapter)
		await adapter.write(target, 'old')
		adapter.shouldFailTempRename = (from, to) =>
			from.includes('.nutstore-sync-temp-') && to === target

		await expect(
			atomicReplaceContent(vault, target, 'new', 'text'),
		).rejects.toThrow('synthetic rename failure')
		expect(adapter.files.get(target)).toBe('old')
		expect([...adapter.files.keys()]).toEqual([target])
	})

	it('replaces from an existing temp file', async () => {
		const adapter = new MemoryAdapter()
		const vault = makeVault(adapter)
		const temp = '.agents/nutstore-sync/notes/temp.bin'
		await adapter.writeBinary(temp, new Uint8Array([1, 2, 3]).buffer)
		await atomicReplaceFromTemp(vault, temp, target)
		const content = adapter.files.get(target) as ArrayBuffer
		expect(new Uint8Array(content)).toEqual(new Uint8Array([1, 2, 3]))
	})
})
