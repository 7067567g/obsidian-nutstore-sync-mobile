import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolAbortError } from '~/ai/chat/tool-outcome'
import {
	ActiveTimeDeadline,
	runWithTimeout,
	type VisibilitySource,
} from './tool-timeout'

function fakeVisibility() {
	let hidden = false
	const listeners = new Set<() => void>()
	const source: VisibilitySource & { setHidden: (value: boolean) => void } = {
		get hidden() {
			return hidden
		},
		addEventListener(_type, listener) {
			listeners.add(listener)
		},
		removeEventListener(_type, listener) {
			listeners.delete(listener)
		},
		setHidden(value) {
			hidden = value
			for (const listener of listeners) listener()
		},
	}
	return source
}

function abortableRun(onStart?: (signal: AbortSignal) => void) {
	return (signal: AbortSignal) =>
		new Promise<never>((_resolve, reject) => {
			onStart?.(signal)
			signal.addEventListener(
				'abort',
				() => {
					const reason = signal.reason
					reject(reason instanceof Error ? reason : new Error(String(reason)))
				},
				{ once: true },
			)
		})
}

afterEach(() => {
	vi.useRealTimers()
})

describe('ActiveTimeDeadline', () => {
	it('excludes hidden wall-clock time from elapsed/remaining', () => {
		let now = 0
		const deadline = new ActiveTimeDeadline(1000, () => now)
		now = 100
		deadline.markHidden()
		now = 1600
		deadline.markVisible()
		now = 1700
		expect(deadline.activeElapsedMs()).toBe(200)
		expect(deadline.remainingMs()).toBe(800)
		expect(deadline.isExpired()).toBe(false)
		now = 2500
		expect(deadline.activeElapsedMs()).toBe(1000)
		expect(deadline.isExpired()).toBe(true)
	})
})

describe('runWithTimeout', () => {
	it('aborts with ToolTimeoutError after active budget expires', async () => {
		vi.useFakeTimers()
		const promise = runWithTimeout(abortableRun(), {
			toolName: 'bash',
			timeoutMs: 5000,
			visibility: fakeVisibility(),
		})
		void promise.catch(() => undefined)
		await vi.advanceTimersByTimeAsync(5000)
		await expect(promise).rejects.toMatchObject({
			code: 'timeout',
			toolName: 'bash',
			timeoutMs: 5000,
		})
	})

	it('does not count hidden time toward the budget and expires after resume', async () => {
		vi.useFakeTimers()
		const visibility = fakeVisibility()
		const promise = runWithTimeout(abortableRun(), {
			toolName: 'bash',
			timeoutMs: 1000,
			visibility,
		})
		promise.catch(() => undefined)
		await vi.advanceTimersByTimeAsync(500)
		visibility.setHidden(true)
		await vi.advanceTimersByTimeAsync(10_000)
		expect(vi.getTimerCount()).toBeGreaterThan(0)
		visibility.setHidden(false)
		await vi.advanceTimersByTimeAsync(500)
		await expect(promise).rejects.toMatchObject({ code: 'timeout' })
	})

	it('aborts with ToolAbortError when the external signal aborts', async () => {
		const controller = new AbortController()
		const promise = runWithTimeout(abortableRun(), {
			toolName: 'bash',
			timeoutMs: 5000,
			abortSignal: controller.signal,
			visibility: fakeVisibility(),
		})
		void promise.catch(() => undefined)
		controller.abort()
		await expect(promise).rejects.toBeInstanceOf(ToolAbortError)
	})

	it('emits active-time heartbeat while the command is running', async () => {
		vi.useFakeTimers()
		const beats: number[] = []
		const promise = runWithTimeout(abortableRun(), {
			toolName: 'bash',
			timeoutMs: 5000,
			visibility: fakeVisibility(),
			heartbeatIntervalMs: 1000,
			onHeartbeat: (elapsed) => beats.push(elapsed),
		})
		void promise.catch(() => undefined)
		await vi.advanceTimersByTimeAsync(2500)
		expect(beats.length).toBeGreaterThanOrEqual(2)
		await vi.advanceTimersByTimeAsync(2500)
		await expect(promise).rejects.toMatchObject({ code: 'timeout' })
	})

	it('runs without a timer when timeoutMs is omitted', async () => {
		vi.useFakeTimers()
		const run = vi.fn(async () => 'ok')
		await expect(
			runWithTimeout(run, {
				toolName: 'vault_read',
				visibility: fakeVisibility(),
			}),
		).resolves.toBe('ok')
		expect(vi.getTimerCount()).toBe(0)
		expect(run).toHaveBeenCalledTimes(1)
	})

	it('rejects immediately when the external signal is already aborted', async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(
			runWithTimeout(async () => 'never', {
				toolName: 'bash',
				timeoutMs: 5000,
				abortSignal: controller.signal,
			}),
		).rejects.toBeInstanceOf(ToolAbortError)
	})
})
