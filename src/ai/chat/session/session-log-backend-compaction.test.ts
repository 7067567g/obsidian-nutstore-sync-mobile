import { describe, expect, it } from 'vitest'
import { SessionLogBackend } from './session-log-backend'
import { SessionsFileBackend } from './session-files'
import {
	MemoryAdapter,
	encoded,
	makeSession,
	makeVault,
} from './session-log-backend.fixtures'

const SESSIONS = '.agents/nutstore-sync/sessions'

function makeSessionWithText(text: string) {
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
				timeline: [
					{ id: `m-${text}`, role: 'user', parts: [{ type: 'text', text }] },
				],
				operations: {},
				toolTimings: {},
				subagents: {},
			},
		},
	}
}

describe('JSONL session log backend compaction', () => {
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
		expect(segments.length).toBeLessThanOrEqual(2)
		const index = JSON.parse(
			adapter.files.get(
				'.agents/nutstore-sync/sessions/session-log-1/index.json',
			)!,
		)
		expect(segments.some((file) => file.endsWith(index.activeSegment))).toBe(
			true,
		)
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

	it('prunes old segments to the retention window after repeated compaction', async () => {
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
		expect(segmentFiles.length).toBeGreaterThan(0)
		expect(segmentFiles.length).toBeLessThanOrEqual(2)

		const coldBackend = new SessionsFileBackend(makeVault(adapter))
		const payload = await coldBackend.readSessionFile('session-log-1')
		const timeline = (
			payload.session as unknown as {
				subagents: { master: { timeline: unknown[] } }
			}
		).subagents.master.timeline
		expect(timeline).toHaveLength(128)
	})

	// CT-N1: the active segment named by the index is authoritative; a stale
	// whole-session snapshot in the log must not wipe it.
	it('keeps the active segment when a stale log snapshot reappears (WS1-N1)', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionLogBackend(makeVault(adapter), {
			sessionsDir: SESSIONS,
		})
		const live = makeSession(2)
		await backend.writeSessionFile('c', live, live)
		const logPath = `${SESSIONS}/c/log.jsonl`
		const staleLog = adapter.files.get(logPath) ?? ''

		await backend.compactSession('c', makeSession(3))
		expect(adapter.files.get(logPath)).toBe('')
		// Crash/sync window: the pre-compaction log is present again.
		adapter.files.set(logPath, staleLog)

		const session = await backend.readSessionFile('c')
		expect(JSON.stringify(session)).toContain('message 3')
	})

	// CT-N3: an externally synced newer segment must win when the index is
	// demonstrably older; an aborted-compaction orphan (index not older) is
	// still ignored by the generation cap.
	it('reads an externally synced newer segment when the index is stale (WS1-N3)', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionLogBackend(makeVault(adapter), {
			sessionsDir: SESSIONS,
		})
		const local = makeSession(1)
		await backend.writeSessionFile('g', local, local)
		const dir = `${SESSIONS}/g`
		const logPath = `${dir}/log.jsonl`
		const indexPath = `${dir}/index.json`
		adapter.files.set(logPath, '')
		const oldSeg = `${dir}/seg/0001-0001.json`
		const newSeg = `${dir}/seg/0040-0002.json`
		adapter.files.set(
			oldSeg,
			JSON.stringify(makeSessionWithText('OLD_SEGMENT')),
		)
		adapter.files.set(
			newSeg,
			JSON.stringify(makeSessionWithText('EXTERNAL_NEWER')),
		)
		const idx = JSON.parse(adapter.files.get(indexPath) ?? '{}') as {
			generation: number
			activeSegment?: string
		}
		idx.generation = 2
		delete idx.activeSegment
		adapter.files.set(indexPath, JSON.stringify(idx, null, 2))

		const baseStat = adapter.stat.bind(adapter)
		adapter.stat = async (path: string) => {
			const stat = await baseStat(path)
			if (!stat) return stat
			if (path === newSeg)
				return { ...stat, mtime: 200 } as unknown as typeof stat
			if (path === indexPath)
				return { ...stat, mtime: 100 } as unknown as typeof stat
			return stat
		}

		const session = await backend.readSessionFile('g')
		const text = JSON.stringify(session)
		expect(text).toContain('EXTERNAL_NEWER')
		expect(text).not.toContain('OLD_SEGMENT')
	})
})
