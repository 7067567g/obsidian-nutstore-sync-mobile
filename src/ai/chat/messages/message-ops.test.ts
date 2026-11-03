import { describe, expect, it, vi } from 'vitest'
import type { App } from 'obsidian'
import type { ChatSession } from '~/ai/chat/domain'
import type { AppUIMessage } from '~/ai/chat/types'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import { ChatState } from '~/ai/chat/runtime/chat-state'
import { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import type { MessageFactory } from './message-factory'
import type { SessionStore } from '~/ai/chat/session/session-store'
import { MessageOps } from './message-ops'

function makeSession(id: string): ChatSession {
	return {
		schemaVersion: 2,
		id,
		createdAt: 1,
		updatedAt: 1,
		subagents: { master: createEmptyMasterAgent(1) },
	}
}

function makeUserMessage(id: string, text: string): AppUIMessage {
	return {
		id,
		role: 'user',
		metadata: { createdAt: 1 },
		parts: [{ type: 'text', text }],
	}
}

function createHarness() {
	const state = new ChatState()
	const runtimeStates = new RuntimeStates(state)
	const sessionA = makeSession('session-a')
	const sessionB = makeSession('session-b')
	sessionA.subagents.master.timeline.push(
		makeUserMessage('msg-a', 'hello from A'),
	)
	state.loadedSessions.set(sessionA.id, sessionA)
	state.loadedSessions.set(sessionB.id, sessionB)
	// The user switched to B before A's late callback resumed.
	state.activeSessionId = sessionB.id

	const store = {
		persistSession: vi.fn(async () => undefined),
	} as unknown as SessionStore
	const messageFactory = {
		getActiveAgent: (session: ChatSession) => session.subagents.master,
	} as unknown as MessageFactory
	const ops = new MessageOps(
		{} as unknown as App,
		state,
		runtimeStates,
		store,
		() => undefined,
		() => undefined,
		messageFactory,
		() => true,
		() => true,
	)
	return { state, ops, sessionA, sessionB }
}

describe('MessageOps H7 explicit session identity', () => {
	it('recalls on the captured session after the active session switched (CT-H7-M1)', async () => {
		const { ops, sessionA, sessionB } = createHarness()

		const result = await ops.recallMessage('msg-a', { session: sessionA })

		expect(result).toMatchObject({ text: 'hello from A' })
		expect(sessionA.subagents.master.timeline).toHaveLength(0)
		expect(sessionB.subagents.master.timeline).toHaveLength(0)
	})

	it('accepts an explicit session id target (CT-H7-M2)', async () => {
		const { ops, sessionA } = createHarness()

		const result = await ops.recallMessage('msg-a', { session: sessionA.id })

		expect(result).toMatchObject({ text: 'hello from A' })
		expect(sessionA.subagents.master.timeline).toHaveLength(0)
	})

	it('drops the recall when the captured session is replaced while restoring files (CT-H7-M3)', async () => {
		const { state, ops, sessionA } = createHarness()
		// Active session is still A when the recall starts; it is replaced
		// during the restore await (unload/reload window).
		state.activeSessionId = sessionA.id
		const replacement = makeSession(sessionA.id)
		ops.restoreFilesForRecall = async () => {
			state.loadedSessions.set(sessionA.id, replacement)
		}

		const result = await ops.recallMessage('msg-a', {
			restoreFiles: true,
			session: sessionA,
		})

		expect(result).toBeUndefined()
		expect(sessionA.subagents.master.timeline).toHaveLength(1)
	})

	it('rejects a stale same-id session object at entry (CT-H7-M4)', async () => {
		const { state, ops, sessionA } = createHarness()
		state.activeSessionId = sessionA.id
		const stale = makeSession(sessionA.id)

		const result = await ops.recallMessage('msg-a', { session: stale })

		expect(result).toBeUndefined()
		expect(sessionA.subagents.master.timeline).toHaveLength(1)
	})
})
