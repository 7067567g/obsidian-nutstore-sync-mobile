import { createEffect, createSignal, on, onCleanup } from 'solid-js'
import type { ChatboxProps } from '~/ai/chat/ui/types'

export interface MessageScrollOptions {
	props: ChatboxProps
	messagesEl: () => HTMLDivElement | undefined
	getViewWindow: () => Window
}

/**
 * Sticky-bottom message scrolling for the Chatbox timeline.
 *
 * Mechanically extracted from `Chatbox.tsx` (P7); no behavior change.
 * The scroll/render strategy itself is untouched — see PERF-01 overlap notes
 * in `reports/ws-p7-refactor.md` (no windowing changes here).
 */
export function useMessageScroll(options: MessageScrollOptions) {
	const [stickToBottom, setStickToBottom] = createSignal(true)
	let previousActiveSessionId: string | undefined

	function isMessagesNearBottom(threshold = 48) {
		const messagesEl = options.messagesEl()
		if (!messagesEl) {
			return true
		}
		const remaining =
			messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight
		return remaining <= threshold
	}

	const lastMessageFingerprint = () => {
		const item = options.props.timeline.at(-1)
		if (!item) return 'empty'
		const textLength = item.message.parts
			.filter((part) => part.type === 'text')
			.reduce((total, part) => total + part.text.length, 0)
		const blockFingerprint = item.displayBlocks
			.map((block) => {
				if (block.kind === 'content') return `c:${block.parts.length}`
				if (block.kind === 'reasoning') return `r:${block.part.text.length}`
				if (block.kind === 'tool-call') {
					return `tc:${block.toolCall.toolCallId}:${block.toolCall.state}`
				}
				return `sn:${JSON.stringify(block.notification)}`
			})
			.join('|')
		return `${item.message.id}:${textLength}:${blockFingerprint}:${item.message.role}`
	}

	function scrollMessagesToBottom(behavior: ScrollBehavior = 'smooth') {
		options.getViewWindow().requestAnimationFrame(() => {
			const messagesEl = options.messagesEl()
			if (!messagesEl) {
				return
			}
			messagesEl.scrollTo({
				top: messagesEl.scrollHeight,
				behavior,
			})
			setStickToBottom(true)
		})
	}

	createEffect(
		on(
			() => [
				options.props.activeSessionId,
				options.props.timeline.length,
				options.props.pending.length,
				options.props.runState,
			],
			([activeSessionId]) => {
				const behavior =
					previousActiveSessionId !== activeSessionId ? 'auto' : 'smooth'
				const shouldScroll =
					previousActiveSessionId !== activeSessionId || stickToBottom()
				previousActiveSessionId = activeSessionId?.toString()
				if (shouldScroll) {
					scrollMessagesToBottom(behavior)
				}
			},
		),
	)

	createEffect(
		on(
			() => [options.props.activeSessionId, lastMessageFingerprint()],
			([activeSessionId], previous) => {
				const previousActiveSessionId = previous?.[0]
				if (activeSessionId !== previousActiveSessionId || !stickToBottom()) {
					return
				}
				scrollMessagesToBottom('auto')
			},
		),
	)

	createEffect(() => {
		if (!options.messagesEl()) {
			return
		}
		const onScroll = () => {
			setStickToBottom(isMessagesNearBottom())
		}
		onScroll()
		options
			.messagesEl()!
			.addEventListener('scroll', onScroll, { passive: true })
		onCleanup(() =>
			options.messagesEl()?.removeEventListener('scroll', onScroll),
		)
	})

	return { scrollMessagesToBottom }
}
