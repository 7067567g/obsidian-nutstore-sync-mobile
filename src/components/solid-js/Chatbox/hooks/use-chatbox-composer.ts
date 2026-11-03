import { createEffect, createSignal, on } from 'solid-js'
import type { ChatboxProps } from '~/ai/chat/ui/types'

export interface ChatboxComposerOptions {
	props: ChatboxProps
	scrollMessagesToBottom: (behavior?: ScrollBehavior) => void
}

/**
 * Composer input state, draft synchronization and submit handling.
 *
 * Mechanically extracted from `Chatbox.tsx` (P7); no behavior change.
 */
export function useChatboxComposer(options: ChatboxComposerOptions) {
	const [input, setInput] = createSignal('')

	/**
	 * K9: restore draft state on the session captured when the async operation
	 * started. `sessionId` must come from a synchronous capture, never from a
	 * re-read of the active session after an `await`.
	 */
	function restoreInput(text: string, sessionId?: string) {
		if (
			sessionId === undefined ||
			sessionId === options.props.activeSessionId
		) {
			setInput(text)
		}
		options.props.onUpdateInputDraft(text, sessionId)
	}

	async function submit() {
		const text = input().trim()
		const hasPendingContext =
			options.props.draft.userContext.length > 0 ||
			options.props.activeContextItems.length > 0
		if ((!text && !hasPendingContext) || !options.props.canSend) {
			return
		}
		// K9: capture the target session before awaiting the send; a switch that
		// happens while `onSendMessage` is in flight must not redirect the
		// failure fallback into the newly active session.
		const sessionId = options.props.activeSessionId
		const previousInput = input()
		setInput('')
		options.props.onUpdateInputDraft('', sessionId)
		options.scrollMessagesToBottom('auto')
		try {
			const accepted = await options.props.onSendMessage(
				text,
				options.props.activeContextItems,
				sessionId,
			)
			if (!accepted) {
				restoreInput(previousInput, sessionId)
			}
		} catch (error) {
			restoreInput(previousInput, sessionId)
			throw error
		}
	}

	createEffect(
		on(
			() => [options.props.activeSessionId, options.props.draft.text] as const,
			() => {
				setInput(options.props.draft.text)
			},
		),
	)

	return { input, setInput, restoreInput, submit }
}
