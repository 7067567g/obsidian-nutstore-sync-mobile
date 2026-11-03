import { describe, expect, it } from 'vitest'
import * as events from './index'

/**
 * P9 export-contract lock for the `~/events` barrel.
 *
 * The barrel had three modules that were not re-exported
 * (`gc-progress`, `nutstore-llm-gateway-auth`, `sso-receive`). This test
 * freezes the completed surface so later slices can rely on the barrel.
 */
describe('events barrel export contract', () => {
	const expected = [
		'onGcProgress',
		'emitGcProgress',
		'onNutstoreLlmGatewayAuth',
		'emitNutstoreLlmGatewayAuth',
		'onSsoReceive',
		'emitSsoReceive',
		'onStopGc',
		'emitStopGc',
		'onVaultEvent',
		'emitVaultEvent',
	] as const

	it('re-exports the public event emitters, including the previously missing modules', () => {
		for (const name of expected) {
			expect(typeof (events as Record<string, unknown>)[name]).toBe('function')
		}
	})
})
