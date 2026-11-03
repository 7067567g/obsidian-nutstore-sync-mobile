import { apiVersion, Platform, requestUrl } from 'obsidian'
import type NutstorePlugin from '~/index'
import { NUTSTORE_LLM_GATEWAY_PROVIDER_ID } from '~/consts'
import {
	buildConnectivityReport,
	type ConnectivityReport,
	type DegradationDetail,
	type GatewayCapability,
	type McpHealth,
	type McpRuntimeLike,
	type SsoCapability,
} from './degradation'
import { DIAGNOSTICS_ROOT_DIR } from './log-file'

export interface DiagnosticsSelfCheckReport {
	generatedAt: string
	plugin: {
		id: string
		version: string
	}
	obsidianApiVersion: string
	isSecureContext: boolean | null
	crypto: {
		subtle: string
		randomUUID: string
		getRandomValues: string
	}
	platform: {
		isMobileApp: boolean
		isMobile: boolean
	}
	adapter: {
		constructorName: string
		append: string
		appendBinary: string
		listSample: string[]
		listError?: string
	}
	requestUrl: string
	navigator: {
		userAgent: string
		deviceMemory: number | null
		hardwareConcurrency: number | null
		language: string | null
		onLine: boolean | null
	}
	storage: {
		quota: number | null
		usage: number | null
		error?: string
	}
	capabilities: {
		worker: string
		navigatorLocks: string
		textEncoder: string
		textDecoder: string
		structuredClone: string
		requestIdleCallback: string
	}
	/** #104: observed gateway / SSO / MCP capability and degradation state. */
	gateway: GatewayCapability
	sso: SsoCapability
	mcp: McpHealth
	degradation: DegradationDetail[]
}

function safeStringifyType(value: unknown) {
	return typeof value
}

function readNumberProperty(
	target: Record<string, unknown>,
	key: string,
): number | null {
	const value = target[key]
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBooleanProperty(
	target: Record<string, unknown>,
	key: string,
): boolean | null {
	const value = target[key]
	return typeof value === 'boolean' ? value : null
}

function getNavigator() {
	return typeof navigator === 'undefined' ? undefined : navigator
}

function getWindow() {
	return typeof window === 'undefined' ? undefined : window
}

function toRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null) return {}
	return value as Record<string, unknown>
}

function readType(value: unknown) {
	return typeof value
}

function getCapability(name: string) {
	if (typeof window === 'undefined') return 'undefined'
	return readType((window as unknown as Record<string, unknown>)[name])
}

/**
 * Read the already-observed gateway/SSO/MCP state. Deliberately does not probe
 * the network and never copies tokens or OAuth ciphertext into the report.
 */
function readConnectivity(plugin: NutstorePlugin): ConnectivityReport {
	const settings = plugin.settings
	const ai = toRecord(settings?.ai)
	const gatewaySettings = toRecord(ai.nutstoreLlmGateway)
	const providers = toRecord(ai.providers)
	const provider = toRecord(providers[NUTSTORE_LLM_GATEWAY_PROVIDER_ID])
	const models = toRecord(provider.models)
	let lastFailure: GatewayCapability['lastFailure']
	try {
		lastFailure = plugin.nutstoreLlmGatewayService?.getLastGatewayFailure?.()
	} catch {
		lastFailure = undefined
	}
	let mcpRuntimes: McpRuntimeLike[]
	try {
		const runtimes = plugin.mcpService?.getServerRuntimes?.()
		mcpRuntimes = Array.isArray(runtimes) ? runtimes : []
	} catch {
		mcpRuntimes = []
	}
	return buildConnectivityReport({
		loginMode: settings?.loginMode,
		hasOAuthResponse:
			typeof settings?.oauthResponseText === 'string' &&
			settings.oauthResponseText.trim().length > 0,
		canDecrypt: typeof plugin.getDecryptedOAuthInfo === 'function',
		gateway: {
			authorized:
				typeof gatewaySettings.accessToken === 'string' &&
				gatewaySettings.accessToken.length > 0 &&
				typeof gatewaySettings.refreshToken === 'string' &&
				gatewaySettings.refreshToken.length > 0,
			authorizing: !!gatewaySettings.pendingAuthorization,
			providerConfigured: Object.keys(provider).length > 0,
			modelCount: Object.keys(models).length,
			lastFailure,
		},
		mcpRuntimes,
	})
}

export async function runSelfCheck(
	plugin: NutstorePlugin,
): Promise<DiagnosticsSelfCheckReport> {
	const app = plugin.app
	const adapter = app.vault.adapter
	const navigatorLike = getNavigator()
	const windowLike = getWindow()
	const navigatorRecord = toRecord(navigatorLike)
	const connectivity = readConnectivity(plugin)

	const report: DiagnosticsSelfCheckReport = {
		generatedAt: new Date().toISOString(),
		plugin: {
			id: plugin.manifest.id,
			version: plugin.manifest.version,
		},
		obsidianApiVersion: typeof apiVersion === 'string' ? apiVersion : 'unknown',
		isSecureContext:
			typeof windowLike?.isSecureContext === 'boolean'
				? windowLike.isSecureContext
				: null,
		crypto: {
			subtle:
				typeof crypto === 'undefined' ? 'undefined' : typeof crypto.subtle,
			randomUUID:
				typeof crypto === 'undefined' ? 'undefined' : typeof crypto.randomUUID,
			getRandomValues:
				typeof crypto === 'undefined'
					? 'undefined'
					: typeof crypto.getRandomValues,
		},
		platform: {
			isMobileApp: !!Platform?.isMobileApp,
			isMobile: !!(Platform as unknown as { isMobile?: boolean } | undefined)
				?.isMobile,
		},
		adapter: {
			constructorName: adapter.constructor?.name ?? 'unknown',
			append: safeStringifyType(
				(adapter as unknown as { append?: unknown }).append,
			),
			appendBinary: safeStringifyType(
				(adapter as unknown as { appendBinary?: unknown }).appendBinary,
			),
			listSample: [],
		},
		requestUrl: safeStringifyType(requestUrl),
		navigator: {
			userAgent:
				typeof navigatorRecord.userAgent === 'string'
					? navigatorRecord.userAgent
					: 'unknown',
			deviceMemory: readNumberProperty(navigatorRecord, 'deviceMemory'),
			hardwareConcurrency: readNumberProperty(
				navigatorRecord,
				'hardwareConcurrency',
			),
			language:
				typeof navigatorRecord.language === 'string'
					? navigatorRecord.language
					: null,
			onLine: readBooleanProperty(navigatorRecord, 'onLine'),
		},
		storage: {
			quota: null,
			usage: null,
		},
		capabilities: {
			worker: getCapability('Worker'),
			navigatorLocks: readType(navigatorRecord.locks),
			textEncoder: getCapability('TextEncoder'),
			textDecoder: getCapability('TextDecoder'),
			structuredClone: getCapability('structuredClone'),
			requestIdleCallback: readType(
				windowLike &&
					(windowLike as { requestIdleCallback?: unknown }).requestIdleCallback,
			),
		},
		...connectivity,
	}

	try {
		await plugin.diagnosticsLogFile.ensureDirectory(DIAGNOSTICS_ROOT_DIR)
		const listed = await adapter.list(DIAGNOSTICS_ROOT_DIR)
		report.adapter.listSample = listed.files.slice(0, 8)
	} catch (error) {
		report.adapter.listError =
			error instanceof Error ? error.message : String(error)
	}

	try {
		const estimate = await navigatorLike?.storage?.estimate?.()
		if (estimate) {
			report.storage.quota =
				typeof estimate.quota === 'number' ? estimate.quota : null
			report.storage.usage =
				typeof estimate.usage === 'number' ? estimate.usage : null
		}
	} catch (error) {
		report.storage.error =
			error instanceof Error ? error.message : String(error)
	}

	return report
}
