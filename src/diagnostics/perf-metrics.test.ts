import { beforeEach, describe, expect, it } from 'vitest'
import { PerfMetrics } from './perf-metrics'

describe('perf metrics', () => {
	let metrics: PerfMetrics

	beforeEach(() => {
		metrics = new PerfMetrics()
	})

	it('summarizes persistence and render samples', () => {
		metrics.recordPersistence(10)
		metrics.recordPersistence(30)
		metrics.recordRender(5)

		const snapshot = metrics.snapshot()
		expect(snapshot.persistence).toMatchObject({
			count: 2,
			totalMs: 40,
			maxMs: 30,
			averageMs: 20,
		})
		expect(snapshot.render).toMatchObject({
			count: 1,
			totalMs: 5,
			maxMs: 5,
		})
	})

	it('tracks bridge call counts by name', () => {
		metrics.recordBridgeCall('adapter.mkdir')
		metrics.recordBridgeCall('adapter.mkdir')
		metrics.recordBridgeCall('session.write')

		const snapshot = metrics.snapshot()
		expect(snapshot.bridge.calls).toBe(3)
		expect(snapshot.bridge.byName).toEqual({
			'adapter.mkdir': 2,
			'session.write': 1,
		})
	})

	it('tracks session size samples and resets', () => {
		metrics.recordSessionSize(1024)
		metrics.recordSessionSize(4096)
		expect(metrics.snapshot().session).toEqual({
			samples: 2,
			lastBytes: 4096,
			maxBytes: 4096,
			lastMessages: 0,
		})

		metrics.reset()
		expect(metrics.snapshot()).toMatchObject({
			persistence: { count: 0 },
			bridge: { calls: 0 },
			session: { samples: 0, lastBytes: 0, maxBytes: 0 },
		})
	})

	it('ignores invalid samples', () => {
		metrics.recordPersistence(Number.NaN)
		metrics.recordPersistence(-1)
		metrics.recordSessionSize(-1)
		expect(metrics.snapshot().persistence.count).toBe(0)
		expect(metrics.snapshot().session.samples).toBe(0)
	})
})
