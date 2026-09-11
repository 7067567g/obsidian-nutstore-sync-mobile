import { describe, expect, it, vi } from 'vitest'
import type { Vault } from 'obsidian'
import { SessionRecovery } from './session-recovery'

class MemoryAdapter {
	files = new Map<string, string>()
	dirs = new Set<string>()

	async exists(path: string) {
		return this.files.has(path) || this.dirs.has(path)
	}

	async write(path: string, data: string) {
		this.files.set(path, data)
	}

	async mkdir(path: string) {
		this.dirs.add(path)
	}

	async list(path: string) {
		const prefix = path.endsWith('/') ? path : `${path}/`
		return {
			files: [...this.files.keys()].filter((file) => file.startsWith(prefix)),
			folders: [...this.dirs].filter((dir) => dir.startsWith(prefix)),
		}
	}

	async remove(path: string) {
		this.files.delete(path)
	}
}

function makeVault(adapter: MemoryAdapter) {
	return { configDir: '.obsidian', adapter } as unknown as Vault
}

const sessionsDir = '.agents/nutstore-sync/sessions'
const marker = `${sessionsDir}/session-a/.write-in-progress.json`

describe('session write recovery', () => {
	it('writes and lists a pending marker', async () => {
		const adapter = new MemoryAdapter()
		const recovery = new SessionRecovery(makeVault(adapter), sessionsDir)
		await recovery.markStarted('session-a')

		expect(adapter.files.has(marker)).toBe(true)
		expect(await recovery.listPendingIds()).toEqual(['session-a'])
	})

	it('clears the marker only after the reader recovers the session', async () => {
		const adapter = new MemoryAdapter()
		const recovery = new SessionRecovery(makeVault(adapter), sessionsDir)
		await recovery.markStarted('session-a')
		const reader = vi.fn(async () => undefined)

		await recovery.recoverPending(reader)

		expect(reader).toHaveBeenCalledWith('session-a')
		expect(adapter.files.has(marker)).toBe(false)
	})

	it('keeps the marker when the session is still unreadable', async () => {
		const adapter = new MemoryAdapter()
		const recovery = new SessionRecovery(makeVault(adapter), sessionsDir)
		await recovery.markStarted('session-a')
		const reader = vi.fn(async () => {
			throw new Error('still corrupt')
		})

		await recovery.recoverPending(reader)

		expect(adapter.files.has(marker)).toBe(true)
	})
})
