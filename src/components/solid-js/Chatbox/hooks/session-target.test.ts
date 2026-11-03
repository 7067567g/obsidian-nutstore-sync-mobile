import { describe, expect, it, vi } from 'vitest'

// The Obsidian bundle uses the browser build of solid-js, where effects and
// owners run in a real reactive root. Pin it so the hooks behave as shipped.
vi.mock('solid-js', () => vi.importActual('solid-js/dist/solid.js'))

import { createRoot } from 'solid-js'
import type { AppUIMessage } from '~/ai/chat/types'
import type { ChatTimelineMessageItem, ChatboxProps } from '~/ai/chat/ui/types'
import { useChatboxComposer } from './use-chatbox-composer'
import { useMessageActions } from './use-message-actions'

/* ------------------------------------------------------------------ harness */

function chatboxProps(overrides: Partial<ChatboxProps> = {}): ChatboxProps {
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
		activeSessionId: 'session-a',
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

function recallItem(text: string): ChatTimelineMessageItem {
	const message: AppUIMessage = {
		id: 'm1',
		role: 'user',
		parts: [{ type: 'text', text }],
	}
	return {
		id: 'm1',
		createdAt: 1,
		message,
		displayBlocks: [],
		showHeader: true,
	}
}

type RestoreCall = [text: string, sessionId: string | undefined]

/* -------------------------------------------------------- H7 initiator side */

describe('H7 initiator-side session capture (K9)', () => {
	it('CT-H7-W8-1: send-failure fallback writes the session captured at submit', async () => {
		const writes: RestoreCall[] = []
		const sendCalls: Array<[string, string | undefined]> = []
		let releaseSend!: (accepted: boolean) => void
		const props = chatboxProps({
			activeSessionId: 'session-a',
			draft: { text: 'hello', userContext: [] },
			onUpdateInputDraft: (text, sessionId) => writes.push([text, sessionId]),
			onSendMessage: (text, _items, sessionId) => {
				sendCalls.push([text, sessionId])
				return new Promise<boolean>((resolve) => {
					releaseSend = resolve
				})
			},
		})

		await createRoot(async (dispose) => {
			const composer = useChatboxComposer({
				props,
				scrollMessagesToBottom: () => {},
			})
			composer.setInput('hello')
			const pending = composer.submit()
			// The user switches sessions while the send is still in flight.
			props.activeSessionId = 'session-b'
			releaseSend(false)
			await pending
			dispose()
		})

		// The send itself and the fallback draft restore must both target the
		// captured session, not the newly active one.
		expect(sendCalls).toEqual([['hello', 'session-a']])
		expect(writes.at(-1)).toEqual(['hello', 'session-a'])
		expect(writes.some(([, sessionId]) => sessionId === 'session-b')).toBe(
			false,
		)
	})

	it('CT-H7-W8-2: recall fallback restores into the session captured at request time', async () => {
		const restoreCalls: RestoreCall[] = []
		const recallCalls: Array<{ messageId: string; sessionId?: string }> = []
		const props = chatboxProps({
			activeSessionId: 'session-a',
			timeline: [recallItem('hello from a')],
			onRecallMessage: async (messageId, options) => {
				recallCalls.push({ messageId, sessionId: options?.sessionId })
				return undefined
			},
		})

		await createRoot(async (dispose) => {
			const actions = useMessageActions({
				props,
				getViewDocument: () => ({ activeElement: null }) as unknown as Document,
				inputTextareaEl: () => undefined,
				getViewWindow: () =>
					({ requestAnimationFrame: () => 0 }) as unknown as Window,
				restoreInput: (text, sessionId) => restoreCalls.push([text, sessionId]),
			})
			// The dialog opens on session-a, the user switches to session-b
			// before confirming.
			actions.requestRecallMessage('m1')
			props.activeSessionId = 'session-b'
			await actions.confirmRecallMessage()
			dispose()
		})

		expect(recallCalls[0]).toEqual({ messageId: 'm1', sessionId: 'session-a' })
		expect(restoreCalls.at(-1)).toEqual(['hello from a', 'session-a'])
	})

	it('CT-H7-W8-3: successful recall still restores on the captured session', async () => {
		const restoreCalls: RestoreCall[] = []
		const props = chatboxProps({
			activeSessionId: 'session-a',
			timeline: [recallItem('hello from a')],
			onRecallMessage: async () => ({ text: 'recalled text', userContext: [] }),
		})

		await createRoot(async (dispose) => {
			const actions = useMessageActions({
				props,
				getViewDocument: () => ({ activeElement: null }) as unknown as Document,
				inputTextareaEl: () => undefined,
				getViewWindow: () =>
					({ requestAnimationFrame: () => 0 }) as unknown as Window,
				restoreInput: (text, sessionId) => restoreCalls.push([text, sessionId]),
			})
			actions.requestRecallMessage('m1')
			props.activeSessionId = 'session-b'
			await actions.confirmRecallMessage()
			dispose()
		})

		expect(restoreCalls.at(-1)).toEqual(['recalled text', 'session-a'])
	})
})
