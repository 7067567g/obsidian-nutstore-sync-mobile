import { createEffect, createMemo, createSignal, on } from 'solid-js'
import {
	ConversationNodeAssembler,
	TimelineWindowController,
} from '~/ai/chat/ui/message-window'
import type { ChatboxProps } from '~/ai/chat/ui/types'

export interface TimelineWindowHookOptions {
	props: ChatboxProps
	/** Settings switch + message-count threshold. */
	enabled: () => boolean
}

/**
 * Bridges the pure window model into Solid. Paging state lives in the
 * controller (not in a memo) so new messages do not reset the pages the user
 * explicitly loaded; a session switch or toggling the setting does.
 */
export function useTimelineWindow(options: TimelineWindowHookOptions) {
	const assembler = new ConversationNodeAssembler()
	const controller = new TimelineWindowController()
	let lastSessionId = options.props.activeSessionId
	let lastEnabled = options.enabled()

	const initialNodes = assembler.assemble(options.props.timeline)
	const [window, setWindow] = createSignal(controller.update(initialNodes))

	createEffect(
		on(
			() =>
				[
					options.props.activeSessionId,
					options.props.timeline,
					options.enabled(),
				] as const,
			([sessionId, timeline, enabled]) => {
				if (sessionId !== lastSessionId || enabled !== lastEnabled) {
					controller.reset()
					lastSessionId = sessionId
					lastEnabled = enabled
				}
				setWindow(controller.update(assembler.assemble(timeline)))
			},
		),
	)

	const visibleItems = createMemo(() => {
		if (!options.enabled()) return options.props.timeline
		const current = window()
		return options.props.timeline.slice(current.startItem, current.endItem)
	})

	function loadEarlier() {
		setWindow(controller.loadEarlier())
	}

	return { window, visibleItems, loadEarlier }
}
