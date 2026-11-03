import { describe, expect, it, vi } from 'vitest'

// The Obsidian bundle uses the browser build of solid-js/store, whose
// `reconcile` merges arrays in place. Node resolves the server build, which
// replaces references instead, so pin the browser build for this regression.
vi.mock('solid-js', () => vi.importActual('solid-js/dist/solid.js'))
vi.mock('solid-js/store', () => vi.importActual('solid-js/store/dist/store.js'))

import { createStore, reconcile } from 'solid-js/store'
import type { ChatSession } from '~/ai/chat/domain'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import type { UserContextItem } from '~/ai/chat/context/user-context'
import { buildAgentViews, buildTimeline } from '~/ai/chat/ui/view-projection'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import { prepareChatboxProps } from './mount-props'

function sessionOf(id: string, master: ChatAgentState): ChatSession {
	return {
		schemaVersion: 2,
		id,
		createdAt: 1,
		updatedAt: 1,
		subagents: { master },
	}
}

function textMessage(id: string, text: string): AppUIMessage {
	return { id, role: 'assistant', parts: [{ type: 'text', text }] }
}

function chatboxProps(overrides: Partial<ChatboxProps>): ChatboxProps {
	return {
		loading: false,
		title: '',
		activeContextItems: [],
		sessionHistory: [],
		timeline: [],
		agentsById: {},
		otherBusySessionIds: [],
		providers: [],
		runState: 'idle',
		draft: { text: '', userContext: [] },
		pending: [],
		canSend: true,
		canCompress: false,
		mcpServers: [],
		onNewSession: () => {},
		onCompressContext: async () => {},
		onSwitchSession: () => {},
		onExportSession: async () => {},
		onDeleteSession: async () => {},
		onSelectProvider: () => {},
		onSelectModel: () => {},
		onSendMessage: async () => true,
		onUpdateInputDraft: () => {},
		onAddUserContext: () => {},
		onRemoveUserContext: () => {},
		onResolvePendingContextItem: () => {},
		onDropContextItem: () => {},
		...overrides,
	}
}

describe('prepareChatboxProps (H6 mount boundary)', () => {
	it('CT-H6-1: browser reconcile does not mutate the cached session timeline', () => {
		const masterA = createEmptyMasterAgent(1)
		masterA.timeline.push(textMessage('A-msg-0', 'alpha'))
		masterA.timeline.push(textMessage('A-msg-1', 'beta'))
		const sessionA = sessionOf('session-A', masterA)

		const masterB = createEmptyMasterAgent(2)
		masterB.timeline.push(textMessage('B-msg-0', 'bravo'))
		const sessionB = sessionOf('session-B', masterB)

		const canonicalA = buildTimeline(sessionA)
		expect(canonicalA).toHaveLength(2)
		expect(canonicalA[0]?.id).toBe('A-msg-0')

		const [, set] = createStore(
			prepareChatboxProps(chatboxProps({ timeline: canonicalA, title: 'A' })),
		)
		set(
			reconcile(
				prepareChatboxProps(
					chatboxProps({ timeline: buildTimeline(sessionB), title: 'B' }),
				),
			),
		)

		expect(canonicalA).toHaveLength(2)
		expect(canonicalA.map((item) => item.message.id)).toEqual([
			'A-msg-0',
			'A-msg-1',
		])
		expect(buildTimeline(sessionA)).toBe(canonicalA)
	})

	it('CT-H6-2: browser reconcile keeps the canonical draft.userContext item intact', () => {
		const itemA: UserContextItem = {
			hash: 'hash-a',
			type: 'vault-path',
			kind: 'file',
			path: 'a.md',
		}
		const itemB: UserContextItem = {
			hash: 'hash-b',
			type: 'vault-path',
			kind: 'file',
			path: 'b.md',
		}

		const [, set] = createStore(
			prepareChatboxProps(
				chatboxProps({ draft: { text: '', userContext: [itemA] } }),
			),
		)
		set(
			reconcile(
				prepareChatboxProps(
					chatboxProps({ draft: { text: '', userContext: [itemB] } }),
				),
			),
		)

		expect(itemA).toMatchObject({ hash: 'hash-a', path: 'a.md' })
	})

	it('CT-H6-3: browser reconcile keeps a canonical subagent timeline intact', () => {
		const childA = createEmptyMasterAgent(1)
		childA.id = 'explorer-one'
		childA.type = 'explorer'
		childA.timeline.push(textMessage('child-A-msg', 'alpha'))
		const masterA = createEmptyMasterAgent(1)
		masterA.subagents[childA.id] = childA

		const childB = createEmptyMasterAgent(2)
		childB.id = 'explorer-one'
		childB.type = 'explorer'
		childB.timeline.push(textMessage('child-B-msg', 'bravo'))
		const masterB = createEmptyMasterAgent(2)
		masterB.subagents[childB.id] = childB

		const viewsA = buildAgentViews(sessionOf('session-A', masterA))
		expect(viewsA['explorer-one']?.timeline[0]?.message.id).toBe('child-A-msg')

		const [, set] = createStore(
			prepareChatboxProps(chatboxProps({ agentsById: viewsA })),
		)
		set(
			reconcile(
				prepareChatboxProps(
					chatboxProps({
						agentsById: buildAgentViews(sessionOf('session-B', masterB)),
					}),
				),
			),
		)

		expect(viewsA['explorer-one']?.timeline[0]?.message.id).toBe('child-A-msg')
	})
})
