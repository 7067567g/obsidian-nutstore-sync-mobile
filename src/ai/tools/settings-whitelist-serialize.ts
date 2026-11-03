import type { NutstoreSettings } from '~/settings'
import type {
	AIModelLimitWhitelistEntry,
	SettingsWhitelistFile,
} from './settings-whitelist-types'

export function serializeSettingsWhitelist(settings: NutstoreSettings): string {
	const file: SettingsWhitelistFile = {
		filterRules: {
			rules: (settings.filterRules?.rules ?? []).map((rule) => ({
				expr: rule.expr,
				type: rule.type,
				caseSensitive: rule.options.caseSensitive === true,
				disabled: rule.disabled === true ? true : undefined,
			})),
		},
		...(settings.skipLargeFiles?.maxSize
			? { skipLargeFiles: { maxSize: settings.skipLargeFiles.maxSize } }
			: {}),
		startupSyncDelaySeconds: settings.startupSyncDelaySeconds,
		autoSyncIntervalSeconds: settings.autoSyncIntervalSeconds,
		realtimeSync: settings.realtimeSync,
		confirmBeforeSync: settings.confirmBeforeSync,
		confirmBeforeDeleteInAutoSync: settings.confirmBeforeDeleteInAutoSync,
		syncMode: settings.syncMode,
		conflictStrategy: settings.conflictStrategy,
		configDirSyncMode: settings.configDirSyncMode ?? 'none',
		language: settings.language ?? '',
		toolTimeoutSeconds: settings.ai?.toolTimeoutMs
			? Math.round(settings.ai.toolTimeoutMs / 1000)
			: 0,
		aiModelLimits: Object.entries(settings.ai?.providers ?? {}).flatMap(
			([providerId, provider]) =>
				Object.entries(provider.models ?? {}).flatMap(([modelId, model]) => {
					const limit = model.limit ?? {}
					const entry: AIModelLimitWhitelistEntry = { providerId, modelId }
					if (typeof limit.context === 'number') {
						entry.context = limit.context
					}
					if (typeof limit.output === 'number') {
						entry.output = limit.output
					}
					// Never coerce a missing limit to 0: a 0 read back would be
					// treated as an explicit change and overwrite the model's real
					// limit on the next write (read→write must stay idempotent).
					return entry.context === undefined && entry.output === undefined
						? []
						: [entry]
				}),
		),
	}
	return `${JSON.stringify(file, null, 2)}\n`
}
