import { describe, expect, it } from 'vitest'
import {
	getChangedSettingsPatch,
	parseSettingsWhitelistJson,
	serializeSettingsWhitelist,
} from './settings-whitelist'

/**
 * A01 regression: the serialized settings file must round-trip through
 * `parseSettingsWhitelistJson` + `getChangedSettingsPatch` without reporting a
 * change. Two defects used to break that:
 *  - `skipLargeFiles` was always emitted, even as `{}` when no maxSize was set,
 *    so parsing the file the plugin itself wrote failed with EINVAL;
 *  - model limits missing `context`/`output` were coerced to `0`, which looked
 *    like an explicit limit change and would overwrite the real value.
 */
function settingsFixture() {
	return {
		filterRules: { rules: [] },
		startupSyncDelaySeconds: 0,
		autoSyncIntervalSeconds: 300,
		realtimeSync: false,
		confirmBeforeSync: true,
		confirmBeforeDeleteInAutoSync: true,
		syncMode: 'loose',
		conflictStrategy: 'no-conflict-merge',
		configDirSyncMode: 'none',
		language: undefined,
		ai: {
			providers: {
				deepseek: {
					models: {
						'deepseek-chat': {
							limit: { context: 256000, output: 8192 },
						},
						'no-limit-model': {},
					},
				},
			},
		},
	} as never
}

type MutableFixture = {
	ai: {
		providers: Record<
			string,
			{
				models: Record<string, { limit: Record<string, number> }>
			}
		>
	}
}

describe('settings whitelist serialization idempotency (A01)', () => {
	it('omits skipLargeFiles without a maxSize and parses back to no changes', () => {
		const settings = settingsFixture()

		const text = serializeSettingsWhitelist(settings)
		expect(text).not.toContain('skipLargeFiles')

		const parsed = parseSettingsWhitelistJson(text)
		expect(parsed.ok).toBe(true)
		if (!parsed.ok) return
		expect(getChangedSettingsPatch(settings, parsed.patch)).toEqual({})
	})

	it('does not invent 0 for a missing model limit field', () => {
		const settings = settingsFixture() as unknown as MutableFixture
		delete settings.ai.providers.deepseek.models['deepseek-chat'].limit.output

		const serialized = JSON.parse(
			serializeSettingsWhitelist(settings as never),
		) as { aiModelLimits: Array<Record<string, unknown>> }
		expect(serialized.aiModelLimits).toEqual([
			{
				providerId: 'deepseek',
				modelId: 'deepseek-chat',
				context: 256000,
			},
		])

		const parsed = parseSettingsWhitelistJson(
			serializeSettingsWhitelist(settings as never),
		)
		expect(parsed.ok).toBe(true)
		if (!parsed.ok) return
		// A coerced `output: 0` used to look like an explicit limit change.
		expect(getChangedSettingsPatch(settings as never, parsed.patch)).toEqual({})
	})

	it('drops entries for models without any limit instead of writing 0/0', () => {
		const serialized = JSON.parse(
			serializeSettingsWhitelist(settingsFixture()),
		) as { aiModelLimits: Array<Record<string, unknown>> }
		expect(serialized.aiModelLimits).toEqual([
			{
				providerId: 'deepseek',
				modelId: 'deepseek-chat',
				context: 256000,
				output: 8192,
			},
		])
	})
})
