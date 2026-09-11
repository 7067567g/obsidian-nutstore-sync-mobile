/**
 * Lightweight, mobile-safe performance sampling for chat persistence and
 * rendering. Records only bounded numeric samples; never stores session
 * payloads or user content.
 */
const MAX_SAMPLES = 200

export interface PerfSummary {
	count: number
	totalMs: number
	maxMs: number
	averageMs: number
	p95Ms: number
}

export interface PerfMetricsSnapshot {
	generatedAt: string
	persistence: PerfSummary
	persistenceEncode: PerfSummary
	persistenceWrite: PerfSummary
	render: PerfSummary
	bridge: {
		calls: number
		byName: Record<string, number>
	}
	session: {
		samples: number
		lastBytes: number
		maxBytes: number
		lastMessages: number
	}
}

function summarize(samples: readonly number[]): PerfSummary {
	if (samples.length === 0) {
		return { count: 0, totalMs: 0, maxMs: 0, averageMs: 0, p95Ms: 0 }
	}
	const totalMs = samples.reduce((sum, value) => sum + value, 0)
	const sorted = [...samples].sort((a, b) => a - b)
	const p95Index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(sorted.length * 0.95) - 1),
	)
	return {
		count: samples.length,
		totalMs: Math.round(totalMs * 1000) / 1000,
		maxMs: Math.round(Math.max(...samples) * 1000) / 1000,
		averageMs: Math.round((totalMs / samples.length) * 1000) / 1000,
		p95Ms: Math.round(sorted[p95Index] * 1000) / 1000,
	}
}

class PerfMetrics {
	private readonly persistenceSamples: number[] = []
	private readonly persistenceEncodeSamples: number[] = []
	private readonly persistenceWriteSamples: number[] = []
	private readonly renderSamples: number[] = []
	private readonly bridgeCounts = new Map<string, number>()
	private bridgeCalls = 0
	private sessionSamples = 0
	private lastSessionBytes = 0
	private maxSessionBytes = 0
	private lastSessionMessages = 0

	private record(samples: number[], durationMs: number) {
		if (!Number.isFinite(durationMs) || durationMs < 0) return
		samples.push(durationMs)
		if (samples.length > MAX_SAMPLES) samples.shift()
	}

	recordPersistence(durationMs: number) {
		this.record(this.persistenceSamples, durationMs)
	}

	recordPersistenceEncode(durationMs: number) {
		this.record(this.persistenceEncodeSamples, durationMs)
	}

	recordPersistenceWrite(durationMs: number) {
		this.record(this.persistenceWriteSamples, durationMs)
	}

	recordRender(durationMs: number) {
		this.record(this.renderSamples, durationMs)
	}

	recordBridgeCall(name: string, count = 1) {
		this.bridgeCalls += count
		this.bridgeCounts.set(name, (this.bridgeCounts.get(name) ?? 0) + count)
	}

	async trackBridge<T>(name: string, task: () => Promise<T>): Promise<T> {
		this.recordBridgeCall(name)
		return task()
	}

	recordSessionSize(bytes: number, messages = 0) {
		if (!Number.isFinite(bytes) || bytes < 0) return
		this.sessionSamples += 1
		this.lastSessionBytes = bytes
		this.maxSessionBytes = Math.max(this.maxSessionBytes, bytes)
		this.lastSessionMessages = messages
	}

	snapshot(): PerfMetricsSnapshot {
		return {
			generatedAt: new Date().toISOString(),
			persistence: summarize(this.persistenceSamples),
			persistenceEncode: summarize(this.persistenceEncodeSamples),
			persistenceWrite: summarize(this.persistenceWriteSamples),
			render: summarize(this.renderSamples),
			bridge: {
				calls: this.bridgeCalls,
				byName: Object.fromEntries(this.bridgeCounts.entries()),
			},
			session: {
				samples: this.sessionSamples,
				lastBytes: this.lastSessionBytes,
				maxBytes: this.maxSessionBytes,
				lastMessages: this.lastSessionMessages,
			},
		}
	}

	reset() {
		this.persistenceSamples.length = 0
		this.persistenceEncodeSamples.length = 0
		this.persistenceWriteSamples.length = 0
		this.renderSamples.length = 0
		this.bridgeCounts.clear()
		this.bridgeCalls = 0
		this.sessionSamples = 0
		this.lastSessionBytes = 0
		this.maxSessionBytes = 0
		this.lastSessionMessages = 0
	}
}

export const perfMetrics = new PerfMetrics()
export { PerfMetrics }

export function perfNow() {
	const performanceApi =
		typeof window === 'undefined' ? undefined : window.performance
	if (performanceApi && typeof performanceApi.now === 'function') {
		return performanceApi.now()
	}
	return Date.now()
}
