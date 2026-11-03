import i18n from '~/i18n'

/**
 * #104: capability/degradation vocabulary shared by diagnostics and the
 * gateway service. Everything here is privacy-conscious: only stable codes,
 * counts and fixed descriptions — never tokens, account names or response
 * bodies.
 */
export type DegradationArea = 'gateway' | 'sso' | 'mcp'

export type DegradationSeverity = 'info' | 'warn' | 'error'

export type DegradationCode =
	| 'offline'
	| 'timeout'
	| 'tls_error'
	| 'unauthorized'
	| 'http_error'
	| 'method_not_allowed'
	| 'not_configured'
	| 'unknown'

export interface DegradationDetail {
	area: DegradationArea
	code: DegradationCode
	severity: DegradationSeverity
	retryable: boolean
	/** HTTP status when the failure came from a response. */
	status?: number
	/** MCP server name / gateway scope when relevant. */
	source?: string
	/** Fixed, user-readable description (no raw response body). */
	summary: string
	/** What the user can do next without losing local chat history. */
	remediation: string
}

export interface GatewayFailureRecord extends DegradationDetail {
	at: string
}

export interface McpRuntimeLike {
	name: string
	enabled: boolean
	status?: 'connecting' | 'connected' | 'error'
	error?: string
	tools: readonly unknown[]
}

export interface McpHealth {
	servers: number
	enabled: number
	connected: number
	failed: number
	failureCodes: DegradationCode[]
	lastError?: string
	degradations: DegradationDetail[]
}

export interface GatewayCapability {
	status:
		| 'ready'
		| 'authorizing'
		| 'not_authorized'
		| 'not_configured'
		| 'degraded'
		| 'unknown'
	authorized: boolean
	authorizing: boolean
	providerConfigured: boolean
	modelCount: number
	lastFailure?: GatewayFailureRecord
}

export interface SsoCapability {
	loginMode: 'sso' | 'manual' | 'unknown'
	status: 'logged_in' | 'not_logged_in' | 'manual' | 'unknown'
	hasOAuthResponse: boolean
	canDecrypt: boolean
}

export interface ConnectivityReport {
	gateway: GatewayCapability
	sso: SsoCapability
	mcp: McpHealth
	degradation: DegradationDetail[]
}

const GATEWAY_DETAILS: Record<
	Exclude<DegradationCode, 'not_configured'>,
	Pick<DegradationDetail, 'severity' | 'retryable' | 'summary' | 'remediation'>
> = {
	offline: {
		severity: 'warn',
		retryable: true,
		summary:
			'Gateway is unreachable (offline, DNS or connection failure). Local chat history is unaffected.',
		remediation:
			'Check connectivity/VPN, then retry. Switch to another provider or a manual account in the meantime.',
	},
	timeout: {
		severity: 'warn',
		retryable: true,
		summary: 'Gateway request timed out. Local chat history is unaffected.',
		remediation:
			'Retry once connectivity is stable; if it keeps timing out, use another provider and export diagnostics.',
	},
	tls_error: {
		severity: 'error',
		retryable: false,
		summary:
			'Gateway TLS/certificate validation failed, so the request was not trusted.',
		remediation:
			'Check the device certificate/proxy/VPN configuration; do not bypass certificate validation.',
	},
	unauthorized: {
		severity: 'warn',
		retryable: false,
		summary:
			'Gateway authorization is missing, expired or rejected (HTTP 401/403).',
		remediation:
			'Re-authorize 坚果云 AI or switch to a manual account; local history is untouched.',
	},
	http_error: {
		severity: 'warn',
		retryable: true,
		summary: 'Gateway returned an HTTP error response.',
		remediation:
			'Retry later; if it persists, export diagnostics and use another provider.',
	},
	method_not_allowed: {
		severity: 'error',
		retryable: false,
		summary:
			'Gateway/MCP endpoint rejected the HTTP method (405 Method Not Allowed).',
		remediation:
			'Verify the endpoint URL and server version; this client will not retry the rejected method.',
	},
	unknown: {
		severity: 'warn',
		retryable: false,
		summary: 'Gateway request failed for an unclassified reason.',
		remediation:
			'Retry once; if it persists, export diagnostics and use another provider.',
	},
}

const NOT_CONFIGURED_DETAIL: Pick<
	DegradationDetail,
	'severity' | 'retryable' | 'summary' | 'remediation'
> = {
	severity: 'info',
	retryable: false,
	summary: 'The integration is not configured or not enabled.',
	remediation:
		'Complete authorization/config first; unrelated local features keep working.',
}

const GATEWAY_REASON_KEYS = {
	offline: 'settings.ai.nutstoreLlmGateway.degradation.reasons.offline',
	timeout: 'settings.ai.nutstoreLlmGateway.degradation.reasons.timeout',
	tls_error: 'settings.ai.nutstoreLlmGateway.degradation.reasons.tlsError',
	unauthorized:
		'settings.ai.nutstoreLlmGateway.degradation.reasons.unauthorized',
	http_error: 'settings.ai.nutstoreLlmGateway.degradation.reasons.httpError',
	method_not_allowed:
		'settings.ai.nutstoreLlmGateway.degradation.reasons.methodNotAllowed',
	not_configured:
		'settings.ai.nutstoreLlmGateway.degradation.reasons.notConfigured',
	unknown: 'settings.ai.nutstoreLlmGateway.degradation.reasons.unknown',
} as const satisfies Record<DegradationCode, string>

function errorText(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`
	if (typeof error === 'string') return error
	try {
		return JSON.stringify(error) ?? String(error)
	} catch {
		return String(error)
	}
}

function readStatus(error: unknown, explicit?: number): number | undefined {
	if (typeof explicit === 'number' && Number.isFinite(explicit)) {
		return explicit
	}
	if (typeof error === 'object' && error !== null) {
		const status = (error as { status?: unknown }).status
		if (typeof status === 'number' && Number.isFinite(status)) return status
	}
	const match = /\b(?:http|status(?: code)?)\D{0,4}(\d{3})\b/i.exec(
		errorText(error),
	)
	if (!match?.[1]) return undefined
	const parsed = Number.parseInt(match[1], 10)
	return Number.isFinite(parsed) ? parsed : undefined
}

function degradation(
	area: DegradationArea,
	code: DegradationCode,
	extra: Partial<DegradationDetail> = {},
): DegradationDetail {
	const detail =
		code === 'not_configured' ? NOT_CONFIGURED_DETAIL : GATEWAY_DETAILS[code]
	return { area, code, ...detail, ...extra }
}

export function classifyGatewayFailure(
	error: unknown,
	options: { status?: number } = {},
	depth = 0,
): DegradationDetail {
	const cause =
		typeof error === 'object' && error !== null
			? (error as { cause?: unknown }).cause
			: undefined
	if (cause !== undefined && cause !== error && depth < 3) {
		const fromCause = classifyGatewayFailure(cause, options, depth + 1)
		if (fromCause.code !== 'unknown') return fromCause
	}
	const status = readStatus(error, options.status)
	const text = errorText(error)
	const withStatus = status === undefined ? {} : { status }

	if (status === 401 || status === 403) {
		return degradation('gateway', 'unauthorized', withStatus)
	}
	if (status === 405) {
		return degradation('gateway', 'method_not_allowed', withStatus)
	}
	if (
		/unauthor|forbidden|authorization required|未授权|请先授权|授权已过期/i.test(
			text,
		)
	) {
		return degradation('gateway', 'unauthorized', withStatus)
	}
	if (/timeout|timed out|etimedout|aborterror|timeout exceeded/i.test(text)) {
		return degradation('gateway', 'timeout', withStatus)
	}
	if (/certificate|\btls\b|\bssl\b|self[- ]signed|err_cert/i.test(text)) {
		return degradation('gateway', 'tls_error', withStatus)
	}
	if (
		/offline|network|failed to fetch|request failed|net::err|enotfound|econnrefused|econnreset|internet_disconnected|\bdns\b/i.test(
			text,
		)
	) {
		return degradation('gateway', 'offline', withStatus)
	}
	if (status !== undefined && status >= 400) {
		return degradation('gateway', 'http_error', withStatus)
	}
	if (/not configured|missing client|缺少.*client|未配置/i.test(text)) {
		return degradation('gateway', 'not_configured', withStatus)
	}
	return degradation('gateway', 'unknown', withStatus)
}

/**
 * User-facing fallback shown by the gateway Notice. Kept in this module so the
 * classifier and the wording cannot drift apart.
 */
export function formatGatewayDegradation(
	error: unknown,
	options: { status?: number } = {},
): string {
	const detail = classifyGatewayFailure(error, options)
	const reason = i18n.t(GATEWAY_REASON_KEYS[detail.code])
	const suffix = detail.status ? ` (HTTP ${detail.status})` : ''
	return i18n.t('settings.ai.nutstoreLlmGateway.degradation.message', {
		reason: `${reason}${suffix}`,
	})
}

function mcpDegradation(
	code: DegradationCode,
	extra: Partial<DegradationDetail> = {},
): DegradationDetail {
	const detail = degradation('mcp', code, extra)
	return {
		...detail,
		summary: detail.summary.replace(/^Gateway/, 'MCP server'),
	}
}

export function classifyMcpFailure(error: unknown): DegradationDetail {
	const status = readStatus(error)
	const text = errorText(error)
	const withStatus = status === undefined ? {} : { status }

	if (
		status === 405 ||
		/405|method not allowed|method_not_allowed/i.test(text)
	) {
		return mcpDegradation('method_not_allowed', {
			...withStatus,
			summary:
				'MCP server rejected the request with HTTP 405. Per the MCP SDK, a GET SSE 405 is expected; a surfaced 405 therefore comes from POST/initialize or a JSON-RPC -32000 response.',
			remediation:
				"Verify this URL is a Streamable HTTP MCP endpoint. The server's tools stay unavailable; other servers and local chat are unaffected.",
		})
	}
	if (status === 401 || status === 403) {
		return mcpDegradation('unauthorized', withStatus)
	}
	if (/timeout|timed out|etimedout|aborterror/i.test(text)) {
		return mcpDegradation('timeout', withStatus)
	}
	if (/certificate|\btls\b|\bssl\b|err_cert/i.test(text)) {
		return mcpDegradation('tls_error', withStatus)
	}
	if (
		/offline|network|failed to fetch|request failed|net::err|\bdns\b/i.test(
			text,
		)
	) {
		return mcpDegradation('offline', withStatus)
	}
	if (status !== undefined && status >= 400) {
		return mcpDegradation('http_error', withStatus)
	}
	if (/not configured|unsupported mcp server type|未配置/i.test(text)) {
		return mcpDegradation('not_configured', withStatus)
	}
	return mcpDegradation('unknown', withStatus)
}

/** Redact token-ish substrings before an error message enters diagnostics. */
export function redactErrorText(text: string, maxLength = 300): string {
	const redacted = text
		.replace(/(bearer\s+)[^\s,;]+/gi, '$1[redacted]')
		.replace(
			/((?:access_token|refresh_token|api[_-]?key|token)=)[^&\s,;]+/gi,
			'$1[redacted]',
		)
		.replace(/(authorization\s*:\s*)[^\n,;]+/gi, '$1[redacted]')
	return redacted.length > maxLength
		? `${redacted.slice(0, maxLength)}…`
		: redacted
}

export function summarizeMcpRuntimes(
	runtimes: readonly McpRuntimeLike[],
): McpHealth {
	const health: McpHealth = {
		servers: runtimes.length,
		enabled: 0,
		connected: 0,
		failed: 0,
		failureCodes: [],
		degradations: [],
	}
	for (const runtime of runtimes) {
		if (!runtime.enabled) continue
		health.enabled += 1
		if (runtime.status === 'connected' && runtime.tools.length > 0) {
			health.connected += 1
			continue
		}
		health.failed += 1
		const detail = classifyMcpFailure(
			runtime.error ?? `MCP server ${runtime.name} is not connected`,
		)
		detail.source = runtime.name
		health.degradations.push(detail)
		if (!health.failureCodes.includes(detail.code)) {
			health.failureCodes.push(detail.code)
		}
		if (runtime.error) {
			health.lastError = redactErrorText(runtime.error)
		}
	}
	return health
}

export interface ConnectivityInput {
	loginMode?: unknown
	hasOAuthResponse?: boolean
	canDecrypt?: boolean
	gateway?: {
		authorized?: boolean
		authorizing?: boolean
		providerConfigured?: boolean
		modelCount?: number
		lastFailure?: GatewayFailureRecord
	}
	mcpRuntimes?: readonly McpRuntimeLike[]
}

/**
 * Combine observed state (never probes the network) into the diagnostics
 * `gateway` / `sso` / `mcp` sections plus a flat degradation list.
 */
export function buildConnectivityReport(
	input: ConnectivityInput = {},
): ConnectivityReport {
	const authorized = input.gateway?.authorized === true
	const authorizing = input.gateway?.authorizing === true
	const providerConfigured = input.gateway?.providerConfigured === true
	const lastFailure = input.gateway?.lastFailure
	const degradationList: DegradationDetail[] = []

	let status: GatewayCapability['status']
	if (input.gateway === undefined) {
		status = 'unknown'
	} else if (lastFailure) {
		status = 'degraded'
		degradationList.push({
			area: lastFailure.area,
			code: lastFailure.code,
			severity: lastFailure.severity,
			retryable: lastFailure.retryable,
			status: lastFailure.status,
			source: lastFailure.source,
			summary: lastFailure.summary,
			remediation: lastFailure.remediation,
		})
	} else if (authorizing) {
		status = 'authorizing'
	} else if (authorized && providerConfigured) {
		status = 'ready'
	} else if (authorized) {
		status = 'not_configured'
	} else if (providerConfigured) {
		status = 'not_authorized'
		degradationList.push(
			degradation('gateway', 'unauthorized', {
				summary:
					'Gateway provider is configured but no usable tokens are stored.',
				remediation:
					'Re-authorize 坚果云 AI or remove the provider; local history is untouched.',
			}),
		)
	} else {
		status = 'not_configured'
	}

	const loginMode =
		input.loginMode === 'manual' || input.loginMode === 'sso'
			? input.loginMode
			: 'unknown'
	const hasOAuthResponse = input.hasOAuthResponse === true
	let ssoStatus: SsoCapability['status']
	if (loginMode === 'manual') {
		ssoStatus = 'manual'
	} else if (loginMode === 'sso') {
		ssoStatus = hasOAuthResponse ? 'logged_in' : 'not_logged_in'
		if (!hasOAuthResponse) {
			degradationList.push(
				degradation('sso', 'not_configured', {
					summary:
						'SSO login mode is selected but no OAuth response is stored.',
					remediation:
						'Complete the SSO login before syncing, or switch to manual mode.',
				}),
			)
		}
	} else {
		ssoStatus = 'unknown'
	}

	const mcp = summarizeMcpRuntimes(input.mcpRuntimes ?? [])
	degradationList.push(...mcp.degradations)

	return {
		gateway: {
			status,
			authorized,
			authorizing,
			providerConfigured,
			modelCount:
				typeof input.gateway?.modelCount === 'number'
					? input.gateway.modelCount
					: 0,
			lastFailure,
		},
		sso: {
			loginMode,
			status: ssoStatus,
			hasOAuthResponse,
			canDecrypt: input.canDecrypt !== false,
		},
		mcp,
		degradation: degradationList,
	}
}
