import { describe, expect, it } from 'vitest'
import type { Vault } from 'obsidian'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import { SessionsFileBackend } from './session-files'
import { SessionStore, type SessionLegacyStore } from './session-store'

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

function makeStore(adapter: MemoryAdapter) {
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
	const backend = new SessionsFileBackend(makeVault(adapter))
	const store = new SessionStore(state, selection, backend, legacy, undefined)
	return { store, state }
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
