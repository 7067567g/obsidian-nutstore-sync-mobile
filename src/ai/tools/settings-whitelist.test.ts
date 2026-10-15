import { describe, expect, it } from 'vitest'
import {
	applyNormalizedSettingsPatch,
	getChangedSettingsPatch,
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

		const serialized = JSON.parse(
			serializeSettingsWhitelist(settings as never),
		) as {
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

	it('round-trips model limits without inventing 0 for missing values', () => {
		const settings = settingsFixture() as never as {
			ai: {
				providers: Record<
					string,
					{ models: Record<string, { limit: Record<string, number> }> }
				>
			}
		}
		// A model whose limit object omits `output` (custom provider models can).
		delete settings.ai.providers.deepseek.models['deepseek-chat'].limit.output

		const serialized = JSON.parse(serializeSettingsWhitelist(settings as never))
		expect(serialized.aiModelLimits).toEqual([
			{ providerId: 'deepseek', modelId: 'deepseek-chat', context: 256000 },
		])

		const parsed = parseSettingsWhitelistJson(
			serializeSettingsWhitelist(settings as never),
		)
		expect(parsed.ok).toBe(true)
		if (!parsed.ok) return
		// Reading then writing the same file must not report any change; a
		// coerced `output: 0` used to look like an explicit limit change.
		expect(getChangedSettingsPatch(settings as never, parsed.patch)).toEqual({})
	})
})

describe('settings whitelist tool timeout', () => {
	it('parses a tool timeout patch in seconds', () => {
		const parsed = parseSettingsWhitelistJson(
			JSON.stringify({ toolTimeoutSeconds: 5 }),
		)
		expect(parsed.ok).toBe(true)
		if (!parsed.ok) return
		expect(parsed.patch.toolTimeoutSeconds).toBe(5)
	})

	it('applies and serializes the tool timeout without exposing secrets', () => {
		const settings = settingsFixture() as never as {
			ai: { toolTimeoutMs?: number }
		}
		applyNormalizedSettingsPatch(settings as never, { toolTimeoutSeconds: 5 })
		expect(settings.ai.toolTimeoutMs).toBe(5000)
		const serialized = JSON.parse(
			serializeSettingsWhitelist(settings as never),
		) as {
			toolTimeoutSeconds: number
		}
		expect(serialized.toolTimeoutSeconds).toBe(5)
	})

	it('treats 0 as disabling the timeout', () => {
		const settings = settingsFixture() as never as {
			ai: { toolTimeoutMs?: number }
		}
		settings.ai.toolTimeoutMs = 5000
		applyNormalizedSettingsPatch(settings as never, { toolTimeoutSeconds: 0 })
		expect(settings.ai.toolTimeoutMs).toBeUndefined()
	})
})
