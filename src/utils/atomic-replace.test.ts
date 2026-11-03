import { describe, expect, it } from 'vitest'
import type { Vault } from 'obsidian'
import {
	ATOMIC_BACKUP_MARKER,
	atomicReplaceContent,
	atomicReplaceFromTemp,
	recoverOrphanedBackups,
} from './atomic-replace'

class MemoryAdapter {
	files = new Map<string, string | ArrayBuffer>()
	dirs = new Set<string>()
	shouldFailTempRename: ((from: string, to: string) => boolean) | undefined
	listCalls = 0

	async exists(path: string) {
		return this.files.has(path) || this.dirs.has(path)
	}

	async mkdir(path: string) {
		this.dirs.add(path)
	}

	async list(path: string) {
		this.listCalls += 1
		const prefix = path ? `${path}/` : ''
		const files: string[] = []
		const folders = new Set<string>()
		for (const file of this.files.keys()) {
			if (!file.startsWith(prefix)) continue
			const rest = file.slice(prefix.length)
			if (rest.includes('/')) {
				folders.add(`${prefix}${rest.split('/')[0]}`)
			} else {
				files.push(file)
			}
		}
		return { files, folders: [...folders] }
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

describe('atomic replace orphan backup recovery (A17)', () => {
	const directory = '.agents/nutstore-sync/notes'
	const backup = `${target}${ATOMIC_BACKUP_MARKER}111-abc`

	it('restores a backup whose target is missing', async () => {
		const adapter = new MemoryAdapter()
		const vault = makeVault(adapter)
		await adapter.write(backup, 'old')

		const recovered = await recoverOrphanedBackups(vault, directory)

		expect(recovered).toBe(1)
		expect(adapter.files.get(target)).toBe('old')
		expect(adapter.files.has(backup)).toBe(false)
	})

	it('drops a stale backup when the target still exists', async () => {
		const adapter = new MemoryAdapter()
		const vault = makeVault(adapter)
		await adapter.write(target, 'current')
		await adapter.write(backup, 'stale')

		const recovered = await recoverOrphanedBackups(vault, directory)

		expect(recovered).toBe(0)
		expect(adapter.files.get(target)).toBe('current')
		expect(adapter.files.has(backup)).toBe(false)
	})

	it('does not scan the directory on a normal atomic replace (R2b / S4)', async () => {
		const adapter = new MemoryAdapter()
		const vault = makeVault(adapter)
		await adapter.write(target, 'old')

		await atomicReplaceContent(vault, target, 'new', 'text')

		expect(adapter.files.get(target)).toBe('new')
		// The hot path no longer pays an `adapter.list` for orphan recovery;
		// start-up (`recoverOrphanedBackups`) and the marker path below cover it.
		expect(adapter.listCalls).toBe(0)
	})

	it('a failed restore marks the target so the next replace heals it', async () => {
		const adapter = new MemoryAdapter()
		const vault = makeVault(adapter)
		await adapter.write(target, 'old')
		// Fail both the final install rename and the restore rename, leaving the
		// target missing plus a lone backup (the worst crash window).
		adapter.shouldFailTempRename = (_from, to) => to === target

		await expect(
			atomicReplaceContent(vault, target, 'new', 'text'),
		).rejects.toThrow('synthetic rename failure')
		expect(adapter.files.has(target)).toBe(false)
		expect(
			[...adapter.files.keys()].some((path) =>
				path.startsWith(`${target}${ATOMIC_BACKUP_MARKER}`),
			),
		).toBe(true)

		// The marker makes the next write for this target run the targeted scan:
		// the backup is restored first, then replaced by the new content.
		adapter.shouldFailTempRename = undefined
		adapter.listCalls = 0
		await atomicReplaceContent(vault, target, 'new', 'text')

		expect(adapter.files.get(target)).toBe('new')
		expect([...adapter.files.keys()]).toEqual([target])
		expect(adapter.listCalls).toBe(1)
	})
})
