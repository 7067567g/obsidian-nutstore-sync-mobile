import { describe, expect, it } from 'vitest'
import { SessionsFileBackend } from './session-files'
import {
	MemoryAdapter,
	makeSession,
	makeVault,
	timelineOf,
} from './session-log-backend.fixtures'

describe('JSONL session log backend resilience', () => {
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
