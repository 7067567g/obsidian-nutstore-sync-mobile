import { describe, expect, it } from 'vitest'
import type { Vault } from 'obsidian'
import { SessionsFileBackend } from './session-files'

class MemoryAdapter {
	files = new Map<string, string>()
	dirs = new Set<string>()
	appendBytes = 0
	appendCalls = 0
	writeCalls = 0
	writeCountsByPath = new Map<string, number>()

	async exists(path: string) {
		return this.files.has(path) || this.dirs.has(path)
	}

	async read(path: string) {
		const value = this.files.get(path)
		if (value === undefined) throw new Error(`missing file: ${path}`)
		return value
	}

	async write(path: string, data: string) {
		this.writeCalls += 1
		this.writeCountsByPath.set(
			path,
			(this.writeCountsByPath.get(path) ?? 0) + 1,
		)
		this.ensureParent(path)
		this.files.set(path, data)
	}

	async append(path: string, data: string) {
		this.appendCalls += 1
		this.appendBytes += data.length
		if (!this.files.has(path)) throw new Error(`missing append file: ${path}`)
		this.files.set(path, (this.files.get(path) ?? '') + data)
	}

	async mkdir(path: string) {
		this.ensureParent(path)
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
		if (this.dirs.has(path)) return { type: 'folder' as const, size: 0 }
		const file = this.files.get(path)
		return file === undefined
			? null
			: { type: 'file' as const, size: file.length }
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

	async rename(from: string, to: string) {
		const content = this.files.get(from)
		if (content === undefined) throw new Error(`missing source: ${from}`)
		this.files.delete(from)
		this.files.set(to, content)
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
	return { configDir: '.obsidian', adapter } as unknown as Vault
}

function makeSession(count: number) {
	return {
		schemaVersion: 2,
		id: 'session-log-1',
		createdAt: 1,
		updatedAt: 1,
		subagents: {
			master: {
				id: 'master',
				type: 'master',
				status: 'idle',
				createdAt: 1,
				updatedAt: 1,
				timeline: Array.from({ length: count }, (_, index) => ({
					id: `message-${index + 1}`,
					role: index % 2 === 0 ? 'user' : 'assistant',
					parts: [{ type: 'text', text: `message ${index + 1}` }],
				})),
				operations: {},
				toolTimings: {},
				subagents: {},
			},
		},
	} as never
}

function encoded(session: unknown) {
	return JSON.parse(JSON.stringify(session)) as never
}

describe('JSONL session log backend', () => {
	it('appends only changed messages instead of rewriting the 500-message session', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const first = makeSession(500)
		await backend.writeSessionFile(
			'session-log-1',
			{ session: first, title: '500 messages' },
			first,
		)

		expect(
			adapter.files.has('.agents/nutstore-sync/sessions/session-log-1.json'),
		).toBe(false)
		const firstLog = adapter.files.get(
			'.agents/nutstore-sync/sessions/session-log-1/log.jsonl',
		)
		expect(firstLog?.split('\n').filter(Boolean)).toHaveLength(1)

		const second = makeSession(500) as {
			subagents: { master: { timeline: Array<unknown> } }
		}
		second.subagents.master.timeline = second.subagents.master.timeline.map(
			(message, index) =>
				index === 250
					? {
							id: 'message-251',
							role: 'assistant',
							parts: [{ type: 'text', text: 'changed message' }],
						}
					: message,
		)
		const appendBytesBefore = adapter.appendBytes
		await backend.writeSessionFile(
			'session-log-1',
			{ session: encoded(second), title: '500 messages' },
			second as never,
		)
		const appendedBytes = adapter.appendBytes - appendBytesBefore
		expect(appendedBytes).toBeGreaterThan(0)
		expect(appendedBytes).toBeLessThan(2_000)

		const payload = await backend.readSessionFile('session-log-1')
		const timeline = (
			payload.session as unknown as {
				subagents: { master: { timeline: unknown[] } }
			}
		).subagents.master.timeline
		expect(timeline).toHaveLength(500)
		expect(JSON.stringify(timeline[250])).toContain('changed message')
		expect(payload.title).toBe('500 messages')
	})

	it('does not write again when a cold backend reads an unchanged session', async () => {
		const adapter = new MemoryAdapter()
		const firstBackend = new SessionsFileBackend(makeVault(adapter))
		const session = makeSession(20)
		await firstBackend.writeSessionFile(
			'session-log-1',
			{ session, title: 'same' },
			session,
		)
		const appendCalls = adapter.appendCalls
		const writeCalls = adapter.writeCalls

		const coldBackend = new SessionsFileBackend(makeVault(adapter))
		await coldBackend.writeSessionFile(
			'session-log-1',
			{ session: encoded(session), title: 'same' },
			undefined,
		)

		expect(adapter.appendCalls).toBe(appendCalls)
		expect(adapter.writeCalls).toBe(writeCalls)
	})

	it('keeps legacy flat files readable and migrates only on write', async () => {
		const adapter = new MemoryAdapter()
		const legacyPayload = JSON.stringify({
			session: makeSession(2),
			title: 'legacy',
		})
		adapter.files.set(
			'.agents/nutstore-sync/sessions/session-legacy.json',
			`${legacyPayload}\n`,
		)
		const backend = new SessionsFileBackend(makeVault(adapter))

		const legacy = await backend.readSessionFile('session-legacy')
		expect(legacy.title).toBe('legacy')

		await backend.writeSessionFile(
			'session-legacy',
			{ session: makeSession(2), title: 'legacy' },
			makeSession(2),
		)
		expect(
			adapter.files.has('.agents/nutstore-sync/sessions/session-legacy.json'),
		).toBe(true)
		expect(
			adapter.files.has(
				'.agents/nutstore-sync/sessions/session-legacy/log.jsonl',
			),
		).toBe(true)
	})

	it('compacts a large append log into a segment and still reads it back', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter), {
			sessionLogCompactionBytes: 200,
		})
		const session = makeSession(30)
		await backend.writeSessionFile(
			'session-log-1',
			{ session, title: 'compact' },
			session,
		)
		for (let index = 0; index < 30; index += 1) {
			const next = encoded(session) as {
				subagents: { master: { timeline: Array<unknown> } }
			}
			next.subagents.master.timeline[index] = {
				id: `message-${index + 1}`,
				role: 'user',
				parts: [{ type: 'text', text: `revision ${index}` }],
			}
			await backend.writeSessionFile(
				'session-log-1',
				{ session: next as never, title: 'compact' },
				next as never,
			)
		}
		const segments = [...adapter.files.keys()].filter((file) =>
			file.includes('/seg/'),
		)
		expect(segments.length).toBeGreaterThan(0)
		const payload = await backend.readSessionFile('session-log-1')
		expect(
			(
				payload.session as unknown as {
					subagents: { master: { timeline: unknown[] } }
				}
			).subagents.master.timeline,
		).toHaveLength(30)
	})

	it('combines the compacted segment with later append records on a cold read', async () => {
		const adapter = new MemoryAdapter()
		const open = () =>
			new SessionsFileBackend(makeVault(adapter), {
				sessionLogCompactionBytes: 200,
			})
		const backend = open()
		const session = makeSession(30)
		await backend.writeSessionFile(
			'session-log-1',
			{ session, title: 'cold compact' },
			session,
		)
		expect(
			[...adapter.files.keys()].some((file) => file.includes('/seg/')),
		).toBe(true)

		const changed = encoded(session) as {
			subagents: { master: { timeline: Array<unknown> } }
		}
		changed.subagents.master.timeline[0] = {
			id: 'message-1',
			role: 'user',
			parts: [{ type: 'text', text: 'changed after compaction' }],
		}
		await backend.writeSessionFile(
			'session-log-1',
			{ session: changed as never, title: 'cold compact' },
			changed as never,
		)
		const logPath =
			'.agents/nutstore-sync/sessions/session-log-1/log.jsonl'
		expect(adapter.files.get(logPath)?.trim().length).toBeGreaterThan(0)

		const coldBackend = open()
		const payload = await coldBackend.readSessionFile('session-log-1')
		const timeline = (
			payload.session as unknown as {
				subagents: { master: { timeline: unknown[] } }
			}
		).subagents.master.timeline
		expect(timeline).toHaveLength(30)
		expect(JSON.stringify(timeline[0])).toContain('changed after compaction')
	})

	it('ignores a stale higher-generation segment when index has the base generation', async () => {
		const adapter = new MemoryAdapter()
		const id = 'session-log-1'
		const dir = `.agents/nutstore-sync/sessions/${id}`
		const base = makeSession(48)
		const stale = makeSession(74)
		adapter.files.set(
			`${dir}/index.json`,
			JSON.stringify({
				formatVersion: 1,
				id,
				generation: 58,
				updatedAt: 100,
				agents: [{ pathKey: 'master', id: 'master', messageCount: 48 }],
			}),
		)
		adapter.files.set(`${dir}/seg/0046-0048.json`, JSON.stringify(base))
		adapter.files.set(`${dir}/seg/0078-0074.json`, JSON.stringify(stale))
		const delta = {
			id: 'message-49',
			role: 'user',
			parts: [{ type: 'text', text: 'recovered delta' }],
		}
		adapter.files.set(
			`${dir}/log.jsonl`,
			`${JSON.stringify({
				type: 'message',
				agentPath: ['master'],
				messageId: 'message-49',
				index: 48,
				message: delta,
			})}\n`,
		)

		const backend = new SessionsFileBackend(makeVault(adapter))
		const payload = await backend.readSessionFile(id)
		const timeline = (
			payload.session as unknown as {
				subagents: { master: { timeline: unknown[] } }
			}
		).subagents.master.timeline
		expect(timeline).toHaveLength(49)
		expect(JSON.stringify(timeline[48])).toContain('recovered delta')
	})
})

it('round-trips oversized reversible operations through sidecars + JSONL meta', async () => {
	const adapter = new MemoryAdapter()
	const backend = new SessionsFileBackend(makeVault(adapter), {
		maxInlineOperationBytes: 64,
	})
	const operations = [
		{
			vaultPath: 'note.md',
			operation: 'update',
			payload: 'x'.repeat(500),
		},
	]
	const session = makeSession(1) as {
		subagents: { master: { operations: Record<string, unknown> } }
	}
	session.subagents.master.operations = { 'message-1': operations }
	const source = makeSession(1) as {
		subagents: { master: { operations: Record<string, unknown> } }
	}
	source.subagents.master.operations = { 'message-1': operations }

	await backend.writeSessionFile(
		'session-log-1',
		{ session: session as never, title: 'ops' },
		source as never,
	)

	expect(
		[...adapter.files.keys()].filter((file) => file.includes('/ops/')),
	).toHaveLength(1)
	const payload = await backend.readSessionFile('session-log-1')
	expect(
		(
			payload.session as unknown as {
				subagents: { master: { operations: unknown } }
			}
		).subagents.master.operations,
	).toEqual({ 'message-1': operations })
})

it('skips unchanged sidecar rewrites after a cold read seeds filename hashes', async () => {
	const adapter = new MemoryAdapter()
	const firstBackend = new SessionsFileBackend(makeVault(adapter), {
		maxInlineOperationBytes: 64,
	})
	const operations = [
		{
			vaultPath: 'note.md',
			operation: 'update',
			payload: 'x'.repeat(500),
		},
	]
	const session = makeSession(1) as {
		subagents: { master: { operations: Record<string, unknown> } }
	}
	session.subagents.master.operations = { 'message-1': operations }
	const source = makeSession(1) as {
		subagents: { master: { operations: Record<string, unknown> } }
	}
	source.subagents.master.operations = { 'message-1': operations }
	await firstBackend.writeSessionFile(
		'session-log-1',
		{ session: session as never, title: 'ops' },
		source as never,
	)
	const sidecarPath = [...adapter.files.keys()].find((file) =>
		file.includes('/ops/'),
	)
	expect(sidecarPath).toBeTruthy()
	const sidecarWrites = adapter.writeCountsByPath.get(sidecarPath!) ?? 0

	const coldBackend = new SessionsFileBackend(makeVault(adapter), {
		maxInlineOperationBytes: 64,
	})
	const payload = await coldBackend.readSessionFile('session-log-1')
	const changed = JSON.parse(JSON.stringify(payload.session)) as {
		subagents: {
			master: {
				timeline: Array<{ parts: Array<{ text: string }> }>
			}
		}
	}
	changed.subagents.master.timeline[0].parts[0].text = 'changed text'
	await coldBackend.writeSessionFile(
		'session-log-1',
		{ session: changed as never, title: 'ops' },
		payload.session as never,
	)

	expect(adapter.writeCountsByPath.get(sidecarPath!)).toBe(sidecarWrites)
})
