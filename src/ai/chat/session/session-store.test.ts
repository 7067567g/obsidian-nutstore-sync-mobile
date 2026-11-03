import { describe, expect, it } from 'vitest'
import type { Vault } from 'obsidian'
import type { ChatSession } from '~/ai/chat/domain'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import { SessionsFileBackend } from './session-files'
import {
	SessionStore,
	SessionUnavailableError,
	type SessionLegacyStore,
} from './session-store'

class MemoryAdapter {
	readonly files = new Map<string, string>()
	readonly dirs = new Set<string>()

	async exists(path: string) {
		return this.files.has(path) || this.dirs.has(path)
	}

	async read(path: string) {
		const value = this.files.get(path)
		if (value === undefined) throw new Error(`missing file: ${path}`)
		return value
	}

	async write(path: string, data: string) {
		this.ensureParent(path)
		this.files.set(path, data)
	}

	async append(path: string, data: string) {
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
		const value = this.files.get(path)
		return value === undefined
			? null
			: { type: 'file' as const, size: value.length }
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
		const value = this.files.get(from)
		if (value === undefined) throw new Error(`missing source: ${from}`)
		this.files.delete(from)
		this.files.set(to, value)
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

function makeSession(id: string) {
	return {
		schemaVersion: 2,
		id,
		createdAt: 1,
		updatedAt: 2,
		subagents: {
			master: {
				id: 'master',
				type: 'master',
				status: 'idle',
				createdAt: 1,
				updatedAt: 2,
				timeline: [],
				pendingInputs: [],
				operations: {},
				toolTimings: {},
				subagents: {},
			},
		},
	} as never
}

function makeStore(
	adapter: MemoryAdapter,
	backend = new SessionsFileBackend(makeVault(adapter)),
) {
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
	return { store, state, backend }
}

describe('SessionStore single source of truth', () => {
	it('rebuilds the index from session files when chat-meta is missing', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const session = makeSession('session-a')
		await backend.writeSessionFile(
			'session-a',
			{ session, title: 'A' },
			session,
		)

		const { store, state } = makeStore(adapter)
		await store.loadSessionIndex()

		expect(state.sessionIndex.map((item) => item.id)).toEqual(['session-a'])
		expect(state.activeSessionId).toBe('session-a')
		expect(adapter.files.has('.agents/nutstore-sync/chat-meta.json')).toBe(true)
	})

	it('round-trips a tool timing without startedAt', async () => {
		const adapter = new MemoryAdapter()
		const { store, state, backend } = makeStore(adapter)
		const session = makeSession('session-a') as ChatSession
		session.subagents.master.toolTimings['call-1'] = {
			finishedAt: 2,
			outcome: 'not-started',
		}
		state.loadedSessions.set('session-a', session)

		await store.persistSession(session)
		const payload = (await backend.readSessionFile('session-a')) as unknown as {
			session: ChatSession
		}
		expect(payload.session.subagents.master.toolTimings['call-1']).toEqual({
			finishedAt: 2,
			outcome: 'not-started',
		})
	})

	it('flushSession is not a persistence barrier; persistSession schedules and drains', async () => {
		const adapter = new MemoryAdapter()
		const { store, state } = makeStore(adapter)
		const session = makeSession('session-a')
		state.loadedSessions.set('session-a', session)

		await store.flushSession('session-a')
		expect(
			[...adapter.files.keys()].some((path) => path.includes('session-a')),
		).toBe(false)

		await store.persistSession(session)
		expect(
			[...adapter.files.keys()].some((path) =>
				path.endsWith('/sessions/session-a/log.jsonl'),
			),
		).toBe(true)
	})

	it('does not trust a corrupt chat-meta over session files', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const session = makeSession('session-a')
		await backend.writeSessionFile(
			'session-a',
			{ session, title: 'A' },
			session,
		)
		adapter.files.set('.agents/nutstore-sync/chat-meta.json', '{broken')

		const { store, state } = makeStore(adapter)
		await store.loadSessionIndex()

		expect(state.sessionIndex.map((item) => item.id)).toEqual(['session-a'])
		expect(state.activeSessionId).toBe('session-a')
	})
})

function makeVersionedSession(id: string, modelId: string) {
	const session = makeSession(id) as unknown as ChatSession & {
		model?: { providerId: string; modelId: string }
	}
	session.model = { providerId: 'p1', modelId }
	return session
}

function writeVersionedSession(
	backend: SessionsFileBackend,
	session: ChatSession,
) {
	return backend.writeSessionFile(
		session.id,
		{ session: session as never, title: session.id },
		session,
	)
}

/** Test double: exposes the optional backend version capability (H4). */
class VersionedBackend extends SessionsFileBackend {
	private currentVersion = 0

	setVersion(version: number) {
		this.currentVersion = version
	}

	async getSessionFileVersion(_sessionId: string) {
		return this.currentVersion
	}
}

const tick = () => new Promise((resolve) => window.setTimeout(resolve, 0))

describe('SessionStore cache freshness and in-flight dedup (H4 / WS2-N1)', () => {
	it('H4: invalidateSession makes the next load re-read an external change', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const v1 = makeVersionedSession('session-a', 'm1')
		await writeVersionedSession(backend, v1)
		const { store, state } = makeStore(adapter)

		const first = await store.loadSessionById('session-a')
		expect(first.model?.modelId).toBe('m1')

		const v2 = makeVersionedSession('session-a', 'm2')
		await writeVersionedSession(backend, v2)

		// With no backend version source the cached object stays authoritative…
		expect(await store.loadSessionById('session-a')).toBe(first)

		// …until an external-write path explicitly invalidates it.
		expect(store.invalidateSession('session-a')).toBe(true)
		expect(state.loadedSessions.has('session-a')).toBe(false)
		const refreshed = await store.loadSessionById('session-a')
		expect(refreshed.model?.modelId).toBe('m2')
		expect(state.loadedSessions.get('session-a')).toBe(refreshed)
	})

	it('H4: a backend version source revalidates the cache automatically', async () => {
		const adapter = new MemoryAdapter()
		const backend = new VersionedBackend(makeVault(adapter))
		const v1 = makeVersionedSession('session-a', 'm1')
		backend.setVersion(1)
		await writeVersionedSession(backend, v1)
		const { store } = makeStore(adapter, backend)

		const first = await store.loadSessionById('session-a')
		expect(first.model?.modelId).toBe('m1')

		const v2 = makeVersionedSession('session-a', 'm2')
		await writeVersionedSession(backend, v2)
		backend.setVersion(2)

		const second = await store.loadSessionById('session-a')
		expect(second).not.toBe(first)
		expect(second.model?.modelId).toBe('m2')
	})

	it('WS2-N1: concurrent loads share one read and return one instance', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const v1 = makeVersionedSession('session-a', 'm1')
		await writeVersionedSession(backend, v1)
		const { store, state } = makeStore(adapter, backend)
		const originalRead = backend.readSessionFile.bind(backend)
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let reads = 0
		backend.readSessionFile = async (id, options) => {
			if (id === 'session-a') {
				reads += 1
				if (reads === 1) await gate
			}
			return originalRead(id, options)
		}

		const p1 = store.loadSessionById('session-a')
		await tick()
		const p2 = store.loadSessionById('session-a')
		release()
		const [s1, s2] = await Promise.all([p1, p2])

		expect(reads).toBe(1)
		expect(s1).toBe(s2)
		expect(state.loadedSessions.get('session-a')).toBe(s1)
	})
})

describe('SessionStore WS-7 (H4 real version source / WS2-N3 transient read)', () => {
	it('H4: a real sessions backend version source revalidates the cache automatically', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter), {
			trackSessionFileVersions: true,
		})
		const { store } = makeStore(adapter, backend)

		const first = makeVersionedSession('session-a', 'm1')
		await writeVersionedSession(backend, first)
		const loadedFirst = await store.loadSessionById('session-a')
		expect(loadedFirst.model?.modelId).toBe('m1')

		// External rewrite (another writer sharing the vault adapter): no explicit
		// invalidateSession call, the K16 version token must catch it.
		const second = makeVersionedSession('session-a', 'm2')
		await writeVersionedSession(backend, second)

		const loadedSecond = await store.loadSessionById('session-a')
		expect(loadedSecond).not.toBe(loadedFirst)
		expect(loadedSecond.model?.modelId).toBe('m2')
	})

	it('H4: version tracking stays inert when the backend has not opted in', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const { store } = makeStore(adapter, backend)

		const first = makeVersionedSession('session-a', 'm1')
		await writeVersionedSession(backend, first)
		const loadedFirst = await store.loadSessionById('session-a')

		const second = makeVersionedSession('session-a', 'm2')
		await writeVersionedSession(backend, second)

		// Legacy contract: the cache stays authoritative until invalidateSession.
		expect(await store.loadSessionById('session-a')).toBe(loadedFirst)
	})

	it('WS2-N3: a transient read failure does not trim the session index', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const session = makeVersionedSession('session-a', 'm1')
		await writeVersionedSession(backend, session)

		const { store, state } = makeStore(adapter, backend)
		await store.loadSessionIndex()
		expect(state.sessionIndex.map((item) => item.id)).toEqual(['session-a'])

		// The file is still on disk; the read fails transiently (sync/IO race).
		backend.readSessionFile = async () => {
			throw new Error('temporary I/O failure')
		}

		await expect(store.loadSessionById('session-a')).rejects.toBeInstanceOf(
			SessionUnavailableError,
		)
		// A transient failure must not trigger the reconcile that drops the entry.
		expect(state.sessionIndex.map((item) => item.id)).toEqual(['session-a'])
	})

	it('WS2-N3: reconcile keeps indexed items that are temporarily unreadable', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const session = makeVersionedSession('session-a', 'm1')
		await writeVersionedSession(backend, session)

		const { store, state } = makeStore(adapter, backend)
		await store.loadSessionIndex()
		expect(state.sessionIndex.map((item) => item.id)).toEqual(['session-a'])

		backend.readSessionFile = async () => {
			throw new Error('temporary I/O failure')
		}

		// Force the reconcile path (no trusted meta cache) while the file is
		// transiently unreadable.
		adapter.files.delete('.agents/nutstore-sync/chat-meta.json')
		await store.loadSessionIndex()
		expect(state.sessionIndex.map((item) => item.id)).toEqual(['session-a'])
	})

	it('WS2-N2: a failed backend delete does not poison deletedSessionIds', async () => {
		const adapter = new MemoryAdapter()
		const backend = new SessionsFileBackend(makeVault(adapter))
		const { store, state } = makeStore(adapter, backend)

		backend.deleteSessionFile = async () => {
			throw new Error('delete failed')
		}

		await expect(store.deleteSession('session-a')).rejects.toThrow(
			'delete failed',
		)
		expect(state.deletedSessionIds.has('session-a')).toBe(false)
	})
})
