import i18n from '~/i18n'
import type { NormalizedSettingsPatch } from './settings-whitelist-types'

function describeFilterRules(patch: NormalizedSettingsPatch): string {
	const rules = patch.filterRules ?? []
	if (rules.length === 0) {
		return i18n.t('aiPermission.settings.fields.filterRules.empty')
	}
	return rules
		.slice(0, 5)
		.map(
			(rule) =>
				`${rule.type === 'include' ? '+' : '-'} ${rule.expr}${
					rule.disabled === true
						? ` ${i18n.t('aiPermission.settings.fields.filterRules.disabled')}`
						: ''
				}`,
		)
		.join('; ')
}

export function describeSettingsPatch(
	patch: NormalizedSettingsPatch,
): string[] {
	const lines: string[] = []
	if (patch.filterRules !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.filterRules.name')}: ${describeFilterRules(patch)}`,
		)
	}
	if (patch.skipLargeFilesMaxSize !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.skipLargeFiles.name')}: ${patch.skipLargeFilesMaxSize}`,
		)
	}
	if (patch.startupSyncDelaySeconds !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.startupSyncDelay.name')}: ${patch.startupSyncDelaySeconds}s`,
		)
	}
	if (patch.autoSyncIntervalSeconds !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.autoSyncInterval.name')}: ${Math.round(patch.autoSyncIntervalSeconds / 60)}min`,
		)
	}
	if (patch.realtimeSync !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.realtimeSync.name')}: ${i18n.t(patch.realtimeSync ? 'aiPermission.settings.on' : 'aiPermission.settings.off')}`,
		)
	}
	if (patch.confirmBeforeSync !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.confirmBeforeSync.name')}: ${i18n.t(patch.confirmBeforeSync ? 'aiPermission.settings.on' : 'aiPermission.settings.off')}`,
		)
	}
	if (patch.confirmBeforeDeleteInAutoSync !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.confirmBeforeDeleteInAutoSync.name')}: ${i18n.t(patch.confirmBeforeDeleteInAutoSync ? 'aiPermission.settings.on' : 'aiPermission.settings.off')}`,
		)
	}
	if (patch.syncMode !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.syncMode.name')}: ${patch.syncMode}`,
		)
	}
	if (patch.conflictStrategy !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.conflictStrategy.name')}: ${patch.conflictStrategy}`,
		)
	}
	if (patch.configDirSyncMode !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.configDirSyncMode.name')}: ${patch.configDirSyncMode}`,
		)
	}
	if (patch.language !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.language.name')}: ${patch.language === '' ? i18n.t('aiPermission.settings.fields.language.auto') : patch.language}`,
		)
	}
	if (patch.aiModelLimits !== undefined) {
		for (const entry of patch.aiModelLimits.slice(0, 8)) {
			const limits = [
				entry.context !== undefined ? `context=${entry.context}` : '',
				entry.output !== undefined ? `output=${entry.output}` : '',
			]
				.filter(Boolean)
				.join(', ')
			lines.push(
				`${i18n.t('aiPermission.settings.fields.aiModelLimits.name')}: ${entry.providerId}/${entry.modelId} ${limits}`,
			)
		}
	}
	return lines
}
