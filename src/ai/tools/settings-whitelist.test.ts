import { describe, expect, it } from 'vitest'
import {
	applyNormalizedSettingsPatch,
	parseSettingsWhitelistJson,
	serializeSettingsWhitelist,
} from './settings-whitelist'

function settingsFixture() {
	return {
		ai: {
			providers: {
				deepseek: {
					id: 'deepseek',
					name: 'DeepSeek',
					env: [],
					npm: '@ai-sdk/openai-compatible',
					doc: '',
					apiKey: 'secret',
					models: {
						'deepseek-chat': {
							id: 'deepseek-chat',
							name: 'DeepSeek Chat',
							attachment: false,
							reasoning: false,
							tool_call: true,
							release_date: '',
							last_updated: '',
							modalities: { input: ['text'], output: ['text'] },
							open_weights: false,
							limit: { context: 256000, output: 8192 },
						},
					},
				},
			},
		},
	} as never
}

describe('settings whitelist model limits', () => {
	it('parses 1M/256K model limit patches', () => {
		const parsed = parseSettingsWhitelistJson(
			JSON.stringify({
				aiModelLimits: [
					{
						providerId: 'deepseek',
						modelId: 'deepseek-chat',
						context: '1M',
						output: '256K',
					},
				],
			}),
		)

		expect(parsed.ok).toBe(true)
		if (!parsed.ok) return
		expect(parsed.patch.aiModelLimits).toEqual([
			{
				providerId: 'deepseek',
				modelId: 'deepseek-chat',
				context: 1_000_000,
				output: 256_000,
			},
		])
	})

	it('rejects invalid token limit strings', () => {
		const parsed = parseSettingsWhitelistJson(
			JSON.stringify({
				aiModelLimits: [
					{ providerId: 'deepseek', modelId: 'deepseek-chat', context: 'abc' },
				],
			}),
		)
		expect(parsed.ok).toBe(false)
	})

	it('applies and serializes model limits without exposing API keys', () => {
		const settings = settingsFixture()
		applyNormalizedSettingsPatch(settings, {
			aiModelLimits: [
				{
					providerId: 'deepseek',
					modelId: 'deepseek-chat',
					context: 1_000_000,
				},
			],
		})
		expect(
			(
				settings as never as {
					ai: {
						providers: Record<
							string,
							{ models: Record<string, { limit: { context: number } }> }
						>
					}
				}
			).ai.providers.deepseek.models['deepseek-chat'].limit.context,
		).toBe(1_000_000)

		const serialized = JSON.parse(serializeSettingsWhitelist(settings)) as {
			aiModelLimits: Array<Record<string, unknown>>
		}
		expect(serialized.aiModelLimits).toEqual([
			{
				providerId: 'deepseek',
				modelId: 'deepseek-chat',
				context: 1_000_000,
				output: 8192,
			},
		])
		expect(JSON.stringify(serialized)).not.toContain('secret')
	})
})
