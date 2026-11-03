/**
 * R2b persistence hot-path micro-benchmark (S2/S3/S4).
 *
 * Fixture: one 598-message session, every message ~16 KiB of text (≈9.8 MiB
 * payload). The same file is run before and after the S2–S4 rework so the
 * p50/p95/max, bridge-call counts and bytes handed to `JSON.stringify` are
 * directly comparable.
 *
 * This test intentionally has no performance assertion: durations depend on
 * the machine. It asserts only that the measured writes are real (the log grows
 * by one record per iteration) and prints one stable `PERF-R2B {...}` line.
 */
import { describe, expect, it } from 'vitest'
import type { ChatSession } from '~/ai/chat/domain'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import { SessionsFileBackend } from './session-files'
import { SessionStore, type SessionLegacyStore } from './session-store'
import { MemoryAdapter, makeVault } from './session-log-backend.fixtures'

const MESSAGE_COUNT = 598
const MESSAGE_BYTES = 16 * 1024
const ITERATIONS = 24
const LOAD_ITERATIONS = 50
const SESSION_ID = 'bench-session'

function largeSession(): ChatSession {
	return {
		schemaVersion: 2,
		id: SESSION_ID,
		createdAt: 1,
		updatedAt: 1,
		subagents: {
			master: {
				id: 'master',
				type: 'master',
				status: 'idle',
				createdAt: 1,
				updatedAt: 1,
				timeline: Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
					id: `message-${index + 1}`,
					role: index % 2 === 0 ? 'user' : 'assistant',
					metadata: { createdAt: 1 },
					parts: [
						{
							type: 'text',
							text: `m${index + 1}:${'x'.repeat(MESSAGE_BYTES)}`,
						},
					],
				})),
				pendingInputs: [],
				operations: {},
				toolTimings: {},
				subagents: {},
			},
		},
	} as unknown as ChatSession
}

function appendedMessage(index: number) {
	return {
		id: `appended-${index}`,
		role: 'assistant',
		metadata: { createdAt: 1 },
		parts: [{ type: 'text', text: `a${index}:${'y'.repeat(MESSAGE_BYTES)}` }],
	}
}

function makeStore(backend: SessionsFileBackend) {
	const state = {
		sessionIndex: [],
		activeSessionId: undefined,
		deletedSessionIds: new Set<string>(),
		loadedSessions: new Map(),
	} as unknown as ChatState
	const selection = {
		sanitizeSessionSelection: () => false,
	} as unknown as Selection
	const legacy: SessionLegacyStore = {
		listSessionKeys: async () => [],
		getSession: async () => undefined,
		unsetSession: async () => undefined,
		getMeta: async () => ({ meta: null, index: [] }),
	}
	const store = new SessionStore(state, selection, backend, legacy, undefined)
	return { store, state }
}

function percentile(samples: number[], fraction: number) {
	const sorted = [...samples].sort((left, right) => left - right)
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(sorted.length * fraction) - 1),
	)
	return sorted[index]
}

function summarize(samples: number[]) {
	const total = samples.reduce((sum, value) => sum + value, 0)
	return {
		p50: Math.round(percentile(samples, 0.5) * 100) / 100,
		p95: Math.round(percentile(samples, 0.95) * 100) / 100,
		max: Math.round(Math.max(...samples) * 100) / 100,
		avg: Math.round((total / samples.length) * 100) / 100,
	}
}

function pct(value: number, total: number) {
	return Math.round((value / total) * 100)
}

describe('R2b persistence hot path micro-benchmark', () => {
	it('measures the 598 × 16 KiB fixture before/after', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter), {
			trackSessionFileVersions: true,
			// Isolate the S2–S4 hot path: a 512 KiB threshold would compact
			// this 9.8 MiB session during the run, and the compaction spike
			// would dominate the p50/p95 that S2–S4 must be compared on.
			sessionLogCompactionBytes: Number.MAX_SAFE_INTEGER,
		})
		const { store, state } = makeStore(backend)
		const session = largeSession()

		// Cold write: one whole-session snapshot.
		await backend.writeSessionFile(
			SESSION_ID,
			{ session: session as never, title: 'bench' },
			session,
		)
		state.loadedSessions.set(SESSION_ID, session)
		const loaded = await store.loadSessionById(SESSION_ID)

		// S3: repeated cache hits on an unchanged on-disk session.
		const loadSamples: number[] = []
		adapter.resetBridgeCalls()
		const loadStartCalls = adapter.totalBridgeCalls()
		for (let index = 0; index < LOAD_ITERATIONS; index += 1) {
			const startedAt = performance.now()
			const cached = await store.loadSessionById(SESSION_ID)
			loadSamples.push(performance.now() - startedAt)
			expect(cached).toBe(loaded)
		}
		const loadCalls = adapter.totalBridgeCalls() - loadStartCalls
		const loadStatCalls = adapter.bridgeCalls.stat

		// S2/S4: append one 16 KiB message at the backend layer. This isolates
		// the persistence write path from `encodeChatSessionForStorage`.
		const logPath = `.agents/nutstore-sync/sessions/${SESSION_ID}/log.jsonl`
		const logLineCount = () =>
			(adapter.files.get(logPath) ?? '').split('\n').filter(Boolean).length
		const backendSamples: number[] = []
		const backendStringifySamples: number[] = []
		let backendStringifyBytes = 0
		adapter.resetBridgeCalls()
		const backendStartCalls = adapter.totalBridgeCalls()
		const originalStringify = JSON.stringify
		for (let index = 0; index < ITERATIONS; index += 1) {
			loaded.subagents.master.timeline.push(appendedMessage(index) as never)
			let stringifyBytes = 0
			JSON.stringify = ((...args: Parameters<typeof originalStringify>) => {
				const output = originalStringify.apply(JSON, args)
				if (typeof output === 'string') stringifyBytes += output.length
				return output
			}) as typeof originalStringify
			const startedAt = performance.now()
			try {
				await backend.writeSessionFile(
					SESSION_ID,
					{ session: loaded as never, title: 'bench' },
					loaded as never,
				)
			} finally {
				backendSamples.push(performance.now() - startedAt)
				JSON.stringify = originalStringify
			}
			backendStringifySamples.push(stringifyBytes)
			backendStringifyBytes += stringifyBytes
		}
		const backendCalls = adapter.totalBridgeCalls() - backendStartCalls
		const backendListCalls = adapter.bridgeCalls.list
		const afterBackendLines = logLineCount()

		// End-to-end store persist (includes `encodeChatSessionForStorage`, the
		// real production call site).
		const storeSamples: number[] = []
		const storeStringifySamples: number[] = []
		let storeStringifyBytes = 0
		adapter.resetBridgeCalls()
		const storeStartCalls = adapter.totalBridgeCalls()
		for (let index = 0; index < ITERATIONS; index += 1) {
			loaded.subagents.master.timeline.push(
				appendedMessage(ITERATIONS + index) as never,
			)
			let stringifyBytes = 0
			JSON.stringify = ((...args: Parameters<typeof originalStringify>) => {
				const output = originalStringify.apply(JSON, args)
				if (typeof output === 'string') stringifyBytes += output.length
				return output
			}) as typeof originalStringify
			const startedAt = performance.now()
			try {
				await store.persistSession(loaded)
			} finally {
				storeSamples.push(performance.now() - startedAt)
				JSON.stringify = originalStringify
			}
			storeStringifySamples.push(stringifyBytes)
			storeStringifyBytes += stringifyBytes
		}
		const storeCalls = adapter.totalBridgeCalls() - storeStartCalls

		const afterStoreLines = logLineCount()
		expect(afterBackendLines).toBeGreaterThanOrEqual(1 + ITERATIONS)
		expect(afterStoreLines).toBeGreaterThanOrEqual(
			afterBackendLines + ITERATIONS,
		)

		const report = {
			messages: MESSAGE_COUNT,
			messageBytes: MESSAGE_BYTES,
			payloadBytes: (adapter.files.get(logPath) ?? '').length,
			iterations: ITERATIONS,
			loadCached: {
				...summarize(loadSamples),
				bridgeCallsPerLoad:
					Math.round((loadCalls / LOAD_ITERATIONS) * 100) / 100,
				statCallsPerLoad:
					Math.round((loadStatCalls / LOAD_ITERATIONS) * 100) / 100,
			},
			persistBackend: {
				...summarize(backendSamples),
				bridgeCallsPerPersist:
					Math.round((backendCalls / ITERATIONS) * 100) / 100,
				listCallsPerPersist:
					Math.round((backendListCalls / ITERATIONS) * 100) / 100,
				stringifyBytesPerPersist: Math.round(
					backendStringifyBytes / ITERATIONS,
				),
				stringifyBytesP50: summarize(backendStringifySamples).p50,
				stringifyBytesP95: summarize(backendStringifySamples).p95,
			},
			persistStore: {
				...summarize(storeSamples),
				bridgeCallsPerPersist:
					Math.round((storeCalls / ITERATIONS) * 100) / 100,
				stringifyBytesPerPersist: Math.round(storeStringifyBytes / ITERATIONS),
				stringifyBytesP50: summarize(storeStringifySamples).p50,
				stringifyBytesP95: summarize(storeStringifySamples).p95,
				stringifyPctOfPayload: pct(
					storeStringifyBytes / ITERATIONS,
					(adapter.files.get(logPath) ?? '').length,
				),
			},
		}
		process.stdout.write(`PERF-R2B ${JSON.stringify(report)}\n`)
	}, 180_000)
})
