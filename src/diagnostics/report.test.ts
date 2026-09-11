import { describe, expect, it, vi } from 'vitest'
import type NutstorePlugin from '..'
import { exportDiagnosticsPackage } from './report'

describe('diagnostics report export', () => {
	it('writes a startup snapshot with self-check and perf fields', async () => {
		const written = new Map<string, string>()
		const adapter = {
			async write(path: string, content: string) {
				written.set(path, content)
			},
		}
		const plugin = {
			app: { vault: { adapter } },
			manifest: { id: 'nutstore-sync', version: '1.5.0' },
			selfCheckReport: {
				generatedAt: '2026-09-10T03:00:00.000Z',
				plugin: { id: 'nutstore-sync', version: '1.5.0' },
				obsidianApiVersion: '1.13.8',
				isSecureContext: true,
				crypto: {
					subtle: 'object',
					randomUUID: 'function',
					getRandomValues: 'function',
				},
				platform: { isMobileApp: true, isMobile: true },
				adapter: {
					constructorName: 'TestAdapter',
					append: 'function',
					appendBinary: 'function',
					listSample: [],
				},
				requestUrl: 'function',
				navigator: {
					userAgent: 'test',
					deviceMemory: 8,
					hardwareConcurrency: 8,
					language: 'zh-CN',
					onLine: true,
				},
				storage: { quota: 100, usage: 20 },
			},
			diagnosticsLogFile: {
				flush: vi.fn().mockResolvedValue(undefined),
				readRecent: vi.fn().mockResolvedValue('recent-log-line'),
				listLogFiles: vi.fn().mockResolvedValue(['plugin-log.txt']),
				ensureDirectory: vi.fn().mockResolvedValue(undefined),
			},
		} as unknown as NutstorePlugin

		const filePath = await exportDiagnosticsPackage(plugin, {
			reason: 'startup',
		})

		expect(filePath).toBe(
			'.agents/nutstore-sync/diagnostics/startup-diagnostics.json',
		)
		const content = written.get(filePath)
		expect(content).toBeTruthy()
		const payload = JSON.parse(content!)
		expect(payload.reason).toBe('startup')
		expect(payload.selfCheck.platform.isMobileApp).toBe(true)
		expect(payload.perf).toHaveProperty('persistence')
		expect(payload.perf).toHaveProperty('bridge.calls')
		expect(payload.recentLog).toBe('recent-log-line')
	})
})
