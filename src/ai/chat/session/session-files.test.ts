import { describe, expect, it } from 'vitest'

import { SessionsFileBackend, ensureChatRootNomedia } from './session-files'
import { ATOMIC_BACKUP_MARKER } from '~/utils/atomic-replace'

class MemoryAdapter {
	readonly files = new Map<string, string>()
	readonly dirs = new Set<string>()
	readonly mtimes = new Map<string, number>()
	writeCount = 0
	mkdirCount = 0

	async exists(path: string) {
		return this.files.has(path) || this.dirs.has(path)
	}

	async read(path: string) {
		const value = this.files.get(path)
		if (value === undefined) throw new Error(`missing file: ${path}`)
		return value
	}

	async write(path: string, data: string) {
		this.writeCount += 1
		this.ensureParent(path)
		this.files.set(path, data)
		this.mtimes.set(path, (this.mtimes.get(path) ?? 0) + 1)
	}

	async append(path: string, data: string) {
		this.ensureParent(path)
		this.files.set(path, `${this.files.get(path) ?? ''}${data}`)
		this.mtimes.set(path, (this.mtimes.get(path) ?? 0) + 1)
	}

	async mkdir(path: string) {
		this.mkdirCount += 1
		this.dirs.add(path)
	}

	async list(path: string) {
		const prefix = path.endsWith('/') ? path : `${path}/`
		return {
			files: [...this.files.keys()].filter((file) => file.startsWith(prefix)),
			folders: [...this.dirs].filter((dir) => dir.startsWith(prefix)),
		}
	}

	async stat(path: string) {
		if (this.dirs.has(path)) return { type: 'folder' as const }
		if (this.files.has(path)) {
			return {
				type: 'file' as const,
				size: this.files.get(path)?.length ?? 0,
				mtime: this.mtimes.get(path),
			}
		}
		return null
	}

	async remove(path: string) {
		this.files.delete(path)
		this.mtimes.delete(path)
	}

	async rename(from: string, to: string) {
		const value = this.files.get(from)
		if (value === undefined) throw new Error(`missing source: ${from}`)
		const mtime = this.mtimes.get(from)
		this.files.delete(from)
		this.files.set(to, value)
		this.mtimes.delete(from)
		if (mtime !== undefined) this.mtimes.set(to, mtime)
	}

	async rmdir(path: string) {
		const prefix = path.endsWith('/') ? path : `${path}/`
		for (const file of [...this.files.keys()]) {
			if (file === path || file.startsWith(prefix)) {
				this.files.delete(file)
				this.mtimes.delete(file)
			}
		}
		for (const dir of [...this.dirs]) {
			if (dir === path || dir.startsWith(prefix)) this.dirs.delete(dir)
		}
	}

	private ensureParent(path: string) {
		const parts = path.split('/')
		parts.pop()
		let current = ''
		for (const part of parts) {
			current = current ? `${current}/${part}` : part
			this.dirs.add(current)
		}
	}
}

class StrictParentAdapter extends MemoryAdapter {
	override async write(path: string, data: string) {
		const parent = path.includes('/')
			? path.slice(0, path.lastIndexOf('/'))
			: ''
		if (parent && !this.dirs.has(parent)) {
			throw new Error(`missing parent directory: ${parent}`)
		}
		this.files.set(path, data)
	}
}

function makeVault(adapter: MemoryAdapter) {
	return { configDir: '.obsidian', adapter } as never
}

function makeSnapshot(operations: unknown[]) {
	return {
		schemaVersion: 2,
		id: 'session-1',
		createdAt: 1,
		updatedAt: 1,
		subagents: {
			master: {
				id: 'master',
				type: 'master',
				status: 'idle',
				createdAt: 1,
				timeline: [],
				pendingInputs: [],
				operations: { 'message-1': operations },
				toolTimings: {},
				subagents: {},
			},
		},
	} as never
}

function makeSource(operations: unknown[]) {
	return {
		subagents: {
			master: { operations: { 'message-1': operations }, subagents: {} },
		},
	} as never
}

function operationPayload(length: number) {
	return [
		{ vaultPath: 'note.md', operation: 'update', payload: 'x'.repeat(length) },
	]
}

describe('media scan marker', () => {
	it('creates parent directories on adapters that require them', async () => {
		const adapter = new StrictParentAdapter()
		const vault = makeVault(adapter)
		await ensureChatRootNomedia(vault)
		expect(adapter.files.get('.agents/nutstore-sync/.nomedia')).toBe('')
	})

	it('creates the hidden .nomedia once', async () => {
		const adapter = new MemoryAdapter()
		const vault = makeVault(adapter)
		await ensureChatRootNomedia(vault)
		expect(adapter.files.get('.agents/nutstore-sync/.nomedia')).toBe('')
		const writes = adapter.writeCount
		await ensureChatRootNomedia(vault)
		expect(adapter.writeCount).toBe(writes)
	})
})

describe('SessionsFileBackend operation sidecars', () => {
	it('round-trips oversized operations through sidecar files', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter), {
			maxInlineOperationBytes: 64,
			useLegacyBackend: true,
		})
		const operations = operationPayload(500)
		await backend.writeSessionFile(
			'session-1',
			{ session: makeSnapshot(operations), title: 'title' },
			makeSource(operations),
		)

		const sidecars = [...adapter.files.keys()].filter((file) =>
			file.includes('/ops/'),
		)
		expect(sidecars).toHaveLength(1)
		const mainFile = adapter.files.get(
			'.agents/nutstore-sync/sessions/session-1.json',
		)
		expect(mainFile).not.toContain('x'.repeat(500))
		expect(mainFile).toContain('operationRefs')
		expect(mainFile?.split('\n')).toHaveLength(2)

		const payload = await backend.readSessionFile('session-1')
		expect(
			(payload.session as { subagents: { master: { operations: unknown } } })
				.subagents.master.operations,
		).toEqual({ 'message-1': operations })
	})

	it('does not repeat mkdir calls for already ensured directories', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter), {
			maxInlineOperationBytes: 64,
			useLegacyBackend: true,
		})
		const operations = operationPayload(500)
		const source = makeSource(operations)
		await backend.writeSessionFile(
			'session-1',
			{ session: makeSnapshot(operations), title: 'title' },
			source,
		)
		const firstMkdirCount = adapter.mkdirCount

		await backend.writeSessionFile(
			'session-1',
			{
				session: makeSnapshot(JSON.parse(JSON.stringify(operations))),
				title: 'title',
			},
			source,
		)

		expect(adapter.mkdirCount).toBe(firstMkdirCount)
	})

	it('skips rewriting unchanged sidecars and prunes stale ones', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter), {
			maxInlineOperationBytes: 64,
			useLegacyBackend: true,
		})
		const large = operationPayload(500)
		const source = makeSource(large)
		await backend.writeSessionFile(
			'session-1',
			{ session: makeSnapshot(large), title: 'title' },
			source,
		)
		const writesAfterFirst = adapter.writeCount

		await backend.writeSessionFile(
			'session-1',
			{
				session: makeSnapshot(JSON.parse(JSON.stringify(large))),
				title: 'title',
			},
			source,
		)
		expect(adapter.writeCount).toBe(writesAfterFirst + 1)

		const small = operationPayload(1)
		await backend.writeSessionFile(
			'session-1',
			{ session: makeSnapshot(small), title: 'title' },
			makeSource(small),
		)
		expect(
			[...adapter.files.keys()].filter((file) => file.includes('/ops/')),
		).toHaveLength(0)
	})

	it('removes sidecars together with the session', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter), {
			maxInlineOperationBytes: 64,
			useLegacyBackend: true,
		})
		const operations = operationPayload(500)
		await backend.writeSessionFile(
			'session-1',
			{ session: makeSnapshot(operations), title: 'title' },
			makeSource(operations),
		)
		expect(
			[...adapter.files.keys()].filter((file) => file.includes('/ops/')),
		).toHaveLength(1)

		await backend.deleteSessionFile('session-1')

		expect(
			[...adapter.files.keys()].filter((file) => file.includes('/ops/')),
		).toHaveLength(0)
		expect(
			adapter.files.has('.agents/nutstore-sync/sessions/session-1.json'),
		).toBe(false)
	})

	it('re-verifies sidecar existence: external deletion rebuilds it (H8/K15+K16)', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter), {
			maxInlineOperationBytes: 64,
			useLegacyBackend: true,
		})
		const operations = operationPayload(500)
		await backend.writeSessionFile(
			'session-1',
			{ session: makeSnapshot(operations), title: 'title' },
			makeSource(operations),
		)
		const sidecar = [...adapter.files.keys()].find((file) =>
			file.includes('/ops/'),
		)
		expect(sidecar).toBeTruthy()

		// Simulate an external vault sync / cleanup deleting the sidecar while
		// the backend instance (and its in-memory hash table) stays alive.
		adapter.files.delete(sidecar as string)
		adapter.mtimes.delete(sidecar as string)
		const writesBefore = adapter.writeCount

		await backend.writeSessionFile(
			'session-1',
			{
				session: makeSnapshot(JSON.parse(JSON.stringify(operations))),
				title: 'title',
			},
			makeSource(operations),
		)

		expect(adapter.files.has(sidecar as string)).toBe(true)
		expect(adapter.writeCount).toBeGreaterThan(writesBefore)

		const payload = await backend.readSessionFile('session-1')
		expect(
			(payload.session as { subagents: { master: { operations: unknown } } })
				.subagents.master.operations,
		).toEqual({ 'message-1': operations })
	})

	it('re-verifies sidecar mtime and rewrites when it changed externally (H8/K16)', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter), {
			maxInlineOperationBytes: 64,
			useLegacyBackend: true,
		})
		const operations = operationPayload(500)
		await backend.writeSessionFile(
			'session-1',
			{ session: makeSnapshot(operations), title: 'title' },
			makeSource(operations),
		)
		const sidecar = [...adapter.files.keys()].find((file) =>
			file.includes('/ops/'),
		)
		expect(sidecar).toBeTruthy()

		// Same path (content-addressed) but a newer mtime means the bytes were
		// touched externally, so the skip must not be trusted.
		adapter.mtimes.set(sidecar as string, 999)
		const writesBefore = adapter.writeCount

		await backend.writeSessionFile(
			'session-1',
			{
				session: makeSnapshot(JSON.parse(JSON.stringify(operations))),
				title: 'title',
			},
			makeSource(operations),
		)

		expect(adapter.writeCount).toBeGreaterThan(writesBefore)
		expect(adapter.mtimes.get(sidecar as string)).not.toBe(999)
	})

	it('bounds the in-memory sidecar validator table (H8/K17)', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter), {
			maxInlineOperationBytes: 64,
			useLegacyBackend: true,
		})
		const internals = backend as unknown as {
			operationHashes: Map<string, unknown>
			maxTrackedSidecarHashes: number
		}
		internals.maxTrackedSidecarHashes = 1

		await backend.writeSessionFile(
			'session-a',
			{ session: makeSnapshot(operationPayload(500)), title: 'a' },
			makeSource(operationPayload(500)),
		)
		await backend.writeSessionFile(
			'session-b',
			{ session: makeSnapshot(operationPayload(600)), title: 'b' },
			makeSource(operationPayload(600)),
		)

		expect(internals.operationHashes.size).toBeLessThanOrEqual(1)
	})
})

describe('SessionsFileBackend session version (R2b / S3)', () => {
	async function countedStat(adapter: MemoryAdapter) {
		let calls = 0
		const originalStat = adapter.stat.bind(adapter)
		adapter.stat = async (path: string) => {
			calls += 1
			return originalStat(path)
		}
		return () => calls
	}

	it('uses one stat for a JSONL session instead of exists×3 + stat×3', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter), {
			trackSessionFileVersions: true,
		})
		await backend.writeSessionFile(
			'session-1',
			{ session: makeSnapshot([]), title: 'one' },
			undefined,
		)

		const statCalls = await countedStat(adapter)
		const version = await backend.getSessionFileVersion('session-1')

		expect(version).toMatch(/^log:/)
		expect(statCalls()).toBe(1)
	})

	it('falls back to the legacy whole-session file with two stats', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter), {
			trackSessionFileVersions: true,
			useLegacyBackend: true,
		})
		await backend.writeSessionFile(
			'session-1',
			{ session: makeSnapshot([]), title: 'legacy' },
			undefined,
		)

		const statCalls = await countedStat(adapter)
		const version = await backend.getSessionFileVersion('session-1')

		expect(version).toMatch(/^file:/)
		expect(statCalls()).toBe(2)
	})
})

describe('SessionsFileBackend startup recovery (R2b / S4)', () => {
	it('recovers a chat-root orphan backup once at startup', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const metaPath = '.agents/nutstore-sync/chat-meta.json'
		const backupPath = `${metaPath}${ATOMIC_BACKUP_MARKER}111-abc`
		adapter.files.set(backupPath, '{"orderedSessionIds":[],"sessions":{}}')

		await backend.recoverPendingTemps()

		expect(adapter.files.has(metaPath)).toBe(true)
		expect(adapter.files.has(backupPath)).toBe(false)
	})
})
