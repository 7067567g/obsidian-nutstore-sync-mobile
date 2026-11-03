import { LlmGatewayClient } from '@nutstore/sso-js'
import { Notice } from 'obsidian'
import { Subscription, timer } from 'rxjs'
import { obsidianFetch } from '~/ai/transport/obsidian-fetch'
import type { AIProviderConfig } from '~/ai/core/types'
import { NUTSTORE_LLM_GATEWAY_PROVIDER_ID } from '~/consts'
import {
	classifyGatewayFailure,
	formatGatewayDegradation,
	type GatewayFailureRecord,
} from '~/diagnostics/degradation'
import { emitNutstoreLlmGatewayAuth } from '~/events/nutstore-llm-gateway-auth'
import logger from '~/utils/logger'
import type NutstorePlugin from '~/index'
import { BaseService } from './service.interface'
import {
	TOKEN_REFRESH_INTERVAL_MS,
	expiresAtFromNow,
	isTokenUsable,
	type OAuthTokenResponse,
} from './nutstore-llm-gateway.types'

export class NutstoreLlmGatewayBase extends BaseService {
	protected readonly client = new LlmGatewayClient({
		fetcher: obsidianFetch,
	})
	protected refreshSubscription: Subscription | null = null
	protected authorizationPollingSubscription: Subscription | null = null
	private lastGatewayFailure?: GatewayFailureRecord

	constructor(protected plugin: NutstorePlugin) {
		super()
	}

	/** Most recent classified gateway failure, consumed by diagnostics (#104). */
	getLastGatewayFailure(): GatewayFailureRecord | undefined {
		return this.lastGatewayFailure
	}

	protected recordGatewayFailure(error: unknown, status?: number) {
		this.lastGatewayFailure = {
			...classifyGatewayFailure(error, { status }),
			at: new Date().toISOString(),
		}
	}

	protected clearGatewayFailure() {
		this.lastGatewayFailure = undefined
	}

	isProviderId(providerId?: string) {
		return providerId === NUTSTORE_LLM_GATEWAY_PROVIDER_ID
	}

	isManagedProvider(provider?: Pick<AIProviderConfig, 'id'>) {
		return this.isProviderId(provider?.id)
	}

	isAuthorized() {
		return !!this.settings.accessToken && !!this.settings.refreshToken
	}

	isAuthorizing() {
		return !!this.settings.pendingAuthorization
	}

	getPendingAuthorization() {
		return this.settings.pendingAuthorization
	}

	protected emitAuthState() {
		emitNutstoreLlmGatewayAuth({
			status: this.isAuthorizing() ? 'authorizing' : 'idle',
		})
	}

	protected async ensureAccessToken(options: { removeOnAuthError?: boolean }) {
		if (isTokenUsable(this.settings.accessTokenExpiresAt)) {
			return this.settings.accessToken
		}
		if (
			!this.settings.refreshToken ||
			!isTokenUsable(this.settings.refreshTokenExpiresAt)
		) {
			if (options.removeOnAuthError) {
				this.clearProviderAndAuth()
			}
			return undefined
		}

		try {
			const token = await this.client.refreshToken({
				refreshToken: this.settings.refreshToken,
			})
			this.applyToken(token)
			return token.access_token
		} catch (error) {
			this.recordGatewayFailure(error)
			if (options.removeOnAuthError) {
				this.clearProviderAndAuth()
			}
			throw error
		}
	}

	protected applyToken(token: OAuthTokenResponse) {
		this.settings.accessToken = token.access_token
		this.settings.refreshToken = token.refresh_token
		this.settings.accessTokenExpiresAt = expiresAtFromNow(token.expires_in)
		this.settings.refreshTokenExpiresAt = expiresAtFromNow(
			token.refresh_expires_in,
		)
	}

	protected clearProviderAndAuth() {
		this.settings.accessToken = undefined
		this.settings.refreshToken = undefined
		this.settings.accessTokenExpiresAt = undefined
		this.settings.refreshTokenExpiresAt = undefined
		this.settings.pendingAuthorization = undefined
		this.disableProviderToken()
		this.stopAuthorizationPolling()
		this.stopTokenRefreshTimer()
		this.emitAuthState()
	}

	protected disableProviderToken() {
		const provider =
			this.plugin.settings.ai.providers[NUTSTORE_LLM_GATEWAY_PROVIDER_ID]
		if (provider) {
			provider.apiKey = ''
		}
	}

	protected startTokenRefreshTimer() {
		if (this.refreshSubscription) {
			return
		}
		this.refreshSubscription = timer(
			TOKEN_REFRESH_INTERVAL_MS,
			TOKEN_REFRESH_INTERVAL_MS,
		).subscribe(() => {
			void this.refreshAccessTokenIfNeeded()
		})
	}

	protected stopTokenRefreshTimer() {
		if (!this.refreshSubscription) {
			return
		}
		this.refreshSubscription.unsubscribe()
		this.refreshSubscription = null
	}

	protected async refreshAccessTokenIfNeeded() {
		if (
			!this.isAuthorized() ||
			isTokenUsable(this.settings.accessTokenExpiresAt)
		) {
			return
		}
		try {
			const token = await this.ensureAccessToken({ removeOnAuthError: true })
			if (!token) {
				await this.plugin.settingsService.saveSettings()
				return
			}
			this.updateProviderApiKey(token)
			await this.plugin.settingsService.saveSettings()
		} catch (error) {
			this.noticeError(error)
			await this.plugin.settingsService.saveSettings()
		}
	}

	protected stopAuthorizationPolling() {
		if (!this.authorizationPollingSubscription) {
			return
		}
		this.authorizationPollingSubscription.unsubscribe()
		this.authorizationPollingSubscription = null
	}

	protected updateProviderApiKey(apiKey: string) {
		const provider =
			this.plugin.settings.ai.providers[NUTSTORE_LLM_GATEWAY_PROVIDER_ID]
		if (provider) {
			provider.apiKey = apiKey
		}
	}

	protected noticeError(error: unknown) {
		logger.error(error)
		this.recordGatewayFailure(error)
		const failure = classifyGatewayFailure(error)
		const message =
			failure.code === 'unknown' && error instanceof Error
				? error.message
				: formatGatewayDegradation(error)
		new Notice(message, 10000)
	}

	protected get settings() {
		this.plugin.settings.ai.nutstoreLlmGateway ??= {}
		return this.plugin.settings.ai.nutstoreLlmGateway
	}
}
