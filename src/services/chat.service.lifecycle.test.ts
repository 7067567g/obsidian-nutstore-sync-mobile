import { describe, expect, it } from 'vitest'
import type { Vault } from 'obsidian'
import type { ChatSession, ChatSessionIndexItem } from '~/ai/chat/domain'
import { ChatState } from '~/ai/chat/runtime/chat-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import { SessionsFileBackend } from '~/ai/chat/session/session-files'
import {
	SessionStore,
	SessionUnavailableError,
	type SessionLegacyStore,
} from '~/ai/chat/session/session-store'
import { ChatServiceLifecycle } from './chat.service.lifecycle'

/* ------------------------------------------------------------------ harness */

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
	} as unknown as ChatSession
}

function writeSession(backend: SessionsFileBackend, session: ChatSession) {
	return backend.writeSessionFile(
		session.id,
		{ session: session as never, title: session.id },
		session,
	)
}

function indexItem(id: string): ChatSessionIndexItem {
	return { id, title: id, createdAt: 1, updatedAt: 2 }
}

const tick = () => new Promise((resolve) => window.setTimeout(resolve, 0))

function makeHarness() {
	const adapter = new MemoryAdapter()
	const backend = new SessionsFileBackend(makeVault(adapter))
	const state = new ChatState()
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
	const restored: string[] = []
	const service = Object.assign(Object.create(ChatServiceLifecycle.prototype), {
		initialize: async () => undefined,
		state,
		store,
		taskManager: {
			restoreMasterTaskContinuations: (session: ChatSession) => {
				restored.push(session.id)
			},
		},
		notify: () => undefined,
	}) as ChatServiceLifecycle
	return { adapter, backend, state, store, service, restored }
}

/** Gate `readSessionFile` for one session so its load can be held open. */
function gateSessionRead(backend: SessionsFileBackend, sessionId: string) {
	const originalRead = backend.readSessionFile.bind(backend)
	let release!: () => void
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	backend.readSessionFile = async (id, options) => {
		if (id === sessionId) await gate
		return originalRead(id, options)
	}
	return { release }
}

/* --------------------------------------------------------------------- H3 */

describe('ChatServiceLifecycle.switchSession generation guard (H3)', () => {
	it('a slow first switch never overrides a newer switch', async () => {
		const { adapter, backend, state, service, restored } = makeHarness()
		const a = makeSession('session-a')
		const b = makeSession('session-b')
		await writeSession(backend, a)
		state.loadedSessions.set('session-b', b)
		state.sessionIndex = [indexItem('session-a'), indexItem('session-b')]

		const { release } = gateSessionRead(backend, 'session-a')
		const slowSwitch = service.switchSession('session-a')
		await tick()

		await service.switchSession('session-b')
		expect(state.activeSessionId).toBe('session-b')
		expect(state.switchGeneration).toBe(2)

		release()
		await slowSwitch

		// Last click wins: the late A load must not resurrect session-a.
		expect(state.activeSessionId).toBe('session-b')
		expect(restored).toEqual(['session-b'])
		const meta = JSON.parse(
			(await adapter.read('.agents/nutstore-sync/chat-meta.json')) as string,
		) as { activeSessionId: string }
		expect(meta.activeSessionId).toBe('session-b')
	})

	it('createSession supersedes a switch that is still loading', async () => {
		const { backend, state, service, restored } = makeHarness()
		const a = makeSession('session-a')
		await writeSession(backend, a)
		state.sessionIndex = [indexItem('session-a')]

		const { release } = gateSessionRead(backend, 'session-a')
		const slowSwitch = service.switchSession('session-a')
		await tick()

		const newSession = makeSession('session-new')
		Object.assign(service, {
			createEmptySession: async () => newSession,
			runtimeStates: {
				get: () => ({
					draft: { text: '', userContext: [] },
					scheduler: { queued: [], active: false },
				}),
			},
		})

		await service.createSession()
		expect(state.activeSessionId).toBe('session-new')
		expect(state.loadedSessions.get('session-new')).toBe(newSession)

		release()
		await slowSwitch

		expect(state.activeSessionId).toBe('session-new')
		expect(restored).toEqual([])
	})
})

/* ------------------------------------------------------------------- N2 */

describe('ChatServiceLifecycle.deleteSession half-commit guard (WS2-N2)', () => {
	it('a failing fallback load still commits the delete and trims only that id', async () => {
		const { adapter, backend, state, store, service } = makeHarness()
		const a = makeSession('session-a')
		const b = makeSession('session-b')
		await writeSession(backend, a)
		await writeSession(backend, b)
		state.sessionIndex = [indexItem('session-a'), indexItem('session-b')]
		state.activeSessionId = 'session-a'

		Object.assign(service, {
			compactionCoordinator: { cancel: () => undefined },
			plugin: { app: { vault: makeVault(adapter) } },
		})
		// The next-active session is temporarily unreadable at the fallback load.
		store.loadSessionById = async (id: string) => {
			if (id === 'session-b') {
				throw new SessionUnavailableError('session-b', { transient: true })
			}
			return b
		}

		await service.deleteSession('session-a')

		expect(state.sessionIndex.map((item) => item.id)).toEqual(['session-b'])
		expect(state.deletedSessionIds.has('session-a')).toBe(true)
		// The delete is committed even though the fallback load failed.
		expect(state.activeSessionId).toBeUndefined()
		expect(
			[...adapter.files.keys()].some((path) =>
				path.includes('/sessions/session-a'),
			),
		).toBe(false)
	})

	it('a failing backend delete rolls back deletedSessionIds and leaves the index intact', async () => {
		const { adapter, state, store, service } = makeHarness()
		state.sessionIndex = [indexItem('session-a'), indexItem('session-b')]
		state.activeSessionId = 'session-a'

		Object.assign(service, {
			compactionCoordinator: { cancel: () => undefined },
			plugin: { app: { vault: makeVault(adapter) } },
		})
		store.deleteSession = async () => {
			throw new Error('delete failed')
		}

		await expect(service.deleteSession('session-a')).rejects.toThrow(
			'delete failed',
		)
		expect(state.deletedSessionIds.has('session-a')).toBe(false)
		expect(state.sessionIndex.map((item) => item.id)).toEqual([
			'session-a',
			'session-b',
		])
	})
})
