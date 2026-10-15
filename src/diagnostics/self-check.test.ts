import { describe, expect, it, vi } from 'vitest'
import type NutstorePlugin from '..'
import { runSelfCheck } from './self-check'

class TestAdapter {
	async list() {
		return {
			files: ['.agents/nutstore-sync/chat-meta.json'],
			folders: ['.agents/nutstore-sync'],
		}
	}

	append() {}
	appendBinary() {}
}

describe('diagnostics self-check', () => {
	it('reports adapter, crypto and platform capabilities without throwing', async () => {
		const ensureDirectory = vi.fn().mockResolvedValue(undefined)
		const plugin = {
			app: {
				vault: {
					adapter: new TestAdapter(),
				},
			},
			manifest: {
				id: 'nutstore-sync',
				version: '1.5.0',
			},
			diagnosticsLogFile: {
				ensureDirectory,
			},
		} as unknown as NutstorePlugin

		const report = await runSelfCheck(plugin)

		expect(report.plugin).toEqual({
			id: 'nutstore-sync',
			version: '1.5.0',
		})
		expect(report.adapter.constructorName).toBe('TestAdapter')
		expect(report.adapter.append).toBe('function')
		expect(report.adapter.appendBinary).toBe('function')
		expect(report.adapter.listSample).toEqual([
			'.agents/nutstore-sync/chat-meta.json',
		])
		expect(report.requestUrl).toBe('function')
		for (const value of Object.values(report.capabilities)) {
			expect(typeof value).toBe('string')
		}
		expect(ensureDirectory).toHaveBeenCalledWith('.agents/nutstore-sync')
	})

	it('captures adapter list failures instead of rejecting', async () => {
		class FailingAdapter extends TestAdapter {
			override async list(): Promise<{ files: string[]; folders: string[] }> {
				throw new Error('list failed')
			}
		}
		const plugin = {
			app: { vault: { adapter: new FailingAdapter() } },
			manifest: { id: 'nutstore-sync', version: '1.5.0' },
			diagnosticsLogFile: {
				ensureDirectory: vi.fn().mockResolvedValue(undefined),
			},
		} as unknown as NutstorePlugin

		const report = await runSelfCheck(plugin)
		expect(report.adapter.listSample).toEqual([])
		expect(report.adapter.listError).toBe('list failed')
	})
})
