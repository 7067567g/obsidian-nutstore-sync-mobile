import { extractErrorMessage } from '~/ai/chat/error-utils'
import { assertMasterPendingInputsEmpty } from '~/ai/chat/messages/ui-message'
import type { SessionRuntimeState } from './chat-state'
import {
	claimNextTurn,
	coalesceQueuedUserSubmissions,
	enqueueAgentInput,
	enqueueRegenerate,
	enqueueUserSubmission,
	hasQueuedTurns,
	removeQueuedUserSubmission,
	type TaskOrigin,
} from './master-turn-scheduler'
import { SessionProcessorTurn } from './session-processor-turn'
import type { AppUIMessage, ChatSubmission } from '~/ai/chat/types'
import i18n from '~/i18n'

export class SessionProcessor extends SessionProcessorTurn {
	enqueueUserSubmission(sessionId: string, submission: ChatSubmission) {
		if (
			this.state.deletedSessionIds.has(sessionId) ||
			!this.state.loadedSessions.has(sessionId)
		)
			return undefined
		const runtime = this.runtimeStates.get(sessionId)
		const turnId = enqueueUserSubmission(runtime, submission)
		this.notify()
		void this.start(sessionId)
		return turnId
	}

	enqueueAgentInput(
		sessionId: string,
		input: AppUIMessage,
		origin: TaskOrigin,
	) {
		if (
			this.state.deletedSessionIds.has(sessionId) ||
			!this.state.loadedSessions.has(sessionId)
		)
			return false
		const runtime = this.runtimeStates.get(sessionId)
		const turnId = enqueueAgentInput(runtime, input, origin)
		if (!turnId) return false
		this.notify()
		void this.start(sessionId)
		return true
	}

	enqueueRegenerate(sessionId: string, targetMessageId: string) {
		if (
			this.state.deletedSessionIds.has(sessionId) ||
			!this.state.loadedSessions.has(sessionId)
		)
			return false
		const runtime = this.runtimeStates.get(sessionId)
		enqueueRegenerate(runtime, targetMessageId)
		this.notify()
		void this.start(sessionId)
		return true
	}

	async start(sessionId: string) {
		if (
			this.state.deletedSessionIds.has(sessionId) ||
			!this.state.loadedSessions.has(sessionId)
		)
			return
		const runtime = this.runtimeStates.get(sessionId)
		if (runtime.processing) return runtime.processing

		const worker = this.drain(sessionId)
		let processing: Promise<void>
		processing = worker.then(
			() => this.shutdownWorker(sessionId, runtime, processing),
			(error) => this.shutdownWorker(sessionId, runtime, processing, { error }),
		)
		runtime.processing = processing
		return processing
	}

	cancelQueuedSubmission(sessionId: string, turnId: string): boolean {
		if (
			this.state.deletedSessionIds.has(sessionId) ||
			!this.state.loadedSessions.has(sessionId)
		) {
			return false
		}
		const removed = removeQueuedUserSubmission(
			this.runtimeStates.get(sessionId),
			turnId,
		)
		if (removed) this.notify()
		return removed
	}

	private shutdownWorker(
		sessionId: string,
		runtime: SessionRuntimeState,
		processing: Promise<void>,
		failure?: { error: unknown },
	) {
		if (runtime.processing !== processing) return
		if (failure) {
			this.reportTransientError(
				extractErrorMessage(failure.error, i18n.t('chatbox.requestFailed')),
			)
		}
		runtime.processing = undefined
		if (
			hasQueuedTurns(runtime) &&
			!this.state.deletedSessionIds.has(sessionId) &&
			this.state.loadedSessions.has(sessionId)
		) {
			void this.start(sessionId)
			return
		}
		runtime.runState = 'idle'
		this.notify()
	}

	private async drain(sessionId: string) {
		const runtime = this.runtimeStates.get(sessionId)
		const initialSession = this.state.loadedSessions.get(sessionId)
		if (!initialSession) return
		while (
			!this.state.deletedSessionIds.has(sessionId) &&
			this.state.loadedSessions.get(sessionId) === initialSession &&
			this.runtimeStates.get(sessionId) === runtime
		) {
			const session = this.state.loadedSessions.get(sessionId)
			if (!session) return
			assertMasterPendingInputsEmpty(
				this.messageFactory.getActiveAgent(session),
			)
			coalesceQueuedUserSubmissions(runtime)
			const active = claimNextTurn(runtime)
			if (!active) return
			await this.runActiveTurn(session, runtime, active)
		}
	}
}
