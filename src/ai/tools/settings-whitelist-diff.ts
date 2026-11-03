import { parse as bytesParse } from 'bytes-iec'
import type { NutstoreSettings } from '~/settings'
import type { GlobFilterRule } from '~/utils/glob-match'
import type { NormalizedSettingsPatch } from './settings-whitelist-types'

function areFilterRulesEqual(
	currentRules: GlobFilterRule[],
	nextRules: GlobFilterRule[],
) {
	if (currentRules.length !== nextRules.length) {
		return false
	}
	return currentRules.every((currentRule, index) => {
		const nextRule = nextRules[index]
		return (
			currentRule.expr === nextRule.expr &&
			currentRule.type === nextRule.type &&
			currentRule.options.caseSensitive === nextRule.options.caseSensitive &&
			(currentRule.disabled === true) === (nextRule.disabled === true)
		)
	})
}

function areByteSizesEqual(current: string | undefined, next: string) {
	if (current === next) {
		return true
	}
	const currentBytes = current ? bytesParse(current, { mode: 'jedec' }) : null
	const nextBytes = bytesParse(next, { mode: 'jedec' })
	return (
		currentBytes !== null && nextBytes !== null && currentBytes === nextBytes
	)
}

export function getChangedSettingsPatch(
	settings: NutstoreSettings,
	patch: NormalizedSettingsPatch,
): NormalizedSettingsPatch {
	const changes: NormalizedSettingsPatch = {}
	if (
		patch.filterRules !== undefined &&
		!areFilterRulesEqual(settings.filterRules?.rules ?? [], patch.filterRules)
	) {
		changes.filterRules = patch.filterRules
	}
	if (
		patch.skipLargeFilesMaxSize !== undefined &&
		!areByteSizesEqual(
			settings.skipLargeFiles?.maxSize,
			patch.skipLargeFilesMaxSize,
		)
	) {
		changes.skipLargeFilesMaxSize = patch.skipLargeFilesMaxSize
	}
	if (
		patch.startupSyncDelaySeconds !== undefined &&
		patch.startupSyncDelaySeconds !== settings.startupSyncDelaySeconds
	) {
		changes.startupSyncDelaySeconds = patch.startupSyncDelaySeconds
	}
	if (
		patch.autoSyncIntervalSeconds !== undefined &&
		patch.autoSyncIntervalSeconds !== settings.autoSyncIntervalSeconds
	) {
		changes.autoSyncIntervalSeconds = patch.autoSyncIntervalSeconds
	}
	if (
		patch.realtimeSync !== undefined &&
		patch.realtimeSync !== settings.realtimeSync
	) {
		changes.realtimeSync = patch.realtimeSync
	}
	if (
		patch.confirmBeforeSync !== undefined &&
		patch.confirmBeforeSync !== settings.confirmBeforeSync
	) {
		changes.confirmBeforeSync = patch.confirmBeforeSync
	}
	if (
		patch.confirmBeforeDeleteInAutoSync !== undefined &&
		patch.confirmBeforeDeleteInAutoSync !==
			settings.confirmBeforeDeleteInAutoSync
	) {
		changes.confirmBeforeDeleteInAutoSync = patch.confirmBeforeDeleteInAutoSync
	}
	if (patch.syncMode !== undefined && patch.syncMode !== settings.syncMode) {
		changes.syncMode = patch.syncMode
	}
	if (
		patch.conflictStrategy !== undefined &&
		patch.conflictStrategy !== settings.conflictStrategy
	) {
		changes.conflictStrategy = patch.conflictStrategy
	}
	if (
		patch.configDirSyncMode !== undefined &&
		patch.configDirSyncMode !== (settings.configDirSyncMode ?? 'none')
	) {
		changes.configDirSyncMode = patch.configDirSyncMode
	}
	if (
		patch.language !== undefined &&
		patch.language !== (settings.language ?? '')
	) {
		changes.language = patch.language
	}
	if (patch.toolTimeoutSeconds !== undefined) {
		const currentToolTimeout = settings.ai?.toolTimeoutMs
			? Math.round(settings.ai.toolTimeoutMs / 1000)
			: 0
		if (patch.toolTimeoutSeconds !== currentToolTimeout) {
			changes.toolTimeoutSeconds = patch.toolTimeoutSeconds
		}
	}
	if (patch.aiModelLimits !== undefined) {
		const changedLimits = patch.aiModelLimits.filter((entry) => {
			const model =
				settings.ai?.providers?.[entry.providerId]?.models?.[entry.modelId]
			if (!model) return true
			return (
				(entry.context !== undefined &&
					entry.context !== model.limit?.context) ||
				(entry.output !== undefined && entry.output !== model.limit?.output)
			)
		})
		if (changedLimits.length > 0) {
			changes.aiModelLimits = changedLimits
		}
	}
	return changes
}
