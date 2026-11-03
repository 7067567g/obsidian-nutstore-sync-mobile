import type { ChatSession } from '~/ai/chat/domain'

import type { ChatRunState, ChatSubmission } from '~/ai/chat/types'
import type { ChatSessionIndexItem } from '~/ai/chat/domain'
import type { ViewImageAttachmentRegistry } from '~/ai/tools/view-image-attachments'
import type { MasterTurnScheduler } from './master-turn-scheduler'

export interface SessionRuntimeState {
	runState: ChatRunState
	processing?: Promise<void>
	manualCompressionAbortController?: AbortController
	viewImageAttachments?: ViewImageAttachmentRegistry
	draft: ChatSubmission
	scheduler: MasterTurnScheduler
}

export class ChatState {
	readonly loadedSessions = new Map<string, ChatSession>()
	readonly autoApproveRequestsBySessionId = new Map<string, Set<string>>()
	sessionIndex: ChatSessionIndexItem[] = []
	readonly deletedSessionIds = new Set<string>()
	pendingProviderId?: string
	pendingModelId?: string
	activeSessionId?: string
	/**
	 * Monotonic switch/assignment counter (H3). `switchSession` captures it
	 * before its first `await` and re-checks it afterwards so a slow, stale
	 * load can never overwrite `activeSessionId` (or its persisted meta) that a
	 * newer user action already committed.
	 */
	switchGeneration = 0
	readonly runtimeBySessionId = new Map<string, SessionRuntimeState>()
	chatModalHostEl?: HTMLElement
	initialization?: Promise<void>
	initialized = false
}
