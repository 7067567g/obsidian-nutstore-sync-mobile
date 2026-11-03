import { describe, expect, it } from 'vitest'
import type { ChatSession } from '~/ai/chat/domain'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import { ChatState } from '~/ai/chat/runtime/chat-state'
import { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import { UserContextManager } from './user-context-manager'
import type { UserContextItem } from './user-context'

function createManager() {
	const state = new ChatState()
	const runtimeStates = new RuntimeStates(state)
	return new UserContextManager(state, runtimeStates, () => undefined)
}

function makeSession(id: string): ChatSession {
	return {
		schemaVersion: 2,
		id,
		createdAt: 1,
		updatedAt: 1,
		subagents: { master: createEmptyMasterAgent(1) },
	}
}

function createSessionHarness() {
	const state = new ChatState()
	const runtimeStates = new RuntimeStates(state)
	const manager = new UserContextManager(state, runtimeStates, () => undefined)
	const sessionA = makeSession('session-a')
	const sessionB = makeSession('session-b')
	state.loadedSessions.set(sessionA.id, sessionA)
	state.loadedSessions.set(sessionB.id, sessionB)
	state.activeSessionId = sessionB.id
	return { state, runtimeStates, manager, sessionA, sessionB }
}

describe('UserContextManager', () => {
	it('builds binary image file parts from user context without data URLs', async () => {
		const manager = createManager()
		const image = new Blob([new Uint8Array([1, 2, 3, 4])], {
			type: 'image/png',
		})

		const parts = await manager.buildMessagePartsFromUserContext([
			{
				type: 'image',
				hash: 'img-1',
				blob: image,
				mimeType: 'image/png',
				name: 'demo.png',
				size: image.size,
			},
		])

		expect(parts).toHaveLength(1)
		const imagePart = parts[0]
		expect(imagePart).toMatchObject({
			type: 'file',
			mediaType: 'image/png',
			filename: 'demo.png',
		})
		expect(imagePart?.type).toBe('file')
		if (!imagePart || imagePart.type !== 'file') {
			throw new Error('Expected an image file part')
		}
		expect(imagePart.data).toBeInstanceOf(Uint8Array)
		expect(imagePart.data).not.toBeTypeOf('string')
		expect(Array.from(imagePart.data as Uint8Array)).toEqual([1, 2, 3, 4])
	})

	it('keeps context metadata in user context message parts', async () => {
		const manager = createManager()
		const file = new Blob(['hello world'], { type: 'text/plain' })

		const parts = await manager.buildMessagePartsFromUserContext([
			{
				type: 'vault-path',
				hash: 'path-1',
				kind: 'file',
				path: 'notes/demo.md',
			},
			{
				type: 'file',
				hash: 'file-1',
				blob: file,
				mimeType: 'text/plain',
				filename: 'demo.txt',
				size: file.size,
			},
		])

		expect(parts).toHaveLength(2)
		expect(parts[0]).toMatchObject({ type: 'text' })
		expect((parts[0] as { text: string }).text).toContain('notes/demo.md')
		expect(parts[1]).toMatchObject({ type: 'text' })
		expect((parts[1] as { text: string }).text).toContain(
			'"filename": "demo.txt"',
		)
	})
})

describe('UserContextManager H7 explicit session identity', () => {
	it('routes a late draft write to the captured ChatSession (CT-H7-1)', () => {
		const { runtimeStates, manager, sessionA, sessionB } =
			createSessionHarness()

		// active session is B, but the callback belongs to A
		manager.updateInputDraft('late-callback-from-a', sessionA)

		expect(runtimeStates.get(sessionA.id).draft.text).toBe(
			'late-callback-from-a',
		)
		expect(runtimeStates.get(sessionB.id).draft.text).toBe('')
	})

	it('accepts an explicit session id target (CT-H7-2)', () => {
		const { runtimeStates, manager, sessionA, sessionB } =
			createSessionHarness()

		manager.updateInputDraft('late-by-id', sessionA.id)

		expect(runtimeStates.get(sessionA.id).draft.text).toBe('late-by-id')
		expect(runtimeStates.get(sessionB.id).draft.text).toBe('')
	})

	it('rejects a same-id replaced session object (CT-H7-3)', () => {
		const { state, runtimeStates, manager, sessionA } = createSessionHarness()
		const replacement = makeSession(sessionA.id)
		state.loadedSessions.set(sessionA.id, replacement)
		state.activeSessionId = sessionA.id

		manager.updateInputDraft('stale', sessionA)

		expect(runtimeStates.get(sessionA.id).draft.text).toBe('')
	})

	it('rejects a deleted session target (CT-H7-4)', () => {
		const { state, runtimeStates, manager, sessionA } = createSessionHarness()
		state.activeSessionId = sessionA.id
		state.deletedSessionIds.add(sessionA.id)

		manager.updateInputDraft('stale-deleted', sessionA)

		expect(runtimeStates.get(sessionA.id).draft.text).toBe('')
	})

	it('routes pending context resolution to the captured session (CT-H7-5)', () => {
		const { runtimeStates, manager, sessionA, sessionB } =
			createSessionHarness()
		const pending: UserContextItem = {
			type: 'pending-context',
			placeholderType: 'file',
			id: 'pending-1',
		}
		const resolved: UserContextItem = {
			type: 'file',
			hash: 'file-1',
			blob: new Blob(['demo']),
			mimeType: 'text/plain',
			filename: 'demo.txt',
			size: 4,
		}

		manager.addUserContext(pending, sessionA)
		manager.resolvePendingContextItem('pending-1', resolved, sessionA)

		const items = runtimeStates.get(sessionA.id).draft.userContext
		expect(items).toHaveLength(1)
		expect(items[0]?.type).toBe('file')
		expect(runtimeStates.get(sessionB.id).draft.userContext).toHaveLength(0)
	})

	it('keeps the legacy active-session fallback when no target is given (CT-H7-6)', () => {
		const { runtimeStates, manager, sessionA, sessionB } =
			createSessionHarness()

		manager.updateInputDraft('legacy-active-b')

		expect(runtimeStates.get(sessionA.id).draft.text).toBe('')
		expect(runtimeStates.get(sessionB.id).draft.text).toBe('legacy-active-b')
	})
})
