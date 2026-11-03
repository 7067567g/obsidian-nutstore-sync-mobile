import { describe, expect, it, vi } from 'vitest'
import { createVaultPathContextItem } from '~/ai/chat/context/user-context'
import { UserContextManager } from '~/ai/chat/context/user-context-manager'
import type { ChatSession } from '~/ai/chat/domain'
import { ChatState } from '~/ai/chat/runtime/chat-state'
import { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import ChatService from './chat.service'
import { ChatServiceQueue } from './chat.service.queue'

/* ------------------------------------------------------------------ harness */

function makeSession(id: string): ChatSession {
	return {
		schemaVersion: 2,
		id,
		createdAt: 1,
		updatedAt: 1,
		subagents: { master: {} },
	} as unknown as ChatSession
}

function makeHarness() {
	const state = new ChatState()
	const runtimeStates = new RuntimeStates(state)
	state.loadedSessions.set('session-a', makeSession('session-a'))
	state.loadedSessions.set('session-b', makeSession('session-b'))
	// The user is viewing session-b while a late callback from session-a lands.
	state.activeSessionId = 'session-b'
	const userContextManager = new UserContextManager(
		state,
		runtimeStates,
		() => {},
	)
	const recallMessage = vi.fn(async () => ({
		text: 'recalled',
		userContext: [],
	}))
	const service = Object.assign(Object.create(ChatService.prototype), {
		state,
		runtimeStates,
		userContextManager,
		messageOps: { recallMessage },
	}) as ChatService
	return { service, runtimeStates, recallMessage }
}

/* --------------------------------------------------------- K9 pass-through */

describe('ChatService explicit session target (H7 / K9)', () => {
	it('CT-H7-W8-4: updateInputDraft routes an explicit id to the captured session', () => {
		const { service, runtimeStates } = makeHarness()

		service.updateInputDraft('late draft from A', 'session-a')

		expect(runtimeStates.get('session-a').draft.text).toBe('late draft from A')
		expect(runtimeStates.get('session-b').draft.text).toBe('')
	})

	it('CT-H7-W8-5: user-context writes route an explicit id to the captured session', () => {
		const { service, runtimeStates } = makeHarness()

		service.addUserContext(
			createVaultPathContextItem('note-a.md', 'file'),
			'session-a',
		)
		service.addUserContext(
			createVaultPathContextItem('note-b.md', 'file'),
			'session-a',
		)
		expect(runtimeStates.get('session-a').draft.userContext).toHaveLength(2)
		expect(runtimeStates.get('session-b').draft.userContext).toHaveLength(0)

		service.removeUserContext(0, 'session-a')
		expect(runtimeStates.get('session-a').draft.userContext).toHaveLength(1)
		expect(runtimeStates.get('session-b').draft.userContext).toHaveLength(0)
	})

	it('CT-H7-W8-6: pending-context resolution routes an explicit id after the read window', () => {
		const { service, runtimeStates } = makeHarness()
		const pending = {
			type: 'pending-context' as const,
			placeholderType: 'image',
			id: 'pending-1',
		}
		service.addUserContext(pending, 'session-a')
		expect(runtimeStates.get('session-a').draft.userContext).toHaveLength(1)

		service.resolvePendingContextItem('pending-1', null, 'session-a')
		expect(runtimeStates.get('session-a').draft.userContext).toHaveLength(0)
		expect(runtimeStates.get('session-b').draft.userContext).toHaveLength(0)
	})

	it('CT-H7-W8-7: recallMessage forwards the captured sessionId as an explicit session', async () => {
		const { service, recallMessage } = makeHarness()

		await service.recallMessage('m1', {
			restoreFiles: true,
			sessionId: 'session-a',
		})

		expect(recallMessage).toHaveBeenCalledWith('m1', {
			restoreFiles: true,
			session: 'session-a',
		})
	})

	it('CT-H7-W8-8: no explicit id keeps the legacy active-session behaviour', () => {
		const { service, runtimeStates } = makeHarness()

		service.updateInputDraft('typed in B')

		expect(runtimeStates.get('session-b').draft.text).toBe('typed in B')
		expect(runtimeStates.get('session-a').draft.text).toBe('')
	})
})

/* ------------------------------------------------- send-path late binding */

function makeQueueHarness() {
	const state = new ChatState()
	const runtimeStates = new RuntimeStates(state)
	state.loadedSessions.set('session-a', makeSession('session-a'))
	state.loadedSessions.set('session-b', makeSession('session-b'))
	state.activeSessionId = 'session-a'
	const userContextManager = new UserContextManager(
		state,
		runtimeStates,
		() => {},
	)
	let releaseInit!: () => void
	const initGate = new Promise<void>((resolve) => {
		releaseInit = resolve
	})
	const enqueueUserSubmission = vi.fn(() => 'turn-1')
	const service = Object.assign(Object.create(ChatServiceQueue.prototype), {
		state,
		runtimeStates,
		userContextManager,
		initialize: () => initGate,
		selection: { validateSessionSelection: () => true },
		sessionProcessor: { enqueueUserSubmission },
		notify: () => {},
	}) as ChatServiceQueue
	return { service, state, enqueueUserSubmission, releaseInit }
}

describe('ChatServiceQueue.sendMessage explicit session target (H7 / K9)', () => {
	it('CT-H7-W8-9: keeps the session captured before the initialize await', async () => {
		const { service, state, enqueueUserSubmission, releaseInit } =
			makeQueueHarness()

		const pending = service.sendMessage('hello', [], 'session-a')
		// The user switches sessions while `initialize()` is still pending.
		state.activeSessionId = 'session-b'
		releaseInit()

		expect(await pending).toBe(true)
		expect(enqueueUserSubmission).toHaveBeenCalledWith('session-a', {
			text: 'hello',
			userContext: [],
		})
	})

	it('CT-H7-W8-10: a removed captured session aborts instead of leaking to the active one', async () => {
		const { service, state, enqueueUserSubmission, releaseInit } =
			makeQueueHarness()
		state.deletedSessionIds.add('session-a')

		const pending = service.sendMessage('hello', [], 'session-a')
		releaseInit()

		expect(await pending).toBe(false)
		expect(enqueueUserSubmission).not.toHaveBeenCalled()
	})
})
