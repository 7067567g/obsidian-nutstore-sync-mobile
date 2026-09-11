import { tool } from 'ai'
import { z } from 'zod/mini'
import {
	describeSettingsPatch,
	getChangedSettingsPatch,
	parseSettingsWhitelistJson,
	serializeSettingsWhitelist,
} from './settings-whitelist'
import {
	getSettingsSnapshotDep,
	permissionGuardDep,
	updateSettingsDep,
} from './tool-context'
import { withPermissionPurpose } from './permission-guard'

export const settingsReadTool = tool({
	description: [
		'Read the AI-visible whitelist of nutstore-sync plugin settings as JSON.',
		'Credentials, secrets, and enterprise base URLs are never included.',
		'Use this instead of bash jq on /.config/nutstore-sync/settings.json.',
	].join(' '),
	inputSchema: z.object({}),
	contextSchema: z.object({
		getSettingsSnapshot: getSettingsSnapshotDep,
	}),
	outputSchema: z.string(),
	execute: async (_params, { context }) => {
		if (!context.getSettingsSnapshot) {
			throw new Error('Settings are not available in this tool context.')
		}
		return serializeSettingsWhitelist(context.getSettingsSnapshot())
	},
})

export const settingsPatchTool = tool({
	description: [
		'Apply a batch patch to the whitelisted nutstore-sync settings in one transaction.',
		'Prefer this over repeated bash jq writes. The patch is validated against the same whitelist as the virtual settings file.',
		'Include only fields that need changing. Unknown, secret, or read-only fields are rejected.',
	].join(' '),
	inputSchema: z.object({
		purpose: z.string(),
		patch: z.record(z.string(), z.unknown()),
	}),
	contextSchema: z.object({
		getSettingsSnapshot: getSettingsSnapshotDep,
		permissionGuard: permissionGuardDep,
		updateSettings: updateSettingsDep,
	}),
	outputSchema: z.string(),
	execute: async ({ purpose, patch }, { context }) => {
		if (!context.getSettingsSnapshot || !context.updateSettings) {
			throw new Error('Settings are not writable in this tool context.')
		}
		const parsed = parseSettingsWhitelistJson(JSON.stringify(patch))
		if (!parsed.ok) {
			throw new Error(parsed.error)
		}
		const changes = getChangedSettingsPatch(
			context.getSettingsSnapshot(),
			parsed.patch,
		)
		const keys = Object.keys(changes)
		if (keys.length === 0) {
			return 'No settings changed.'
		}
		const summary =
			describeSettingsPatch(changes).join('\n') || 'Update plugin settings'
		const guard = withPermissionPurpose(context.permissionGuard, purpose)
		await guard?.({
			type: 'settings',
			settings: {
				action: 'update',
				summary,
				changes,
			},
		})
		await context.updateSettings(changes)
		return `Updated settings: ${keys.join(', ')}`
	},
})
