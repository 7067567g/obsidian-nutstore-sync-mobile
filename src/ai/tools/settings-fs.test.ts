import { describe, expect, it, vi } from 'vitest'
import { SettingsFs } from './settings-fs'

function settingsFixture() {
	return {
		filterRules: { rules: [] },
		skipLargeFiles: { maxSize: '30 MB' },
		startupSyncDelaySeconds: 0,
		autoSyncIntervalSeconds: 300,
		realtimeSync: false,
		confirmBeforeSync: true,
		confirmBeforeDeleteInAutoSync: true,
		syncMode: 'loose',
		conflictStrategy: 'no-conflict-merge',
		configDirSyncMode: 'none',
		language: undefined,
		ai: { providers: {} },
	} as never
}

describe('SettingsFs write behaviour (A03)', () => {
	it('treats a whole-file rewrite that matches current settings as a no-op', async () => {
		const settings = settingsFixture()
		const permissionGuard = vi.fn(async () => {})
		const updateSettings = vi.fn(async () => {})
		const fs = new SettingsFs({
			getSettings: () => settings,
			updateSettings,
			permissionGuard,
		})

		const serialized = await fs.readFile('/settings.json')
		await fs.writeFile('/settings.json', serialized)

		expect(permissionGuard).not.toHaveBeenCalled()
		expect(updateSettings).not.toHaveBeenCalled()
	})

	it('fails closed without a guard and without an unguardedWrite declaration', async () => {
		const settings = settingsFixture()
		const updateSettings = vi.fn(async () => {})
		const fs = new SettingsFs({
			getSettings: () => settings,
			updateSettings,
		})

		await expect(
			fs.writeFile(
				'/settings.json',
				JSON.stringify({ startupSyncDelaySeconds: 7 }),
			),
		).rejects.toThrow('EPERM')
		expect(updateSettings).not.toHaveBeenCalled()
	})

	it('allows writes that declare an explicit unguardedWrite reason', async () => {
		const settings = settingsFixture()
		const updateSettings = vi.fn(async () => {})
		const fs = new SettingsFs({
			getSettings: () => settings,
			updateSettings,
			unguardedWrite: 'integration-harness',
		})

		await fs.writeFile(
			'/settings.json',
			JSON.stringify({ startupSyncDelaySeconds: 7 }),
		)

		expect(updateSettings).toHaveBeenCalledWith({
			startupSyncDelaySeconds: 7,
		})
	})

	it('prompts once and persists only the changed fields', async () => {
		const settings = settingsFixture()
		const permissionGuard = vi.fn(async () => {})
		const updateSettings = vi.fn(async () => {})
		const fs = new SettingsFs({
			getSettings: () => settings,
			updateSettings,
			permissionGuard,
		})

		await fs.writeFile(
			'/settings.json',
			JSON.stringify({ startupSyncDelaySeconds: 7 }),
		)

		expect(permissionGuard).toHaveBeenCalledTimes(1)
		expect(updateSettings).toHaveBeenCalledTimes(1)
		expect(updateSettings).toHaveBeenCalledWith({
			startupSyncDelaySeconds: 7,
		})
	})
})
