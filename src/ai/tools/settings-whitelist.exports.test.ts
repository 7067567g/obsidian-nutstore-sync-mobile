import { describe, expect, it } from 'vitest'
import * as settingsWhitelist from './settings-whitelist'

/**
 * Export-contract lock for `~/ai/tools/settings-whitelist` after the
 * mechanical split into `settings-whitelist-*` modules. The public entry
 * point must keep exposing the same callables.
 */
describe('settings-whitelist export contract', () => {
	const expected = [
		'applyNormalizedSettingsPatch',
		'parseSettingsWhitelistJson',
		'serializeSettingsWhitelist',
		'getChangedSettingsPatch',
		'describeSettingsPatch',
	] as const

	it('exposes the public functions from the barrel', () => {
		for (const name of expected) {
			expect(typeof (settingsWhitelist as Record<string, unknown>)[name]).toBe(
				'function',
			)
		}
	})
})
