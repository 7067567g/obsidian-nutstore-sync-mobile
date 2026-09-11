import { apiVersion, Platform, requestUrl } from 'obsidian'
import type NutstorePlugin from '..'
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

export async function runSelfCheck(
	plugin: NutstorePlugin,
): Promise<DiagnosticsSelfCheckReport> {
	const app = plugin.app
	const adapter = app.vault.adapter
	const navigatorLike = getNavigator()
	const windowLike = getWindow()
	const navigatorRecord = toRecord(navigatorLike)

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
