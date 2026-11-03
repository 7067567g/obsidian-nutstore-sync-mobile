import { createEffect, createSignal } from 'solid-js'
import type { ChatboxProps } from '~/ai/chat/ui/types'

/**
 * Agent selection state for the Chatbox subagent timeline dialog.
 *
 * Mechanically extracted from `Chatbox.tsx` (P7); no behavior change.
 */
export function useAgentSelection(props: ChatboxProps) {
	const [selectedAgentId, setSelectedAgentId] = createSignal<string>()
	const selectedAgent = () => {
		const agentId = selectedAgentId()
		return agentId ? props.agentsById[agentId] : undefined
	}

	createEffect(() => {
		const id = selectedAgentId()
		if (id && !props.agentsById[id]) setSelectedAgentId(undefined)
	})

	return { selectedAgentId, setSelectedAgentId, selectedAgent }
}
