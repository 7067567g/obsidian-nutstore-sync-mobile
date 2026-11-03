import { describe, expect, it } from 'vitest'
import { SessionsFileBackend } from './session-files'
import {
	MemoryAdapter,
	encoded,
	makeSession,
	makeVault,
} from './session-log-backend.fixtures'

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

	// CT-H1 / WS1-N6: identity-keyed JSON caches must not serve stale content
	// after the projector mutates a live message's `parts` in place.
	it('persists in-place part mutations instead of a stale cached JSON (H1)', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const live = makeSession(3) as {
			subagents: {
				master: {
					timeline: Array<{ parts: Array<{ text: string }> }>
				}
			}
		}
		await backend.writeSessionFile(
			'session-log-1',
			{ session: live as never, title: 'stream' },
			live as never,
		)
		// The second unchanged write previously warmed the identity cache.
		await backend.writeSessionFile(
			'session-log-1',
			{ session: live as never, title: 'stream' },
			live as never,
		)
		const logPath = '.agents/nutstore-sync/sessions/session-log-1/log.jsonl'
		const before = adapter.files.get(logPath) ?? ''

		live.subagents.master.timeline[2].parts.push({
			text: ' STREAMED_TOKEN',
		})
		await backend.writeSessionFile(
			'session-log-1',
			{ session: live as never, title: 'stream' },
			live as never,
		)

		const after = adapter.files.get(logPath) ?? ''
		expect(after).not.toBe(before)
		expect(after).toContain('STREAMED_TOKEN')
		const payload = await backend.readSessionFile('session-log-1')
		expect(JSON.stringify(payload.session)).toContain('STREAMED_TOKEN')
	})

	// R2 / S1 port: the signature cache must invalidate when the projector
	// replaces a part object while keeping the same message and parts length.
	it('re-serialises a message whose part object was replaced (cache freshness)', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const live = makeSession(2) as {
			subagents: {
				master: {
					timeline: Array<{ parts: Array<{ type?: string; text: string }> }>
				}
			}
		}
		await backend.writeSessionFile(
			'session-log-1',
			{ session: live as never, title: 'cache freshness' },
			live as never,
		)
		// Same message object, same parts length, replaced part object.
		live.subagents.master.timeline[0].parts[0] = {
			type: 'text',
			text: 'CHANGED',
		}
		const before = adapter.appendBytes
		await backend.writeSessionFile(
			'session-log-1',
			{ session: live as never, title: 'cache freshness' },
			live as never,
		)
		expect(adapter.appendBytes - before).toBeGreaterThan(0)
		const logPath = '.agents/nutstore-sync/sessions/session-log-1/log.jsonl'
		expect(adapter.files.get(logPath) ?? '').toContain('CHANGED')

		// The unchanged live object must hit the cache and append nothing.
		const beforeSecondWrite = adapter.appendBytes
		await backend.writeSessionFile(
			'session-log-1',
			{ session: live as never, title: 'cache freshness' },
			live as never,
		)
		expect(adapter.appendBytes - beforeSecondWrite).toBe(0)
	})

	// CT-N4 (guard): in-place operation array mutations must keep landing now
	// that the dead `operationJsonCache` is gone.
	it('persists in-place operation array mutations (WS1-N4 guard)', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const live = makeSession(2) as {
			subagents: {
				master: {
					operations: Record<string, Array<{ value: string }>>
				}
			}
		}
		live.subagents.master.operations = {
			'message-1': [{ value: 'FIRST' }],
		}
		await backend.writeSessionFile(
			'session-log-1',
			{ session: live as never, title: 'ops' },
			live as never,
		)
		await backend.writeSessionFile(
			'session-log-1',
			{ session: live as never, title: 'ops' },
			live as never,
		)
		const logPath = '.agents/nutstore-sync/sessions/session-log-1/log.jsonl'
		const before = adapter.files.get(logPath) ?? ''
		live.subagents.master.operations['message-1'].push({ value: 'SECOND' })
		await backend.writeSessionFile(
			'session-log-1',
			{ session: live as never, title: 'ops' },
			live as never,
		)
		const after = adapter.files.get(logPath) ?? ''
		expect(after).not.toBe(before)
		expect(after).toContain('SECOND')
	})

	// R2b / S2: the write-before freshness probe is TTL-bounded.
	it('skips the index read and log stat for a persist inside the freshness TTL', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const session = makeSession(20)
		await backend.writeSessionFile(
			'session-log-1',
			{ session, title: 'ttl' },
			session,
		)

		adapter.resetBridgeCalls()
		await backend.writeSessionFile(
			'session-log-1',
			{ session, title: 'ttl' },
			session,
		)

		// The old per-write probe read index.json (adapter.read) and stat'ed
		// log.jsonl (adapter.stat). Inside the TTL neither happens.
		expect(adapter.bridgeCalls.read).toBe(0)
		expect(adapter.bridgeCalls.stat).toBe(0)
	})

	it('with the TTL disabled, an external append is seen and tombstoned', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter), {
			stateFreshnessTtlMs: 0,
		})
		const session = makeSession(20)
		await backend.writeSessionFile(
			'session-log-1',
			{ session, title: 'probe' },
			session,
		)

		const logPath = '.agents/nutstore-sync/sessions/session-log-1/log.jsonl'
		const external = {
			type: 'message',
			agentPath: ['master'],
			messageId: 'external',
			index: 20,
			message: {
				id: 'external',
				role: 'user',
				parts: [{ type: 'text', text: 'external' }],
			},
		}
		adapter.files.set(
			logPath,
			`${adapter.files.get(logPath) ?? ''}${JSON.stringify(external)}\n`,
		)

		adapter.resetBridgeCalls()
		await backend.writeSessionFile(
			'session-log-1',
			{ session, title: 'probe' },
			session,
		)

		// TTL 0 forces the probe: index read + log stat happen, the log size
		// mismatch reloads, and the externally-appended message (absent from the
		// live snapshot) is written back as a tombstone.
		expect(adapter.bridgeCalls.read).toBeGreaterThan(0)
		expect(adapter.bridgeCalls.stat).toBeGreaterThan(0)
		expect(adapter.files.get(logPath) ?? '').toContain('"type":"tombstone"')

		const cold = new SessionsFileBackend(makeVault(adapter))
		const payload = await cold.readSessionFile('session-log-1')
		const timeline = (
			payload.session as unknown as {
				subagents: { master: { timeline: Array<{ id: string }> } }
			}
		).subagents.master.timeline
		expect(timeline).toHaveLength(20)
		expect(timeline.some((message) => message.id === 'external')).toBe(false)
	})
})
