import type { LanguageModel } from 'ai'
import type { AIProviderConfig } from '~/ai/core/types'
import type { ProviderRequestContext } from '~/ai/transport/provider-fetch'

export interface ResolvedLanguageModel {
	model: LanguageModel
	providerName: string
}

export interface AIProviderResolver {
	assertUsable: (provider: AIProviderConfig) => void
	createLanguageModel: (
		provider: AIProviderConfig,
		modelId: string,
		context?: ProviderRequestContext,
	) => ResolvedLanguageModel
}
