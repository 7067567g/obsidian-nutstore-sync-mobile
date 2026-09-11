import { describe, expect, it, vi } from 'vitest'

vi.mock('./permission-guard', () => ({
	withPermissionPurpose: (guard: unknown, purpose: string) => {
		if (typeof guard !== 'function') return undefined
		return (request: Record<string, unknown>) => guard({ ...request, purpose })
	},
}))
import { settingsPatchTool } from './settings-tools'

describe('settings_patch tool', () => {
	it('applies multiple whitelisted settings in one update call', async () => {
		const settings = {} as {
			startupSyncDelaySeconds?: number
			realtimeSync?: boolean
		}
		const updateSettings = vi.fn(async (patch: Record<string, unknown>) => {
			if (patch.startupSyncDelaySeconds !== undefined) {
				settings.startupSyncDelaySeconds =
					patch.startupSyncDelaySeconds as number
			}
			if (patch.realtimeSync !== undefined) {
				settings.realtimeSync = patch.realtimeSync as boolean
			}
		})
		const permissionGuard = vi.fn(async () => {})
		const execute = settingsPatchTool.execute as unknown as (
			params: { purpose: string; patch: Record<string, unknown> },
			options: {
				context: {
					getSettingsSnapshot: () => typeof settings
					updateSettings: typeof updateSettings
					permissionGuard: typeof permissionGuard
				}
				toolCallId: string
			},
		) => Promise<string>

		const result = await execute(
			{
				purpose: 'test settings batch',
				patch: { startupSyncDelaySeconds: 7, realtimeSync: true },
			},
			{
				context: {
					getSettingsSnapshot: () => settings,
					updateSettings,
					permissionGuard,
				},
				toolCallId: 'call-1',
			},
		)

		expect(updateSettings).toHaveBeenCalledTimes(1)
		expect(permissionGuard).toHaveBeenCalledTimes(1)
		expect(updateSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				startupSyncDelaySeconds: 7,
				realtimeSync: true,
			}),
		)
		expect(result).toContain('startupSyncDelaySeconds')
	})
})
