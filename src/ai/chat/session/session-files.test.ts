import { describe, expect, it } from 'vitest'

import { SessionsFileBackend } from '~/ai/chat/session/session-files'

class MemoryAdapter {
	readonly files = new Map<string, string>()
	readonly dirs = new Set<string>()
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
		if (this.files.has(path)) return { type: 'file' as const }
		return null
	}

	async remove(path: string) {
		this.files.delete(path)
	}

	async rmdir(path: string) {
		const prefix = path.endsWith('/') ? path : `${path}/`
		for (const file of [...this.files.keys()]) {
			if (file === path || file.startsWith(prefix)) this.files.delete(file)
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
})
