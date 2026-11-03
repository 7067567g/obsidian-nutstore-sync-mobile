import { AIProviderConfigs, AIProviderDefinitions } from '~/ai/core/types'
import {
	DEFAULT_RETENTION_POLICY,
	normalizeRetentionPolicy,
	type RetentionPolicy,
} from '~/ai/chat/session/retention-policy'
import type { NutstoreLlmGatewayAuthSettings } from '~/services/nutstore-llm-gateway.service'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import { DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE } from '~/utils/download-chunk-size'
import { GlobFilterRule } from '~/utils/glob-match'

export enum SyncMode {
	STRICT = 'strict',
	LOOSE = 'loose',
}

export enum SyncPolicy {
	TwoWay = 'two-way',
	SendOnly = 'send-only',
	SendOnlyOverrideChanges = 'send-only-override-changes',
	ReceiveOnly = 'receive-only',
	ReceiveOnlyRevertLocalChanges = 'receive-only-revert-local-changes',
}

export type SyncPolicyI18nKey =
	| 'twoWay'
	| 'sendOnly'
	| 'sendOnlyOverrideChanges'
	| 'receiveOnly'
	| 'receiveOnlyRevertLocalChanges'

export type SyncPolicyNameI18nKey =
	| 'settings.syncPolicy.twoWay'
	| 'settings.syncPolicy.sendOnly'
	| 'settings.syncPolicy.sendOnlyOverrideChanges'
	| 'settings.syncPolicy.receiveOnly'
	| 'settings.syncPolicy.receiveOnlyRevertLocalChanges'

export type SyncPolicyDescI18nKey =
	| 'settings.syncPolicy.modal.twoWayDesc'
	| 'settings.syncPolicy.modal.sendOnlyDesc'
	| 'settings.syncPolicy.modal.sendOnlyOverrideChangesDesc'
	| 'settings.syncPolicy.modal.receiveOnlyDesc'
	| 'settings.syncPolicy.modal.receiveOnlyRevertLocalChangesDesc'

export type ConflictStrategyI18nKey =
	| 'noConflictMerge'
	| 'diff3'
	| 'localPriority'
	| 'serverPriority'

export function getConflictStrategyI18nKey(
	strategy: ConflictStrategy,
): ConflictStrategyI18nKey {
	switch (strategy) {
		case ConflictStrategy.NoConflictMerge:
			return 'noConflictMerge'
		case ConflictStrategy.LocalPriority:
			return 'localPriority'
		case ConflictStrategy.ServerPriority:
			return 'serverPriority'
		case ConflictStrategy.Diff3:
		default:
			return 'diff3'
	}
}

export function getSyncPolicyI18nKey(policy: SyncPolicy): SyncPolicyI18nKey {
	switch (policy) {
		case SyncPolicy.SendOnly:
			return 'sendOnly'
		case SyncPolicy.SendOnlyOverrideChanges:
			return 'sendOnlyOverrideChanges'
		case SyncPolicy.ReceiveOnly:
			return 'receiveOnly'
		case SyncPolicy.ReceiveOnlyRevertLocalChanges:
			return 'receiveOnlyRevertLocalChanges'
		case SyncPolicy.TwoWay:
		default:
			return 'twoWay'
	}
}

export function getSyncPolicyNameI18nKey(
	policy: SyncPolicy,
): SyncPolicyNameI18nKey {
	switch (policy) {
		case SyncPolicy.SendOnly:
			return 'settings.syncPolicy.sendOnly'
		case SyncPolicy.SendOnlyOverrideChanges:
			return 'settings.syncPolicy.sendOnlyOverrideChanges'
		case SyncPolicy.ReceiveOnly:
			return 'settings.syncPolicy.receiveOnly'
		case SyncPolicy.ReceiveOnlyRevertLocalChanges:
			return 'settings.syncPolicy.receiveOnlyRevertLocalChanges'
		case SyncPolicy.TwoWay:
		default:
			return 'settings.syncPolicy.twoWay'
	}
}

export function getSyncPolicyDescI18nKey(
	policy: SyncPolicy,
): SyncPolicyDescI18nKey {
	switch (policy) {
		case SyncPolicy.SendOnly:
			return 'settings.syncPolicy.modal.sendOnlyDesc'
		case SyncPolicy.SendOnlyOverrideChanges:
			return 'settings.syncPolicy.modal.sendOnlyOverrideChangesDesc'
		case SyncPolicy.ReceiveOnly:
			return 'settings.syncPolicy.modal.receiveOnlyDesc'
		case SyncPolicy.ReceiveOnlyRevertLocalChanges:
			return 'settings.syncPolicy.modal.receiveOnlyRevertLocalChangesDesc'
		case SyncPolicy.TwoWay:
		default:
			return 'settings.syncPolicy.modal.twoWayDesc'
	}
}

export interface NutstoreSettings {
	account: string
	credential: string
	nutstoreEnterpriseBaseUrl: string
	remoteDir: string
	conflictStrategy: ConflictStrategy
	oauthResponseText: string
	loginMode: 'manual' | 'sso'
	confirmBeforeSync: boolean
	confirmBeforeDeleteInAutoSync: boolean
	syncMode: SyncMode
	filterRules: {
		rules: GlobFilterRule[]
	}
	skipLargeFiles: {
		maxSize: string
	}
	mobileAppDownloadFileChunkSize: string
	realtimeSync: boolean
	startupSyncDelaySeconds: number
	autoSyncIntervalSeconds: number
	language?: 'zh' | 'en'
	/**
	 * #102 data-lifecycle policy for sessions / ops / spill / trash / tmp /
	 * diagnostics. Defaults are conservative; `days: 0` means never by age.
	 */
	retention: RetentionPolicy
	ai: {
		providers: AIProviderConfigs
		defaultModel?: { providerId: string; modelId: string }
		yolo?: boolean
		subagents: {
			explorer: SubagentSettings
			memory: SubagentSettings
		}
		nutstoreLlmGateway?: NutstoreLlmGatewayAuthSettings
		/** Serialized size above which a message's operations move to a sidecar file. */
		maxInlineOperationBytes?: number
		/** Active wall-clock timeout for cooperative tool execution; undefined disables it. */
		toolTimeoutMs?: number
		/** Bash availability: deny = tool hidden, ask = per-operation prompt, always = allow. */
		bashAccess?: 'deny' | 'ask' | 'always'
		/** Context compression backend; deterministic avoids network/model calls. */
		compressionBackend?: 'deterministic' | 'llm'
		/** Mount only the paged tail window for long chat timelines (PERF-01). */
		windowedRendering?: boolean
	}
	configDirSyncMode?: 'none' | 'bookmarks' | 'all'
}

export interface SubagentSettings {
	enabled: boolean
	/** Optional explicit model; an enabled subagent otherwise inherits its caller. */
	model?: { providerId: string; modelId: string }
}

function exclude(expr: string): GlobFilterRule {
	return {
		expr,
		options: {
			caseSensitive: false,
		},
		type: 'exclude',
	}
}

export const DEFAULT_SETTINGS: NutstoreSettings = {
	account: '',
	credential: '',
	nutstoreEnterpriseBaseUrl: '',
	remoteDir: '',
	conflictStrategy: ConflictStrategy.NoConflictMerge,
	oauthResponseText: '',
	loginMode: 'sso',
	confirmBeforeSync: true,
	confirmBeforeDeleteInAutoSync: true,
	syncMode: SyncMode.LOOSE,
	filterRules: {
		rules: [
			'**/*.nutstore-sync-*.download',
			'**/*.nutstore-sync-backup-*',
			'**/*.nutstore-sync-temp-*',
			'**/__MACOSX',
			'**/.DS_Store',
			'**/.env',
			'**/.nomedia',
			'**/.env.*',
			'**/.git',
			'**/.github',
			'**/.gitlab',
			'**/.idea',
			'**/.svn',
			'**/.trash',
			'**/.vscode',
			'**/.codex',
			'**/.opencode',
			'**/.claude',
			'**/.cursor',
			'**/~$*.doc',
			'**/~$*.docx',
			'**/~$*.ppt',
			'**/~$*.pptx',
			'**/~$*.xls',
			'**/~$*.xlsx',
			'**/desktop.ini',
			'**/node_modules',
			'**/Thumbs.db',
		].map(exclude),
	},
	skipLargeFiles: {
		maxSize: '30 MB',
	},
	mobileAppDownloadFileChunkSize: DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE,
	realtimeSync: false,
	startupSyncDelaySeconds: 0,
	autoSyncIntervalSeconds: 300,
	language: undefined,
	retention: normalizeRetentionPolicy(DEFAULT_RETENTION_POLICY),
	ai: {
		providers: {},
		defaultModel: undefined,
		yolo: false,
		subagents: {
			explorer: { enabled: false },
			memory: { enabled: false },
		},
		nutstoreLlmGateway: {},
		maxInlineOperationBytes: 256 * 1024,
		toolTimeoutMs: 120_000,
		bashAccess: 'deny',
		compressionBackend: 'deterministic',
	},
	configDirSyncMode: 'none',
}

export interface NutstoreLocalSettings {
	syncPolicy: SyncPolicy
	ai: {
		presetModels?: AIProviderDefinitions
		presetModelsUpdatedAt?: string
	}
}

export const DEFAULT_LOCAL_SETTINGS: NutstoreLocalSettings = {
	syncPolicy: SyncPolicy.TwoWay,
	ai: {},
}
