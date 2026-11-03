import { afterAll, describe, expect, it } from 'vitest'
import i18n from '~/i18n'
import {
	buildConnectivityReport,
	classifyGatewayFailure,
	classifyMcpFailure,
	formatGatewayDegradation,
	redactErrorText,
	summarizeMcpRuntimes,
	type McpRuntimeLike,
} from './degradation'

afterAll(async () => {
	await i18n.changeLanguage('en')
})

describe('gateway failure classification', () => {
	it('classifies network, timeout, TLS, auth and HTTP failures', () => {
		expect(
			classifyGatewayFailure(new TypeError('Failed to fetch')),
		).toMatchObject({ area: 'gateway', code: 'offline', retryable: true })
		expect(
			classifyGatewayFailure(new Error('Request timed out')),
		).toMatchObject({ code: 'timeout', retryable: true })
		expect(
			classifyGatewayFailure(
				new Error('self signed certificate in certificate chain'),
			),
		).toMatchObject({ code: 'tls_error', retryable: false })
		expect(classifyGatewayFailure(new Error('HTTP 401'))).toMatchObject({
			code: 'unauthorized',
			status: 401,
			retryable: false,
		})
		expect(
			classifyGatewayFailure(new Error('HTTP 503'), { status: 503 }),
		).toMatchObject({ code: 'http_error', status: 503, retryable: true })
	})

	it('unwraps a localized wrapper error through its cause', () => {
		const wrapped = new Error('坚果云 AI 暂不可用：未知错误', {
			cause: new TypeError('Failed to fetch'),
		})
		expect(classifyGatewayFailure(wrapped)).toMatchObject({
			code: 'offline',
			retryable: true,
		})
	})

	it('maps Chinese authorization messages without a status code', () => {
		expect(
			classifyGatewayFailure(new Error('请先授权坚果云 AI')),
		).toMatchObject({ code: 'unauthorized', retryable: false })
	})

	it('keeps an unclassified failure distinguishable', () => {
		expect(
			classifyGatewayFailure(new Error('socket closed oddly')),
		).toMatchObject({ code: 'unknown', retryable: false })
		// A specific device-code failure keeps its own message instead of being
		// flattened into the generic authorization hint.
		expect(
			classifyGatewayFailure(
				new Error('Nutstore AI authorization failed: slow_down'),
			),
		).toMatchObject({ code: 'unknown' })
	})
})

describe('gateway readable fallback', () => {
	it('renders a localized degradation message with a local-history guarantee', async () => {
		await i18n.changeLanguage('zh')
		const message = formatGatewayDegradation(new TypeError('Failed to fetch'))
		expect(message).toContain('网络不可用')
		expect(message).toContain('本地会话不受影响')
	})

	it('appends the HTTP status to a service error', async () => {
		await i18n.changeLanguage('en')
		const message = formatGatewayDegradation(new Error('HTTP 503'), {
			status: 503,
		})
		expect(message).toContain('the service returned an error')
		expect(message).toContain('(HTTP 503)')
	})
})

describe('MCP 405 invalidation path', () => {
	it('marks a 405 as method_not_allowed without retrying', () => {
		const detail = classifyMcpFailure(
			new Error('Error POSTing to endpoint (HTTP 405): Method not allowed'),
		)
		expect(detail).toMatchObject({
			area: 'mcp',
			code: 'method_not_allowed',
			status: 405,
			retryable: false,
			severity: 'error',
		})
		expect(detail.summary).toContain('GET SSE 405 is expected')
		expect(classifyMcpFailure(new Error('HTTP 401')).summary).toContain(
			'MCP server',
		)
	})

	it('summarizes only enabled failed servers and redacts tokens from errors', () => {
		const runtimes: McpRuntimeLike[] = [
			{
				name: 'healthy',
				enabled: true,
				status: 'connected',
				tools: [{ name: 'a' }, { name: 'b' }],
			},
			{
				name: 'exa',
				enabled: true,
				status: 'error',
				error:
					'POST https://mcp.example.test/?token=super-secret Bearer abc.def HTTP 405',
				tools: [],
			},
			{
				name: 'disabled',
				enabled: false,
				status: 'error',
				error: 'HTTP 500',
				tools: [],
			},
		]

		const health = summarizeMcpRuntimes(runtimes)
		expect(health).toMatchObject({
			servers: 3,
			enabled: 2,
			connected: 1,
			failed: 1,
			failureCodes: ['method_not_allowed'],
		})
		expect(health.degradations).toHaveLength(1)
		expect(health.degradations[0]).toMatchObject({
			source: 'exa',
			code: 'method_not_allowed',
		})
		expect(health.lastError).not.toContain('super-secret')
		expect(health.lastError).not.toContain('abc.def')
		expect(health.lastError).toContain('[redacted]')
	})

	it('redacts bearer/token/authorization patterns from diagnostics text', () => {
		const redacted = redactErrorText(
			'Authorization: Bearer abc123 access_token=xyz&foo=1',
		)
		expect(redacted).not.toContain('abc123')
		expect(redacted).not.toContain('xyz')
		expect(redacted).toContain('[redacted]')
	})
})

describe('connectivity report', () => {
	it('reports ready gateway and logged-in SSO without degradations', () => {
		const report = buildConnectivityReport({
			loginMode: 'sso',
			hasOAuthResponse: true,
			gateway: {
				authorized: true,
				providerConfigured: true,
				modelCount: 3,
			},
		})
		expect(report.gateway).toMatchObject({
			status: 'ready',
			authorized: true,
			providerConfigured: true,
			modelCount: 3,
		})
		expect(report.sso).toMatchObject({
			loginMode: 'sso',
			status: 'logged_in',
			hasOAuthResponse: true,
		})
		expect(report.degradation).toEqual([])
	})

	it('flags a configured-but-unauthorized gateway', () => {
		const report = buildConnectivityReport({
			gateway: { authorized: false, providerConfigured: true },
		})
		expect(report.gateway.status).toBe('not_authorized')
		expect(report.degradation).toEqual([
			expect.objectContaining({
				area: 'gateway',
				code: 'unauthorized',
				severity: 'warn',
			}),
		])
	})

	it('lets the last recorded failure override a stale ready state', () => {
		const report = buildConnectivityReport({
			gateway: {
				authorized: true,
				providerConfigured: true,
				lastFailure: {
					area: 'gateway',
					code: 'offline',
					severity: 'warn',
					retryable: true,
					summary: 'offline',
					remediation: 'retry',
					at: '2026-10-25T00:00:00.000Z',
				},
			},
		})
		expect(report.gateway.status).toBe('degraded')
		expect(report.degradation[0]).toMatchObject({
			area: 'gateway',
			code: 'offline',
		})
	})

	it('flags SSO selected without an OAuth response', () => {
		const report = buildConnectivityReport({
			loginMode: 'sso',
			hasOAuthResponse: false,
		})
		expect(report.sso.status).toBe('not_logged_in')
		expect(report.degradation).toEqual([
			expect.objectContaining({ area: 'sso', code: 'not_configured' }),
		])
	})

	it('merges MCP failures into the flat degradation list', () => {
		const report = buildConnectivityReport({
			loginMode: 'manual',
			mcpRuntimes: [
				{
					name: 'exa',
					enabled: true,
					status: 'error',
					error: 'HTTP 405 Method not allowed',
					tools: [],
				},
			],
		})
		expect(report.mcp.failed).toBe(1)
		expect(report.degradation).toEqual([
			expect.objectContaining({
				area: 'mcp',
				code: 'method_not_allowed',
				source: 'exa',
			}),
		])
	})
})
