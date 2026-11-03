import { describe, expect, it, vi } from 'vitest'
import type NutstorePlugin from '~/index'
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
		expect(report.gateway.status).toBe('not_configured')
		expect(report.sso.status).toBe('unknown')
		expect(report.mcp.servers).toBe(0)
		expect(report.degradation).toEqual([])
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

	it('reports gateway/SSO/MCP capability without leaking secrets', async () => {
		const plugin = {
			app: { vault: { adapter: new TestAdapter() } },
			manifest: { id: 'nutstore-sync', version: '1.5.7' },
			diagnosticsLogFile: {
				ensureDirectory: vi.fn().mockResolvedValue(undefined),
			},
			settings: {
				loginMode: 'sso',
				oauthResponseText: 'oauth-ciphertext-secret',
				ai: {
					providers: {
						'nutstore-llm-gateway': {
							id: 'nutstore-llm-gateway',
							models: { 'model-a': {}, 'model-b': {} },
						},
					},
					nutstoreLlmGateway: {
						accessToken: 'access-token-secret',
						refreshToken: 'refresh-token-secret',
					},
				},
			},
			getDecryptedOAuthInfo: vi.fn(),
			nutstoreLlmGatewayService: {
				getLastGatewayFailure: () => ({
					area: 'gateway',
					code: 'timeout',
					severity: 'warn',
					retryable: true,
					summary: 'Gateway request timed out.',
					remediation: 'Retry later.',
					at: '2026-10-25T00:00:00.000Z',
				}),
			},
			mcpService: {
				getServerRuntimes: () => [
					{
						name: 'exa',
						enabled: true,
						status: 'error',
						error:
							'HTTP 405 Method not allowed (Authorization: Bearer mcp-secret)',
						tools: [],
					},
				],
			},
		} as unknown as NutstorePlugin

		const report = await runSelfCheck(plugin)

		expect(report.gateway).toMatchObject({
			status: 'degraded',
			authorized: true,
			providerConfigured: true,
			modelCount: 2,
			lastFailure: { code: 'timeout' },
		})
		expect(report.sso).toEqual({
			loginMode: 'sso',
			status: 'logged_in',
			hasOAuthResponse: true,
			canDecrypt: true,
		})
		expect(report.mcp).toMatchObject({
			servers: 1,
			enabled: 1,
			connected: 0,
			failed: 1,
			failureCodes: ['method_not_allowed'],
		})
		expect(report.degradation).toEqual([
			expect.objectContaining({ area: 'gateway', code: 'timeout' }),
			expect.objectContaining({ area: 'mcp', code: 'method_not_allowed' }),
		])

		const serialized = JSON.stringify(report)
		expect(serialized).not.toContain('access-token-secret')
		expect(serialized).not.toContain('refresh-token-secret')
		expect(serialized).not.toContain('oauth-ciphertext-secret')
		expect(serialized).not.toContain('mcp-secret')
	})

	it('keeps diagnostics usable when MCP runtime introspection throws', async () => {
		const plugin = {
			app: { vault: { adapter: new TestAdapter() } },
			manifest: { id: 'nutstore-sync', version: '1.5.7' },
			diagnosticsLogFile: {
				ensureDirectory: vi.fn().mockResolvedValue(undefined),
			},
			mcpService: {
				getServerRuntimes: () => {
					throw new Error('boom')
				},
			},
		} as unknown as NutstorePlugin

		const report = await runSelfCheck(plugin)
		expect(report.mcp.failed).toBe(0)
		expect(report.mcp.servers).toBe(0)
	})
})
