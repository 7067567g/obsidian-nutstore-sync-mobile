import type { ChatboxProps } from '~/ai/chat/ui/types'
import {
	getUserContextItemHash,
	type UserContextItem,
} from '~/ai/chat/context/user-context'

/**
 * Reconcile matches list entries by `id`. User context items only carry
 * `hash` (or `id` for pending placeholders), so every view item is given a
 * stable `id` derived from its canonical hash.
 */
type ReconcileKeyedUserContextItem = UserContextItem & { id: string }

function withReconcileId(item: UserContextItem): ReconcileKeyedUserContextItem {
	return {
		...item,
		id: getUserContextItemHash(item),
	}
}

/**
 * Detach the chatbox view model from the canonical caches before it enters the
 * mount store (H6). `buildTimeline` / `buildAgentViews` hand out cached arrays
 * by reference; letting `reconcile` walk those in place mutates the previous
 * session's cached timeline. The timeline and subagent-timeline arrays are
 * copied, and the context arrays are copied item by item with a stable
 * reconcile key so no canonical object is ever merged into.
 */
export function prepareChatboxProps(props: ChatboxProps): ChatboxProps {
	return {
		...props,
		timeline: props.timeline.slice(),
		agentsById: Object.fromEntries(
			Object.entries(props.agentsById).map(([agentId, view]) => [
				agentId,
				{ ...view, timeline: view.timeline.slice() },
			]),
		),
		draft: {
			...props.draft,
			userContext: props.draft.userContext.map(withReconcileId),
		},
		pending: props.pending.map((submission) => ({
			...submission,
			userContext: submission.userContext.map(withReconcileId),
		})),
	}
}
