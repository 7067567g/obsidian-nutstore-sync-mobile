import type { ChatSession } from '~/ai/chat/domain'

/**
 * Bounded write-behind queue for whole-session snapshots.
 *
 * Borrowed from the DeepSeek Harness JSONL persistence design: many agent
 * steps can request a persist in a short burst, but only the latest state needs
 * to reach disk. The first request starts a fixed window (not a debounce), so a
 * continuous stream cannot postpone the first write forever. All requests
 * accepted in the window share one write and resolve together.
 */
export const SESSION_WRITE_BATCH_MAX_DELAY_MS = 150

export interface SessionWriteTask {
	session: ChatSession
	title: string | undefined
	isCurrent: () => boolean
}

interface PendingWrite {
	task: SessionWriteTask
	promise: Promise<void>
	resolve: () => void
	reject: (error: unknown) => void
}

export class SessionWriteQueue {
	private pending: PendingWrite | undefined
	private timer: number | undefined
	/** Tail of the serialized write chain; may reject so flush barriers can observe it. */
	private tail: Promise<void> = Promise.resolve()
	private disposed = false

	constructor(
		private readonly write: (task: SessionWriteTask) => Promise<void>,
		private readonly batchDelayMs = SESSION_WRITE_BATCH_MAX_DELAY_MS,
	) {}

	/** Coalesce one session state into the current window (or open a new one). */
	schedule(task: SessionWriteTask): Promise<void> {
		if (this.disposed) {
			return Promise.reject(new Error('SessionWriteQueue is disposed'))
		}
		if (this.pending) {
			this.pending.task = task
			return this.pending.promise
		}
		let resolve!: () => void
		let reject!: (error: unknown) => void
		const promise = new Promise<void>((res, rej) => {
			resolve = res
			reject = rej
		})
		this.pending = { task, promise, resolve, reject }
		this.timer = window.setTimeout(() => {
			void this.flush()
		}, this.batchDelayMs)
		return promise
	}

	/** Force the pending window to write now and wait for the serialized chain. */
	flush(): Promise<void> {
		if (!this.pending) return this.tail
		const pending = this.pending
		this.pending = undefined
		this.clearTimer()
		const run = this.tail
			.catch(() => undefined)
			.then(async () => {
				if (!pending.task.isCurrent()) {
					pending.resolve()
					return
				}
				try {
					await this.write(pending.task)
					pending.resolve()
				} catch (error) {
					pending.reject(error)
					throw error
				}
			})
		this.tail = run
		return run
	}

	/** Resolve pending waiters without writing and wait for any in-flight write. */
	async dispose(): Promise<void> {
		this.disposed = true
		this.clearTimer()
		const pending = this.pending
		this.pending = undefined
		pending?.resolve()
		await this.tail.catch(() => undefined)
	}

	private clearTimer() {
		if (!this.timer) return
		window.clearTimeout(this.timer)
		this.timer = undefined
	}
}
