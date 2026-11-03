import { createEffect, createSignal, onCleanup } from 'solid-js'
import type { ChatboxProps } from '~/ai/chat/ui/types'

export interface ChatboxClockOptions {
	props: ChatboxProps
	getViewWindow: () => Window
}

/**
 * One-second ticker driving live durations while a run is in flight.
 *
 * Mechanically extracted from `Chatbox.tsx` (P7); no behavior change.
 */
export function useChatboxClock(options: ChatboxClockOptions) {
	const [now, setNow] = createSignal(Date.now())

	createEffect(() => {
		const hasLiveDuration =
			Object.values(options.props.agentsById).some(
				(agent) =>
					agent.status === 'queued' ||
					agent.status === 'running' ||
					agent.status === 'idle',
			) ||
			options.props.timeline.some((item) =>
				item.displayBlocks.some(
					(block) =>
						block.kind === 'tool-call' &&
						!!block.timing &&
						block.timing.finishedAt === undefined,
				),
			)
		if (!hasLiveDuration) return
		const viewWindow = options.getViewWindow()
		setNow(Date.now())
		const interval = viewWindow.setInterval(() => setNow(Date.now()), 1000)
		onCleanup(() => viewWindow.clearInterval(interval))
	})

	return now
}
