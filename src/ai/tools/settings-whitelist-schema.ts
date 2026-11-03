import { parse as bytesParse } from 'bytes-iec'

const MAX_FILE_SIZE = '500MB'
const MAX_BYTES = bytesParse(MAX_FILE_SIZE, { mode: 'jedec' })!

const MAX_FILTER_RULES = 200
const MAX_SECONDS = 86400

const CONFLICT_STRATEGIES = new Set<string>([
	'no-conflict-merge',
	'diff3',
	'local-priority',
	'server-priority',
])
const SYNC_MODES = new Set<string>(['strict', 'loose'])
const CONFIG_DIR_SYNC_MODES = new Set<string>(['none', 'bookmarks', 'all'])
const LANGUAGES = new Set<string>(['zh', 'en', ''])
const FILTER_RULE_TYPES = new Set<string>(['include', 'exclude'])

const WHITELIST_KEYS = new Set([
	'filterRules',
	'skipLargeFiles',
	'startupSyncDelaySeconds',
	'autoSyncIntervalSeconds',
	'realtimeSync',
	'confirmBeforeSync',
	'confirmBeforeDeleteInAutoSync',
	'syncMode',
	'conflictStrategy',
	'configDirSyncMode',
	'language',
	'aiModelLimits',
	'toolTimeoutSeconds',
])

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function jsonError(fieldPath: string, expected: string): string {
	return `invalid setting '${fieldPath}': expected ${expected}`
}

export {
	CONFIG_DIR_SYNC_MODES,
	CONFLICT_STRATEGIES,
	FILTER_RULE_TYPES,
	LANGUAGES,
	MAX_BYTES,
	MAX_FILE_SIZE,
	MAX_FILTER_RULES,
	MAX_SECONDS,
	SYNC_MODES,
	WHITELIST_KEYS,
	isObject,
	jsonError,
	type JsonObject,
}
