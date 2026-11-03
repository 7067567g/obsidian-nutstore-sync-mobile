import type { AIModelInput, AIModelModality } from '~/ai/core/types'

export const TOKEN_REFRESH_SKEW_MS = 60 * 1000
export const TOKEN_REFRESH_INTERVAL_MS = 60 * 1000

export type NutstoreLlmGatewayModelApi = 'openai-completions'
export type NutstoreLlmGatewayThinkingFormat = 'openrouter' | 'openai'

export interface NutstoreLlmGatewayModelCost {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
}

export interface NutstoreLlmGatewayModelCompat {
	thinkingFormat: NutstoreLlmGatewayThinkingFormat
	supportsReasoningEffort: boolean
}

export interface NutstoreLlmGatewayModel {
	id: string
	name: string
	description: string
	api: NutstoreLlmGatewayModelApi
	reasoning: boolean
	input: AIModelModality[]
	cost: NutstoreLlmGatewayModelCost
	contextWindow: number
	maxTokens: number
	compat: NutstoreLlmGatewayModelCompat
}

export interface ModelsResponse {
	object: 'list'
	data: NutstoreLlmGatewayModel[]
}

export interface NutstoreLlmGatewayAuthSettings {
	accessToken?: string
	refreshToken?: string
	accessTokenExpiresAt?: number
	refreshTokenExpiresAt?: number
	pendingAuthorization?: NutstoreLlmGatewayPendingAuthorization
}

export interface OAuthTokenResponse {
	access_token: string
	refresh_token: string
	expires_in?: number
	refresh_expires_in?: number
}

export interface NutstoreLlmGatewayPendingAuthorization {
	clientId: string
	deviceCode: string
	userCode: string
	verificationUri: string
	verificationUrl: string
	intervalMs: number
	expiresAt: number
}

export function expiresAtFromNow(seconds: number | undefined) {
	return Date.now() + Math.max(0, seconds || 0) * 1000
}

export function isAuthError(status: number) {
	return status === 401 || status === 403
}

export function isTokenUsable(expiresAt?: number) {
	return !!expiresAt && expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS
}

export function toModelConfig(model: NutstoreLlmGatewayModel): AIModelInput {
	return {
		id: model.id,
		name: model.name,
		attachment: false,
		reasoning: model.reasoning,
		tool_call: true,
		temperature: true,
		knowledge: model.description,
		release_date: '',
		last_updated: '',
		modalities: {
			input: model.input,
			output: ['text'],
		},
		open_weights: false,
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cache_read: model.cost.cacheRead,
			cache_write: model.cost.cacheWrite,
		},
		limit: {
			context: model.contextWindow,
			output: model.maxTokens,
		},
		provider: {
			shape: 'completions',
		},
		experimental: {
			nutstoreLlmGateway: {
				api: model.api,
				compat: model.compat,
			},
		},
	}
}
