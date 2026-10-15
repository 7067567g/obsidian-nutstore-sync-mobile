import { describe, expect, it } from 'vitest'
import type { Vault } from 'obsidian'
import {
	ATOMIC_BACKUP_MARKER,
	ATOMIC_TEMP_MARKER,
} from '~/utils/atomic-replace'
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

function timelineOf(payload: unknown) {
	return (
		payload as {
			session: { subagents: { master: { timeline: unknown[] } } }
		}
	).session.subagents.master.timeline
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
		const logPath = '.agents/nutstore-sync/sessions/session-log-1/log.jsonl'
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
	it('repairs a torn final line before the next append and keeps the recovered record', async () => {
		const adapter = new MemoryAdapter()
		const firstBackend = new SessionsFileBackend(makeVault(adapter))
		const first = makeSession(3)
		await firstBackend.writeSessionFile(
			'session-log-1',
			{ session: first, title: 'torn' },
			first,
		)
		const logPath = '.agents/nutstore-sync/sessions/session-log-1/log.jsonl'
		const originalLog = adapter.files.get(logPath) ?? ''
		expect(originalLog.endsWith('\n')).toBe(true)
		// Simulate a crash after the final record was written but before its newline.
		adapter.files.set(logPath, originalLog.slice(0, -1))

		const coldBackend = new SessionsFileBackend(makeVault(adapter))
		const coldPayload = await coldBackend.readSessionFile('session-log-1')
		const coldTimeline = (
			coldPayload.session as unknown as {
				subagents: { master: { timeline: unknown[] } }
			}
		).subagents.master.timeline
		expect(coldTimeline).toHaveLength(3)

		const appendCalls = adapter.appendCalls
		const second = makeSession(4)
		await coldBackend.writeSessionFile(
			'session-log-1',
			{ session: second, title: 'torn' },
			second,
		)
		const repairedLog = adapter.files.get(logPath) ?? ''
		expect(repairedLog.endsWith('\n')).toBe(true)
		expect(adapter.appendCalls).toBe(appendCalls)

		const nextCold = new SessionsFileBackend(makeVault(adapter))
		const payload = await nextCold.readSessionFile('session-log-1')
		const timeline = (
			payload.session as unknown as {
				subagents: { master: { timeline: unknown[] } }
			}
		).subagents.master.timeline
		expect(timeline).toHaveLength(4)
	})

	it('rejects a corrupt committed line instead of silently dropping it', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const session = makeSession(2)
		await backend.writeSessionFile(
			'session-log-1',
			{ session, title: 'corrupt' },
			session,
		)
		const logPath = '.agents/nutstore-sync/sessions/session-log-1/log.jsonl'
		adapter.files.set(
			logPath,
			`${adapter.files.get(logPath) ?? ''}{broken json}\n`,
		)

		const coldBackend = new SessionsFileBackend(makeVault(adapter))
		await expect(coldBackend.readSessionFile('session-log-1')).rejects.toThrow(
			'not valid JSON',
		)
	})

	it('promotes a complete temp segment and leaves an incomplete one for diagnostics', async () => {
		const adapter = new MemoryAdapter()
		const sessionsDir = '.agents/nutstore-sync/sessions/session-log-1'
		const segDir = `${sessionsDir}/seg`
		adapter.files.set(`${sessionsDir}/log.jsonl`, '')
		adapter.files.set(
			`${segDir}/0001-0002.json${ATOMIC_TEMP_MARKER}complete`,
			JSON.stringify(makeSession(2)),
		)
		adapter.files.set(
			`${segDir}/0001-0003.json${ATOMIC_TEMP_MARKER}incomplete`,
			'{"type":"snapshot"',
		)

		const backend = new SessionsFileBackend(makeVault(adapter))
		const payload = await backend.readSessionFile('session-log-1')
		const timeline = (
			payload.session as unknown as {
				subagents: { master: { timeline: unknown[] } }
			}
		).subagents.master.timeline
		expect(timeline).toHaveLength(2)
		expect(adapter.files.has(`${segDir}/0001-0002.json`)).toBe(true)
		expect(adapter.files.has(`${segDir}/0001-0003.json`)).toBe(false)
		expect(
			[...adapter.files.keys()].some((path) => path.includes('incomplete')),
		).toBe(true)
	})

	it('removes a stale complete temp when its target already exists', async () => {
		const adapter = new MemoryAdapter()
		const sessionsDir = '.agents/nutstore-sync/sessions/session-log-1'
		const segDir = `${sessionsDir}/seg`
		adapter.files.set(`${sessionsDir}/log.jsonl`, '')
		adapter.files.set(
			`${segDir}/0001-0002.json`,
			JSON.stringify(makeSession(2)),
		)
		adapter.files.set(
			`${segDir}/0001-0002.json${ATOMIC_TEMP_MARKER}stale`,
			JSON.stringify(makeSession(2)),
		)

		const backend = new SessionsFileBackend(makeVault(adapter))
		await backend.readSessionFile('session-log-1')
		expect(adapter.files.has(`${segDir}/0001-0002.json`)).toBe(true)
		expect(
			[...adapter.files.keys()].some(
				(path) => path === `${segDir}/0001-0002.json${ATOMIC_TEMP_MARKER}stale`,
			),
		).toBe(false)
	})

	it('removes a zero-byte stale temp when its target already exists', async () => {
		const adapter = new MemoryAdapter()
		const sessionsDir = '.agents/nutstore-sync/sessions/session-log-1'
		const segDir = `${sessionsDir}/seg`
		adapter.files.set(`${sessionsDir}/log.jsonl`, '')
		adapter.files.set(
			`${segDir}/0001-0002.json`,
			JSON.stringify(makeSession(2)),
		)
		adapter.files.set(`${segDir}/0001-0002.json${ATOMIC_TEMP_MARKER}zero`, '')

		const backend = new SessionsFileBackend(makeVault(adapter))
		await backend.readSessionFile('session-log-1')
		expect(adapter.files.has(`${segDir}/0001-0002.json`)).toBe(true)
		expect(
			adapter.files.has(`${segDir}/0001-0002.json${ATOMIC_TEMP_MARKER}zero`),
		).toBe(false)
	})

	it('removes a stale atomic backup when its target already exists', async () => {
		const adapter = new MemoryAdapter()
		const sessionsDir = '.agents/nutstore-sync/sessions/session-log-1'
		const segDir = `${sessionsDir}/seg`
		adapter.files.set(`${sessionsDir}/log.jsonl`, '')
		adapter.files.set(
			`${segDir}/0001-0002.json`,
			JSON.stringify(makeSession(2)),
		)
		adapter.files.set(
			`${segDir}/0001-0002.json${ATOMIC_BACKUP_MARKER}stale`,
			JSON.stringify(makeSession(2)),
		)

		const backend = new SessionsFileBackend(makeVault(adapter))
		await backend.readSessionFile('session-log-1')
		expect(adapter.files.has(`${segDir}/0001-0002.json`)).toBe(true)
		expect(
			adapter.files.has(`${segDir}/0001-0002.json${ATOMIC_BACKUP_MARKER}stale`),
		).toBe(false)
	})

	it('restores an atomic backup when its target is missing', async () => {
		const adapter = new MemoryAdapter()
		const sessionsDir = '.agents/nutstore-sync/sessions/session-log-1'
		const segDir = `${sessionsDir}/seg`
		adapter.files.set(`${sessionsDir}/log.jsonl`, '')
		adapter.files.set(
			`${segDir}/0001-0002.json${ATOMIC_BACKUP_MARKER}restore`,
			JSON.stringify(makeSession(2)),
		)

		const backend = new SessionsFileBackend(makeVault(adapter))
		const payload = await backend.readSessionFile('session-log-1')
		const timeline = (
			payload.session as unknown as {
				subagents: { master: { timeline: unknown[] } }
			}
		).subagents.master.timeline
		expect(timeline).toHaveLength(2)
		expect(adapter.files.has(`${segDir}/0001-0002.json`)).toBe(true)
		expect(
			adapter.files.has(
				`${segDir}/0001-0002.json${ATOMIC_BACKUP_MARKER}restore`,
			),
		).toBe(false)
	})

	it('publishes the active segment before clearing the old log', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter), {
			sessionLogCompactionBytes: 1,
		})
		const session = makeSession(5)
		const logPath = '.agents/nutstore-sync/sessions/session-log-1/log.jsonl'
		adapter.files.set(logPath, '')
		const originalWrite = adapter.write.bind(adapter)
		adapter.write = async (path: string, data: string) => {
			if (path === logPath && data === '') {
				throw new Error('simulated crash while clearing log')
			}
			return originalWrite(path, data)
		}

		await expect(
			backend.writeSessionFile(
				'session-log-1',
				{ session, title: 'order' },
				session,
			),
		).rejects.toThrow('simulated crash while clearing log')

		const index = JSON.parse(
			adapter.files.get(
				'.agents/nutstore-sync/sessions/session-log-1/index.json',
			) ?? '{}',
		) as { activeSegment?: string }
		expect(index.activeSegment).toBeTruthy()

		const coldBackend = new SessionsFileBackend(makeVault(adapter))
		const payload = await coldBackend.readSessionFile('session-log-1')
		const timeline = (
			payload.session as unknown as {
				subagents: { master: { timeline: unknown[] } }
			}
		).subagents.master.timeline
		expect(timeline).toHaveLength(5)
	})
	it('recovers a 128-message history spread across multiple generation segments', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter), {
			sessionLogCompactionBytes: 1,
		})
		for (const count of [40, 80, 120, 128]) {
			const session = makeSession(count)
			await backend.writeSessionFile(
				'session-log-1',
				{ session, title: 'many' },
				session,
			)
		}
		const segmentFiles = [...adapter.files.keys()].filter(
			(path) => path.includes('/seg/') && path.endsWith('.json'),
		)
		expect(segmentFiles.length).toBeGreaterThanOrEqual(4)

		const coldBackend = new SessionsFileBackend(makeVault(adapter))
		const payload = await coldBackend.readSessionFile('session-log-1')
		const timeline = (
			payload.session as unknown as {
				subagents: { master: { timeline: unknown[] } }
			}
		).subagents.master.timeline
		expect(timeline).toHaveLength(128)
	})
	it('keeps the message after an append failure and a retry', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const first = makeSession(2)
		await backend.writeSessionFile(
			'session-log-1',
			{ session: first, title: 'append-retry' },
			first,
		)
		const originalAppend = adapter.append.bind(adapter)
		let failed = false
		adapter.append = async (path: string, data: string) => {
			if (!failed) {
				failed = true
				throw new Error('append failed')
			}
			return originalAppend(path, data)
		}

		const second = makeSession(3)
		await expect(
			backend.writeSessionFile(
				'session-log-1',
				{ session: second, title: 'append-retry' },
				second,
			),
		).rejects.toThrow('append failed')
		await backend.writeSessionFile(
			'session-log-1',
			{ session: second, title: 'append-retry' },
			second,
		)

		const coldBackend = new SessionsFileBackend(makeVault(adapter))
		expect(
			timelineOf(await coldBackend.readSessionFile('session-log-1')),
		).toHaveLength(3)
	})

	it('keeps the message after a meta cache failure and a retry', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const first = makeSession(2)
		await backend.writeSessionFile(
			'session-log-1',
			{ session: first, title: 'meta-retry' },
			first,
		)
		const metaPath = '.agents/nutstore-sync/sessions/session-log-1/meta.json'
		const originalRename = adapter.rename.bind(adapter)
		let failed = false
		adapter.rename = async (from: string, to: string) => {
			if (!failed && to === metaPath) {
				failed = true
				throw new Error('meta cache failed')
			}
			return originalRename(from, to)
		}

		const second = makeSession(3)
		await expect(
			backend.writeSessionFile(
				'session-log-1',
				{ session: second, title: 'meta-retry' },
				second,
			),
		).rejects.toThrow('meta cache failed')
		await backend.writeSessionFile(
			'session-log-1',
			{ session: second, title: 'meta-retry' },
			second,
		)

		const coldBackend = new SessionsFileBackend(makeVault(adapter))
		expect(
			timelineOf(await coldBackend.readSessionFile('session-log-1')),
		).toHaveLength(3)
	})

	it('keeps the message after an index cache failure and a retry', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const first = makeSession(2)
		await backend.writeSessionFile(
			'session-log-1',
			{ session: first, title: 'index-retry' },
			first,
		)
		const indexPath = '.agents/nutstore-sync/sessions/session-log-1/index.json'
		const originalRename = adapter.rename.bind(adapter)
		let failed = false
		adapter.rename = async (from: string, to: string) => {
			if (!failed && to === indexPath) {
				failed = true
				throw new Error('index cache failed')
			}
			return originalRename(from, to)
		}

		const second = makeSession(3)
		await expect(
			backend.writeSessionFile(
				'session-log-1',
				{ session: second, title: 'index-retry' },
				second,
			),
		).rejects.toThrow('index cache failed')
		await backend.writeSessionFile(
			'session-log-1',
			{ session: second, title: 'index-retry' },
			second,
		)

		const coldBackend = new SessionsFileBackend(makeVault(adapter))
		expect(
			timelineOf(await coldBackend.readSessionFile('session-log-1')),
		).toHaveLength(3)
	})

	it('restores top-level meta and operation refs from the log when meta.json is deleted', async () => {
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
			createdAt: number
			updatedAt: number
			subagents: { master: { operations: Record<string, unknown> } }
		}
		session.createdAt = 111
		session.updatedAt = 222
		session.subagents.master.operations = { 'message-1': operations }
		const source = makeSession(1) as {
			subagents: { master: { operations: Record<string, unknown> } }
		}
		source.subagents.master.operations = { 'message-1': operations }

		await backend.writeSessionFile(
			'session-log-1',
			{ session: session as never, title: 'top-level title' },
			source as never,
		)
		adapter.files.delete(
			'.agents/nutstore-sync/sessions/session-log-1/meta.json',
		)

		const coldBackend = new SessionsFileBackend(makeVault(adapter), {
			maxInlineOperationBytes: 64,
		})
		const payload = await coldBackend.readSessionFile('session-log-1')
		expect(payload.title).toBe('top-level title')
		const restored = payload.session as unknown as {
			createdAt: number
			updatedAt: number
			subagents: { master: { operations: Record<string, unknown> } }
		}
		expect(restored.createdAt).toBe(111)
		expect(restored.updatedAt).toBe(222)
		expect(restored.subagents.master.operations).toEqual({
			'message-1': operations,
		})
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
