import { ToolAbortError, ToolTimeoutError } from '~/ai/chat/tool-outcome'

/**
 * Wall-clock active-time deadline that excludes page-hidden periods.
 *
 * Android WebView freezes timers (and often the whole page) once hidden. A
 * `setTimeout` budget alone would either never fire in background or count the
 * frozen interval as execution time. This deadline tracks only visible/active
 * wall time; the runtime helper below re-schedules after visibility resumes.
 */
export class ActiveTimeDeadline {
	private readonly startedAt: number
	private hiddenAccumulatedMs = 0
	private hiddenAt?: number

	constructor(
		readonly timeoutMs: number,
		private readonly now: () => number = Date.now,
	) {
		this.startedAt = this.now()
	}

	markHidden() {
		if (this.hiddenAt === undefined) this.hiddenAt = this.now()
	}

	markVisible() {
		if (this.hiddenAt === undefined) return
		this.hiddenAccumulatedMs += this.now() - this.hiddenAt
		this.hiddenAt = undefined
	}

	activeElapsedMs() {
		const hidden =
			this.hiddenAt === undefined
				? this.hiddenAccumulatedMs
				: this.hiddenAccumulatedMs + this.now() - this.hiddenAt
		return Math.max(0, this.now() - this.startedAt - hidden)
	}

	remainingMs() {
		return Math.max(0, this.timeoutMs - this.activeElapsedMs())
	}

	isExpired() {
		return this.activeElapsedMs() >= this.timeoutMs
	}
}

/** Minimal visibility surface so tests can inject a fake document. */
export interface VisibilitySource {
	readonly hidden: boolean
	addEventListener(type: 'visibilitychange', listener: () => void): void
	removeEventListener(type: 'visibilitychange', listener: () => void): void
}

function defaultVisibility(): VisibilitySource | undefined {
	return typeof document === 'undefined' ? undefined : document
}

export interface RunWithTimeoutOptions {
	toolName: string
	/** Undefined/0 disables the timeout and adds zero timers/listeners. */
	timeoutMs?: number
	/** Turn/user abort signal; aborts the run with a structured ToolAbortError. */
	abortSignal?: AbortSignal
	/** Optional active-time heartbeat while the command is running. */
	heartbeatIntervalMs?: number
	onHeartbeat?: (elapsedActiveMs: number) => void
	visibility?: VisibilitySource
	now?: () => number
}

/**
 * Run a cooperative operation with an optional active-time timeout.
 *
 * The operation receives a combined signal (timeout + external abort); just-bash
 * and other cooperative executors stop at their next statement/checkpoint. When
 * `timeoutMs` is omitted the wrapped function is called with the external signal
 * (or a fresh never-aborting signal) and no timer/listener is installed.
 */
export async function runWithTimeout<T>(
	run: (signal: AbortSignal) => Promise<T>,
	options: RunWithTimeoutOptions,
): Promise<T> {
	const external = options.abortSignal
	if (!options.timeoutMs || options.timeoutMs <= 0) {
		if (external?.aborted) {
			throw new ToolAbortError(options.toolName)
		}
		return await run(external ?? new AbortController().signal)
	}

	const controller = new AbortController()
	const deadline = new ActiveTimeDeadline(options.timeoutMs, options.now)
	const toolName = options.toolName
	const timeoutError = () => new ToolTimeoutError(toolName, options.timeoutMs!)
	let timer: number | undefined
	let heartbeatTimer: number | undefined
	let disposed = false

	const abort = (reason: unknown) => {
		if (!controller.signal.aborted) controller.abort(reason)
	}
	const abortExternal = () => abort(new ToolAbortError(toolName))
	const schedule = () => {
		if (disposed || controller.signal.aborted) return
		const remaining = deadline.remainingMs()
		if (remaining <= 0) {
			abort(timeoutError())
			return
		}
		window.clearTimeout(timer)
		timer = window.setTimeout(
			() => {
				if (deadline.isExpired()) abort(timeoutError())
				else schedule()
			},
			Math.max(1, remaining),
		)
	}

	const scheduleHeartbeat = () => {
		if (disposed || !options.heartbeatIntervalMs || !options.onHeartbeat) {
			return
		}
		window.clearTimeout(heartbeatTimer)
		heartbeatTimer = window.setTimeout(
			() => {
				if (disposed) return
				options.onHeartbeat?.(deadline.activeElapsedMs())
				scheduleHeartbeat()
			},
			Math.max(1, options.heartbeatIntervalMs),
		)
	}
	const visibility = options.visibility ?? defaultVisibility()
	const onVisibilityChange = () => {
		if (visibility?.hidden) {
			deadline.markHidden()
			return
		}
		deadline.markVisible()
		schedule()
		scheduleHeartbeat()
	}
	if (visibility) {
		if (visibility.hidden) deadline.markHidden()
		visibility.addEventListener('visibilitychange', onVisibilityChange)
	}
	if (external) {
		if (external.aborted) abortExternal()
		else external.addEventListener('abort', abortExternal, { once: true })
	}
	schedule()
	scheduleHeartbeat()
	if (controller.signal.aborted) throw controller.signal.reason
	const abortPromise = new Promise<never>((_resolve, reject) => {
		controller.signal.addEventListener(
			'abort',
			() => {
				const reason = controller.signal.reason
				reject(reason instanceof Error ? reason : new Error(String(reason)))
			},
			{ once: true },
		)
	})

	try {
		return await Promise.race([run(controller.signal), abortPromise])
	} catch (error) {
		if (controller.signal.aborted) {
			const reason = controller.signal.reason
			if (reason instanceof ToolTimeoutError) throw reason
			if (reason instanceof ToolAbortError) throw reason
		}
		throw error
	} finally {
		disposed = true
		window.clearTimeout(timer)
		visibility?.removeEventListener('visibilitychange', onVisibilityChange)
		external?.removeEventListener('abort', abortExternal)
	}
}
