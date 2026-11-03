import { isNil } from 'lodash-es'
import type { NutstoreSettings } from '~/settings'
import { tryParseTokenLimitInput } from '~/utils/token-limit'
import {
	CONFIG_DIR_SYNC_MODES,
	CONFLICT_STRATEGIES,
	LANGUAGES,
	MAX_SECONDS,
	SYNC_MODES,
	WHITELIST_KEYS,
	isObject,
	jsonError,
} from './settings-whitelist-schema'
import {
	parseBoolean,
	parseByteSize,
	parseClampedInteger,
	parseEnum,
	parseFilterRules,
} from './settings-whitelist-parse'
import type {
	AIModelLimitWhitelistEntry,
	NormalizedSettingsPatch,
	SettingsParseResult,
} from './settings-whitelist-types'

/**
 * The subset of plugin settings the AI agent is allowed to read and modify
 * through the virtual settings file under the mountable filesystem.
 *
 * Deliberately excludes credentials (account, credential, oauth response),
 * enterprise base URL, and AI provider secrets.
 *
 * The shared types, field parsers, serialization, diffing, and description
 * pieces live in the sibling `settings-whitelist-*` modules; this file keeps
 * the public entry point and re-exports the frozen surface.
 */

export type {
	AIModelLimitWhitelistEntry,
	NormalizedSettingsPatch,
	SettingsParseResult,
	SettingsWhitelistFile,
	WhitelistFilterRule,
} from './settings-whitelist-types'
export { serializeSettingsWhitelist } from './settings-whitelist-serialize'
export { getChangedSettingsPatch } from './settings-whitelist-diff'
export { describeSettingsPatch } from './settings-whitelist-describe'

export function applyNormalizedSettingsPatch(
	settings: NutstoreSettings,
	patch: NormalizedSettingsPatch,
) {
	if (patch.filterRules !== undefined) {
		settings.filterRules = { rules: patch.filterRules }
	}
	if (patch.skipLargeFilesMaxSize !== undefined) {
		settings.skipLargeFiles = { maxSize: patch.skipLargeFilesMaxSize }
	}
	if (patch.startupSyncDelaySeconds !== undefined) {
		settings.startupSyncDelaySeconds = patch.startupSyncDelaySeconds
	}
	if (patch.autoSyncIntervalSeconds !== undefined) {
		settings.autoSyncIntervalSeconds = patch.autoSyncIntervalSeconds
	}
	if (patch.realtimeSync !== undefined) {
		settings.realtimeSync = patch.realtimeSync
	}
	if (patch.confirmBeforeSync !== undefined) {
		settings.confirmBeforeSync = patch.confirmBeforeSync
	}
	if (patch.confirmBeforeDeleteInAutoSync !== undefined) {
		settings.confirmBeforeDeleteInAutoSync = patch.confirmBeforeDeleteInAutoSync
	}
	if (patch.syncMode !== undefined) {
		settings.syncMode = patch.syncMode
	}
	if (patch.conflictStrategy !== undefined) {
		settings.conflictStrategy = patch.conflictStrategy
	}
	if (patch.configDirSyncMode !== undefined) {
		settings.configDirSyncMode = patch.configDirSyncMode
	}
	if (patch.language !== undefined) {
		settings.language = patch.language || undefined
	}
	if (patch.bashAccess !== undefined) {
		settings.ai.bashAccess = patch.bashAccess
	}
	if (patch.toolTimeoutSeconds !== undefined) {
		settings.ai.toolTimeoutMs =
			patch.toolTimeoutSeconds > 0 ? patch.toolTimeoutSeconds * 1000 : undefined
	}
	if (patch.aiModelLimits !== undefined) {
		for (const entry of patch.aiModelLimits) {
			const model =
				settings.ai?.providers?.[entry.providerId]?.models?.[entry.modelId]
			if (!model) continue
			model.limit = {
				...model.limit,
				...(entry.context !== undefined ? { context: entry.context } : {}),
				...(entry.output !== undefined ? { output: entry.output } : {}),
			}
		}
	}
}

const MAX_AI_MODEL_LIMIT_ENTRIES = 500

function parseAIModelLimits(value: unknown): {
	entries: AIModelLimitWhitelistEntry[]
	error: string | null
} {
	if (!Array.isArray(value)) {
		return { entries: [], error: jsonError('aiModelLimits', 'an array') }
	}
	if (value.length > MAX_AI_MODEL_LIMIT_ENTRIES) {
		return {
			entries: [],
			error: `invalid setting 'aiModelLimits': too many entries (max ${MAX_AI_MODEL_LIMIT_ENTRIES})`,
		}
	}
	const entries: AIModelLimitWhitelistEntry[] = []
	for (let index = 0; index < value.length; index += 1) {
		const name = `aiModelLimits[${index}]`
		// `Array.isArray` narrows `unknown` to `any[]`; keep the loop boundary
		// `unknown` so the `isObject` guard below does the real narrowing.
		const entry: unknown = value[index]
		if (!isObject(entry))
			return { entries: [], error: jsonError(name, 'an object') }
		const providerId = entry.providerId
		const modelId = entry.modelId
		if (typeof providerId !== 'string' || providerId.trim() === '') {
			return {
				entries: [],
				error: jsonError(`${name}.providerId`, 'a non-empty string'),
			}
		}
		if (typeof modelId !== 'string' || modelId.trim() === '') {
			return {
				entries: [],
				error: jsonError(`${name}.modelId`, 'a non-empty string'),
			}
		}
		const context =
			entry.context === undefined
				? undefined
				: tryParseTokenLimitInput(entry.context)
		const output =
			entry.output === undefined
				? undefined
				: tryParseTokenLimitInput(entry.output)
		if (entry.context !== undefined && context === null) {
			return {
				entries: [],
				error: jsonError(
					`${name}.context`,
					'a token count like 1000000, 1M, or 256K',
				),
			}
		}
		if (entry.output !== undefined && output === null) {
			return {
				entries: [],
				error: jsonError(
					`${name}.output`,
					'a token count like 1000000, 1M, or 256K',
				),
			}
		}
		if (context === undefined && output === undefined) {
			return {
				entries: [],
				error: jsonError(name, 'at least one of context or output'),
			}
		}
		entries.push({
			providerId: providerId.trim(),
			modelId: modelId.trim(),
			...(context === null || context === undefined ? {} : { context }),
			...(output === null || output === undefined ? {} : { output }),
		})
	}
	return { entries, error: null }
}

export function parseSettingsWhitelistJson(text: string): SettingsParseResult {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return {
			ok: false,
			error: 'invalid setting file: not valid JSON',
		}
	}
	if (!isObject(parsed)) {
		return {
			ok: false,
			error: 'invalid setting file: expected a JSON object',
		}
	}
	for (const key of Object.keys(parsed)) {
		if (!WHITELIST_KEYS.has(key)) {
			return {
				ok: false,
				error: `invalid setting file: unknown key '${key}' is not allowed`,
			}
		}
	}

	const patch: NormalizedSettingsPatch = {}

	if (!isNil(parsed.filterRules)) {
		const { rules, error } = parseFilterRules('filterRules', parsed.filterRules)
		if (error) {
			return { ok: false, error }
		}
		patch.filterRules = rules
	}
	if (!isNil(parsed.skipLargeFiles)) {
		if (!isObject(parsed.skipLargeFiles)) {
			return {
				ok: false,
				error: jsonError('skipLargeFiles', 'an object with maxSize'),
			}
		}
		const { size, error } = parseByteSize(
			'skipLargeFiles.maxSize',
			parsed.skipLargeFiles.maxSize,
		)
		if (error) {
			return { ok: false, error }
		}
		patch.skipLargeFilesMaxSize = size!
	}
	if (!isNil(parsed.startupSyncDelaySeconds)) {
		const { number, error } = parseClampedInteger(
			'startupSyncDelaySeconds',
			parsed.startupSyncDelaySeconds,
			0,
			MAX_SECONDS,
		)
		if (error) {
			return { ok: false, error }
		}
		patch.startupSyncDelaySeconds = number!
	}
	if (!isNil(parsed.autoSyncIntervalSeconds)) {
		const { number, error } = parseClampedInteger(
			'autoSyncIntervalSeconds',
			parsed.autoSyncIntervalSeconds,
			0,
			MAX_SECONDS,
		)
		if (error) {
			return { ok: false, error }
		}
		patch.autoSyncIntervalSeconds = number!
	}
	for (const key of [
		'realtimeSync',
		'confirmBeforeSync',
		'confirmBeforeDeleteInAutoSync',
	] as const) {
		if (isNil(parsed[key])) {
			continue
		}
		const { boolean, error } = parseBoolean(key, parsed[key])
		if (error) {
			return { ok: false, error }
		}
		;(patch as Record<string, unknown>)[key] = boolean!
	}
	if (!isNil(parsed.syncMode)) {
		const { value, error } = parseEnum(
			'syncMode',
			parsed.syncMode,
			SYNC_MODES,
			"'strict' or 'loose'",
		)
		if (error) {
			return { ok: false, error }
		}
		patch.syncMode = value as NutstoreSettings['syncMode']
	}
	if (!isNil(parsed.conflictStrategy)) {
		const { value, error } = parseEnum(
			'conflictStrategy',
			parsed.conflictStrategy,
			CONFLICT_STRATEGIES,
			'a supported conflict strategy',
		)
		if (error) {
			return { ok: false, error }
		}
		patch.conflictStrategy = value as NutstoreSettings['conflictStrategy']
	}
	if (!isNil(parsed.configDirSyncMode)) {
		const { value, error } = parseEnum(
			'configDirSyncMode',
			parsed.configDirSyncMode,
			CONFIG_DIR_SYNC_MODES,
			"'none', 'bookmarks', or 'all'",
		)
		if (error) {
			return { ok: false, error }
		}
		patch.configDirSyncMode = value as 'none' | 'bookmarks' | 'all'
	}
	if (!isNil(parsed.aiModelLimits)) {
		const { entries, error } = parseAIModelLimits(parsed.aiModelLimits)
		if (error) return { ok: false, error }
		patch.aiModelLimits = entries
	}

	if (!isNil(parsed.language)) {
		const { value, error } = parseEnum(
			'language',
			parsed.language,
			LANGUAGES,
			"'zh', 'en', or an empty string",
		)
		if (error) {
			return { ok: false, error }
		}
		patch.language = value as 'zh' | 'en' | ''
	}
	if (!isNil(parsed.toolTimeoutSeconds)) {
		const { number, error } = parseClampedInteger(
			'toolTimeoutSeconds',
			parsed.toolTimeoutSeconds,
			0,
			MAX_SECONDS,
		)
		if (error) {
			return { ok: false, error }
		}
		patch.toolTimeoutSeconds = number!
	}

	const hasChanges =
		Object.keys(patch).length > 0 ||
		(patch.filterRules !== undefined && patch.filterRules.length === 0)
	if (!hasChanges) {
		return {
			ok: false,
			error: 'invalid setting file: no supported settings were provided',
		}
	}
	return { ok: true, patch, text }
}
