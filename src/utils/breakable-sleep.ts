import { Observable, type Subscription } from 'rxjs'

export default function <T>(ob: Observable<T>, ms: number) {
	return new Promise<void>((resolve, reject) => {
		// Declared up front: the source observable may emit (or error)
		// synchronously during `subscribe`, before `timer`/`sub` would have been
		// assigned below. Referencing them via TDZ would throw instead of
		// settling the promise.
		let timer: number | undefined
		let sub: Subscription | undefined
		let settled = false

		function finish() {
			if (settled) return
			settled = true
			if (timer !== undefined) window.clearTimeout(timer)
			sub?.unsubscribe()
			resolve()
		}

		function fail(err: unknown) {
			if (settled) return
			settled = true
			if (timer !== undefined) window.clearTimeout(timer)
			sub?.unsubscribe()
			reject(err instanceof Error ? err : new Error(String(err)))
		}

		sub = ob.subscribe({
			next: () => finish(),
			error: (err) => fail(err),
		})

		if (!settled) {
			timer = window.setTimeout(() => {
				finish()
			}, ms)
		}
	})
}
