import { describe, expect, it } from 'vitest'
import { SessionsFileBackend } from './session-files'
import {
	MemoryAdapter,
	makeSession,
	makeVault,
} from './session-log-backend.fixtures'

describe('JSONL session log backend sidecars', () => {
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

	it('reads legacy agent records that embed toolTimings', async () => {
		const adapter = new MemoryAdapter()
		const id = 'session-log-1'
		const dir = `.agents/nutstore-sync/sessions/${id}`
		adapter.files.set(
			`${dir}/index.json`,
			JSON.stringify({
				formatVersion: 1,
				id,
				generation: 1,
				updatedAt: 1,
				agents: [],
			}),
		)
		adapter.files.set(
			`${dir}/log.jsonl`,
			`${JSON.stringify({
				type: 'agent',
				agentPath: ['master'],
				agent: {
					id: 'master',
					type: 'master',
					status: 'idle',
					createdAt: 1,
					updatedAt: 1,
					pendingInputs: [],
					readVaultPaths: [],
					toolTimings: {
						legacy: { startedAt: 1, finishedAt: 2, outcome: 'completed' },
					},
				},
			})}\n`,
		)
		const backend = new SessionsFileBackend(makeVault(adapter))
		const payload = await backend.readSessionFile(id)
		const master = (
			payload.session as unknown as {
				subagents: { master: { toolTimings: Record<string, unknown> } }
			}
		).subagents.master
		expect(master.toolTimings.legacy).toEqual({
			startedAt: 1,
			finishedAt: 2,
			outcome: 'completed',
		})
	})

	it('writes toolTimings incrementally and reads them back', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const session = JSON.parse(JSON.stringify(makeSession(30))) as {
			subagents: { master: { toolTimings: Record<string, unknown> } }
		}
		session.subagents.master.toolTimings['call-1'] = { startedAt: 1 }
		await backend.writeSessionFile(
			'session-log-1',
			{ session: session as never, title: 'timings' },
			session as never,
		)
		const index = JSON.parse(
			adapter.files.get(
				'.agents/nutstore-sync/sessions/session-log-1/index.json',
			)!,
		)
		expect(index.formatVersion).toBe(2)
		const appendBytesBefore = adapter.appendBytes
		session.subagents.master.toolTimings['call-1'] = {
			startedAt: 1,
			finishedAt: 2,
			outcome: 'completed',
		}
		await backend.writeSessionFile(
			'session-log-1',
			{ session: session as never, title: 'timings' },
			session as never,
		)
		const appendedBytes = adapter.appendBytes - appendBytesBefore
		expect(appendedBytes).toBeGreaterThan(0)
		expect(appendedBytes).toBeLessThan(1_000)
		const payload = await backend.readSessionFile('session-log-1')
		const master = (
			payload.session as unknown as {
				subagents: { master: { toolTimings: Record<string, unknown> } }
			}
		).subagents.master
		expect(master.toolTimings['call-1']).toEqual({
			startedAt: 1,
			finishedAt: 2,
			outcome: 'completed',
		})
	})

	it('rejects an unknown session index format version', async () => {
		const adapter = new MemoryAdapter()
		const id = 'session-log-1'
		const dir = `.agents/nutstore-sync/sessions/${id}`
		adapter.files.set(
			`${dir}/index.json`,
			JSON.stringify({
				formatVersion: 99,
				id,
				generation: 1,
				updatedAt: 1,
				agents: [],
			}),
		)
		const backend = new SessionsFileBackend(makeVault(adapter))
		await expect(backend.readSessionFile(id)).rejects.toThrow(
			'Unsupported session index format version 99',
		)
	})

	// CT-N2: an index written for another session id must not be trusted; its
	// segment must never be surfaced as this session's content.
	it('rejects a foreign index id instead of surfacing another session (WS1-N2)', async () => {
		const adapter = new MemoryAdapter()
		const id = 'session-log-1'
		const dir = `.agents/nutstore-sync/sessions/${id}`
		adapter.files.set(
			`${dir}/index.json`,
			JSON.stringify({
				formatVersion: 2,
				id: 'some-other-session',
				generation: 5,
				updatedAt: 1,
				activeSegment: '0005-0001.json',
				agents: [],
			}),
		)
		adapter.files.set(
			`${dir}/seg/0005-0001.json`,
			JSON.stringify(makeSession(1)),
		)
		const backend = new SessionsFileBackend(makeVault(adapter))
		await expect(backend.readSessionFile(id)).rejects.toThrow(
			'Session log not found',
		)
	})
})
