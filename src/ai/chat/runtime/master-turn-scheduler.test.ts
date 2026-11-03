import { describe, expect, it } from 'vitest'
import type { SessionRuntimeState } from './chat-state'
import {
	cancelActiveTurn,
	claimNextTurn,
	coalesceQueuedUserSubmissions,
	completeActiveTurn,
	createMasterTurnScheduler,
	enqueueAgentInput,
	enqueueUserSubmission,
	getQueuedUserSubmissions,
	isTurnAlive,
	removeQueuedUserSubmission,
	ownsActiveTurn,
} from './master-turn-scheduler'

function runtime(): SessionRuntimeState {
	return {
		runState: 'idle',
		draft: { text: '', userContext: [] },
		scheduler: createMasterTurnScheduler(),
	}
}

describe('master turn scheduler', () => {
	it('claims queued submissions in FIFO order and only once', () => {
		const state = runtime()
		enqueueUserSubmission(state, {
			text: 'Hello 你好 🌿 one',
			userContext: [],
		})
		enqueueUserSubmission(state, {
			text: 'Hello 你好 🌿 two',
			userContext: [],
		})

		const first = claimNextTurn(state)
		expect(first?.turn).toMatchObject({
			kind: 'user-submission',
			submission: { text: 'Hello 你好 🌿 one' },
		})
		expect(state.scheduler.queued).toHaveLength(1)
		expect(claimNextTurn(state)).toBeUndefined()

		completeActiveTurn(state, first!.turn.turnId, first!.abortController.signal)
		const second = claimNextTurn(state)
		expect(second?.turn).toMatchObject({
			kind: 'user-submission',
			submission: { text: 'Hello 你好 🌿 two' },
		})
	})

	it('exposes queued submission ids and removes single items', () => {
		const state = runtime()
		const firstId = enqueueUserSubmission(state, {
			text: 'one',
			userContext: [],
		})
		const secondId = enqueueUserSubmission(state, {
			text: 'two',
			userContext: [],
		})

		expect(getQueuedUserSubmissions(state)).toEqual([
			{ id: firstId, text: 'one', userContext: [] },
			{ id: secondId, text: 'two', userContext: [] },
		])
		expect(removeQueuedUserSubmission(state, firstId)).toBe(true)
		expect(removeQueuedUserSubmission(state, firstId)).toBe(false)
		expect(getQueuedUserSubmissions(state)).toEqual([
			{ id: secondId, text: 'two', userContext: [] },
		])
	})

	it('coalesces consecutive submissions at barriers and preserves context FIFO', () => {
		const state = runtime()
		const firstId = enqueueUserSubmission(state, {
			text: 'A',
			userContext: [{ type: 'vault-path', path: 'a.md' } as never],
		})
		enqueueUserSubmission(state, {
			text: 'B',
			userContext: [{ type: 'vault-path', path: 'b.md' } as never],
		})
		enqueueAgentInput(
			state,
			{
				id: 'input',
				role: 'user',
				metadata: { createdAt: 1 },
				parts: [{ type: 'text', text: 'task' }],
			},
			{ turnId: 'T1', signal: new AbortController().signal },
		)
		enqueueUserSubmission(state, { text: 'C', userContext: [] })

		coalesceQueuedUserSubmissions(state)
		const queued = state.scheduler.queued
		expect(queued).toHaveLength(3)
		expect(queued[0]).toMatchObject({
			kind: 'user-submission',
			turnId: firstId,
			submission: { text: 'A\n\nB' },
		})
		expect(
			(
				queued[0] as {
					submission: { userContext: Array<{ path?: string }> }
				}
			).submission.userContext.map((item) => item.path),
		).toEqual(['a.md', 'b.md'])
		expect(queued[1]?.kind).toBe('agent-input')
		expect(queued[2]).toMatchObject({
			kind: 'user-submission',
			submission: { text: 'C' },
		})
	})

	it('keeps ownership valid after abort until the active slot is cancelled', () => {
		const state = runtime()
		enqueueUserSubmission(state, {
			text: '中性内容 Hello 你好 🌿',
			userContext: [],
		})
		const active = claimNextTurn(state)!
		const signal = active.abortController.signal

		active.abortController.abort()
		expect(ownsActiveTurn(state, active.turn.turnId, signal)).toBe(true)
		expect(
			isTurnAlive(state, 'session', active.turn.turnId, signal, () => false),
		).toBe(false)
		expect(cancelActiveTurn(state, active.turn.turnId, signal)).toBe(true)
		expect(state.scheduler.active).toBeUndefined()
	})

	it('drops an agent input whose origin was aborted before claim', () => {
		const state = runtime()
		const originController = new AbortController()
		enqueueAgentInput(
			state,
			{
				id: 'input',
				role: 'user',
				metadata: { createdAt: 1 },
				parts: [{ type: 'text', text: 'Hello 你好 🌿' }],
			},
			{ turnId: 'T1', signal: originController.signal },
		)
		originController.abort()

		expect(claimNextTurn(state)).toBeUndefined()
		expect(state.scheduler.queued).toEqual([])
	})
})
