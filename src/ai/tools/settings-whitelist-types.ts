import type { NutstoreSettings } from '~/settings'
import type { GlobFilterRule } from '~/utils/glob-match'

/**
 * The subset of plugin settings the AI agent is allowed to read and modify
 * through the virtual settings file under the mountable filesystem.
 *
 * Deliberately excludes credentials (account, credential, oauth response),
 * enterprise base URL, and AI provider secrets.
 */

export type WhitelistFilterRule = {
	expr: string
	type: 'include' | 'exclude'
	caseSensitive?: boolean
	disabled?: boolean
}

export interface AIModelLimitWhitelistEntry {
	providerId: string
	modelId: string
	context?: number
	output?: number
}

export type SettingsWhitelistFile = {
	filterRules?: { rules: WhitelistFilterRule[] }
	skipLargeFiles?: { maxSize?: string }
	startupSyncDelaySeconds?: number
	autoSyncIntervalSeconds?: number
	realtimeSync?: boolean
	confirmBeforeSync?: boolean
	confirmBeforeDeleteInAutoSync?: boolean
	syncMode?: NutstoreSettings['syncMode']
	conflictStrategy?: NutstoreSettings['conflictStrategy']
	configDirSyncMode?: 'none' | 'bookmarks' | 'all'
	language?: 'zh' | 'en' | ''
	aiModelLimits?: AIModelLimitWhitelistEntry[]
	/** Active wall-clock tool timeout in seconds; 0 disables it. */
	toolTimeoutSeconds?: number
	/** Internal permission-modal bridge; not parsed from settings_patch text. */
	bashAccess?: 'deny' | 'ask' | 'always'
}

export type NormalizedSettingsPatch = {
	filterRules?: GlobFilterRule[]
	skipLargeFilesMaxSize?: string
	startupSyncDelaySeconds?: number
	autoSyncIntervalSeconds?: number
	realtimeSync?: boolean
	confirmBeforeSync?: boolean
	confirmBeforeDeleteInAutoSync?: boolean
	syncMode?: NutstoreSettings['syncMode']
	conflictStrategy?: NutstoreSettings['conflictStrategy']
	configDirSyncMode?: 'none' | 'bookmarks' | 'all'
	language?: 'zh' | 'en' | ''
	aiModelLimits?: AIModelLimitWhitelistEntry[]
	toolTimeoutSeconds?: number
	bashAccess?: 'deny' | 'ask' | 'always'
}

export type SettingsParseResult =
	| { ok: true; patch: NormalizedSettingsPatch; text: string }
	| { ok: false; error: string }
