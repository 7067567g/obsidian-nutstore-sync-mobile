import { describe, expect, it } from 'vitest'
import {
	ATOMIC_BACKUP_MARKER,
	ATOMIC_TEMP_MARKER,
} from '~/utils/atomic-replace'
import { SessionLogBackend } from './session-log-backend'
import { SessionsFileBackend } from './session-files'
import {
	MemoryAdapter,
	encoded,
	makeSession,
	makeVault,
} from './session-log-backend.fixtures'

describe('JSONL session log backend recovery', () => {
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

	it('removes a zero-byte temp even when the target is missing', async () => {
		const adapter = new MemoryAdapter()
		const sessionsDir = '.agents/nutstore-sync/sessions/session-log-1'
		const segDir = `${sessionsDir}/seg`
		const seed = makeSession(2)
		const backend = new SessionsFileBackend(makeVault(adapter))
		await backend.writeSessionFile(
			'session-log-1',
			{ session: seed, title: 'seed' },
			seed,
		)
		adapter.files.set(`${segDir}/0001-0002.json${ATOMIC_TEMP_MARKER}zero`, '')

		const coldBackend = new SessionsFileBackend(makeVault(adapter))
		await coldBackend.readSessionFile('session-log-1')
		expect(
			adapter.files.has(`${segDir}/0001-0002.json${ATOMIC_TEMP_MARKER}zero`),
		).toBe(false)
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

	// CT-N6 / WS1-N6: the identity-keyed JSON cache used to be module-global, so
	// a warm object from one backend injected stale JSON into another backend.
	it('does not leak a warm identity cache across backend instances (WS1-N6)', async () => {
		const adapter = new MemoryAdapter()
		const first = new SessionsFileBackend(makeVault(adapter))
		const live = makeSession(2) as {
			subagents: {
				master: { timeline: Array<{ parts: Array<{ text: string }> }> }
			}
		}
		await first.writeSessionFile(
			'session-log-1',
			{ session: live as never, title: 't' },
			live as never,
		)
		await first.writeSessionFile(
			'session-log-1',
			{ session: live as never, title: 't' },
			live as never,
		)

		const second = new SessionsFileBackend(makeVault(adapter))
		// Seed the second backend's state from disk so its next write is a delta.
		await second.writeSessionFile(
			'session-log-1',
			{ session: encoded(live), title: 't' },
			undefined,
		)
		const logPath = '.agents/nutstore-sync/sessions/session-log-1/log.jsonl'
		const before = adapter.files.get(logPath) ?? ''
		live.subagents.master.timeline[1].parts.push({
			text: ' ACROSS_INSTANCES',
		})
		await second.writeSessionFile(
			'session-log-1',
			{ session: live as never, title: 't' },
			live as never,
		)
		const after = adapter.files.get(logPath) ?? ''
		expect(after).not.toBe(before)
		expect(after).toContain('ACROSS_INSTANCES')
	})

	// CT-H2: an external writer bumped the index generation and appended to the
	// log; the write-side state must see it and generation must stay monotonic.
	it('detects an external log/index change and keeps generation monotonic (H2)', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionLogBackend(makeVault(adapter), {
			sessionsDir: '.agents/nutstore-sync/sessions',
			// This test exercises the probe itself; the production default TTL
			// (R2b/S2) would intentionally defer it.
			stateFreshnessTtlMs: 0,
		})
		const live = makeSession(2) as {
			subagents: {
				master: { timeline: Array<{ parts: Array<{ text: string }> }> }
			}
		}
		await backend.writeSessionFile('h2', live as never, live as never)
		const dir = '.agents/nutstore-sync/sessions/h2'
		const logPath = `${dir}/log.jsonl`
		const indexPath = `${dir}/index.json`
		const idx = JSON.parse(adapter.files.get(indexPath) ?? '{}') as {
			generation: number
		}
		const externalGen = idx.generation + 40
		const external = {
			type: 'message',
			agentPath: ['master'],
			messageId: 'external-1',
			index: 99,
			message: {
				id: 'external-1',
				role: 'user',
				parts: [{ type: 'text', text: 'EXTERNAL_RECORD' }],
			},
		}
		adapter.files.set(
			logPath,
			`${adapter.files.get(logPath) ?? ''}${JSON.stringify(external)}\n`,
		)
		idx.generation = externalGen
		adapter.files.set(indexPath, JSON.stringify(idx, null, 2))

		const state = await (
			backend as unknown as {
				loadState(id: string): Promise<{
					generation: number
					messages: Map<string, unknown>
				}>
			}
		).loadState('h2')
		expect(state.generation).toBe(externalGen)
		expect(state.messages.has('master\u0000external-1')).toBe(true)

		live.subagents.master.timeline[1].parts.push({ text: ' LOCAL' })
		await backend.writeSessionFile('h2', live as never, live as never)

		const after = JSON.parse(adapter.files.get(indexPath) ?? '{}') as {
			generation: number
		}
		expect(after.generation).toBe(externalGen + 1)
	})

	// CT-N5: a reload after an external change rebuilds state from disk instead
	// of reusing the previous in-memory keys.
	it('rebuilds state from disk without keeping previous keys (WS1-N5)', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionLogBackend(makeVault(adapter), {
			sessionsDir: '.agents/nutstore-sync/sessions',
			// Same as H2: force the per-write probe this test is about.
			stateFreshnessTtlMs: 0,
		})
		const live = makeSession(2)
		await backend.writeSessionFile('n5', live, live)
		const dir = '.agents/nutstore-sync/sessions/n5'
		const indexPath = `${dir}/index.json`
		const idx = JSON.parse(adapter.files.get(indexPath) ?? '{}') as {
			generation: number
		}
		idx.generation += 1
		adapter.files.set(indexPath, JSON.stringify(idx, null, 2))
		adapter.files.set(
			`${dir}/log.jsonl`,
			`${JSON.stringify({
				type: 'message',
				agentPath: ['master'],
				messageId: 'external-9',
				index: 9,
				message: {
					id: 'external-9',
					role: 'user',
					parts: [{ type: 'text', text: 'ONLY_EXTERNAL' }],
				},
			})}\n`,
		)

		const state = await (
			backend as unknown as {
				loadState(id: string): Promise<{ messages: Map<string, unknown> }>
			}
		).loadState('n5')
		expect(state.messages.has('master\u0000external-9')).toBe(true)
		expect(state.messages.has('master\u0000message-1')).toBe(false)
		expect(state.messages.has('master\u0000message-2')).toBe(false)
	})

	// CT-N7: an external append that lands between the torn-tail scan and the
	// repair rewrite must not be dropped by the stale in-memory prefix.
	it('preserves an external append that lands before a torn-tail repair (WS1-N7)', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionLogBackend(makeVault(adapter), {
			sessionsDir: '.agents/nutstore-sync/sessions',
		})
		const first = makeSession(2)
		await backend.writeSessionFile('n7', first, first)
		const logPath = '.agents/nutstore-sync/sessions/n7/log.jsonl'
		const original = adapter.files.get(logPath) ?? ''
		// A sync/crash window left the last committed line without its newline.
		adapter.files.set(logPath, original.slice(0, -1))
		const externalSnapshot = {
			type: 'snapshot',
			session: {
				schemaVersion: 2,
				id: 'n7',
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
							{
								id: 'external-x',
								role: 'user',
								parts: [{ type: 'text', text: 'EXTERNAL_SNAPSHOT' }],
							},
						],
						operations: {},
						toolTimings: {},
						subagents: {},
					},
				},
			},
		}
		const withExternal = `${original}${JSON.stringify(externalSnapshot)}\n`
		// Reopen cold so loadState actually scans the torn tail and arms the
		// pending repair; then the external append lands before the rewrite.
		const reopened = new SessionLogBackend(makeVault(adapter), {
			sessionsDir: '.agents/nutstore-sync/sessions',
		})
		const target = reopened as unknown as {
			loadState(id: string): Promise<unknown>
		}
		const originalLoad = target.loadState.bind(reopened)
		target.loadState = async (id: string) => {
			const state = await originalLoad(id)
			adapter.files.set(logPath, withExternal)
			return state
		}

		const next = makeSession(3)
		await reopened.writeSessionFile('n7', next, next)
		expect(adapter.files.get(logPath) ?? '').toContain('EXTERNAL_SNAPSHOT')
	})
})
