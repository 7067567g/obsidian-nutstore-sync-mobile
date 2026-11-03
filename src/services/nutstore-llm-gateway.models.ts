import {
	createModelConfig,
	sanitizeDefaultSelections,
} from '~/ai/catalog/config'
import type { AIModelConfig, AIProviderConfig } from '~/ai/core/types'
import { NUTSTORE_LLM_GATEWAY_PROVIDER_ID } from '~/consts'
import { obsidianFetch } from '~/ai/transport/obsidian-fetch'
import { formatGatewayDegradation } from '~/diagnostics/degradation'
import i18n from '~/i18n'
import { NutstoreLlmGatewayBase } from './nutstore-llm-gateway.base'
import {
	isAuthError,
	toModelConfig,
	type ModelsResponse,
} from './nutstore-llm-gateway.types'

export class NutstoreLlmGatewayModels extends NutstoreLlmGatewayBase {
	async refreshModels(options: { removeOnAuthError?: boolean } = {}) {
		const token = await this.ensureAccessToken(options)
		if (!token) {
			return false
		}

		const endpoints = this.client.getLlmGatewayEndpoints()
		let response: Response
		try {
			response = await obsidianFetch(endpoints.models, {
				method: 'GET',
				headers: { Authorization: `Bearer ${token}` },
			})
		} catch (error) {
			this.recordGatewayFailure(error)
			throw new Error(formatGatewayDegradation(error), { cause: error })
		}
		if (!response.ok) {
			const failure = new Error(`HTTP ${response.status}`)
			this.recordGatewayFailure(failure, response.status)
			if (isAuthError(response.status) && options.removeOnAuthError) {
				this.clearProviderAndAuth()
			}
			throw new Error(
				formatGatewayDegradation(failure, {
					status: response.status,
				}),
			)
		}

		const payload = (await response.json()) as ModelsResponse
		const models = Object.fromEntries(
			payload.data
				.map((model) => ({
					...model,
					id: model.id.trim(),
					name: model.name.trim(),
				}))
				.filter((model) => !!model.id)
				.map((model) => [model.id, createModelConfig(toModelConfig(model))]),
		)

		if (Object.keys(models).length === 0) {
			throw new Error(
				i18n.t('settings.ai.nutstoreLlmGateway.errors.emptyModels'),
			)
		}

		this.plugin.settings.ai.providers = {
			...this.plugin.settings.ai.providers,
			[NUTSTORE_LLM_GATEWAY_PROVIDER_ID]: this.createProvider(token, models),
		}
		this.plugin.settings.ai.defaultModel = sanitizeDefaultSelections(
			this.plugin.settings.ai.providers,
			this.plugin.settings.ai.defaultModel,
		)
		this.clearGatewayFailure()
		return true
	}

	async ensureProviderReady(provider?: AIProviderConfig) {
		if (!this.isProviderId(provider?.id)) {
			return
		}
		const previousAccessToken = this.settings.accessToken
		const token = await this.ensureAccessToken({ removeOnAuthError: true })
		if (!token) {
			throw new Error(
				i18n.t('settings.ai.nutstoreLlmGateway.errors.authorizationRequired'),
			)
		}
		this.updateProviderApiKey(token)
		if (provider) {
			provider.apiKey = token
		}
		if (token !== previousAccessToken) {
			await this.plugin.settingsService.saveSettings()
		}
	}

	private createProvider(
		accessToken: string,
		models: Record<string, AIModelConfig>,
	): AIProviderConfig {
		const endpoints = this.client.getLlmGatewayEndpoints()
		return {
			id: NUTSTORE_LLM_GATEWAY_PROVIDER_ID,
			env: [],
			npm: '@ai-sdk/openai-compatible',
			api: endpoints.openaiCompatibleBaseUrl,
			name: i18n.t('settings.ai.nutstoreLlmGateway.providerName'),
			doc: '',
			apiKey: accessToken,
			allowBrowserCors: true,
			models,
		}
	}
}
