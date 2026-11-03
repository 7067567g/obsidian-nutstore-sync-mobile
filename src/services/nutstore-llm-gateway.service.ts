import { Notice } from 'obsidian'
import { timer } from 'rxjs'
import { LLM_GATEWAY_CLIENT_ID } from '~/consts'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import { NutstoreLlmGatewayModels } from './nutstore-llm-gateway.models'
import type {
	NutstoreLlmGatewayPendingAuthorization,
	OAuthTokenResponse,
} from './nutstore-llm-gateway.types'

export type {
	NutstoreLlmGatewayAuthSettings,
	NutstoreLlmGatewayPendingAuthorization,
} from './nutstore-llm-gateway.types'

export default class NutstoreLlmGatewayService extends NutstoreLlmGatewayModels {
	async startAuthorization() {
		if (this.settings.pendingAuthorization) {
			this.resumeAuthorizationPolling()
			return this.settings.pendingAuthorization
		}

		const clientId = LLM_GATEWAY_CLIENT_ID?.trim()
		if (!clientId) {
			throw new Error(
				i18n.t('settings.ai.nutstoreLlmGateway.errors.missingClientId'),
			)
		}

		const deviceAuth = await this.client.createDeviceAuthorization({
			clientId,
		})
		const pendingAuthorization: NutstoreLlmGatewayPendingAuthorization = {
			clientId,
			deviceCode: deviceAuth.device_code,
			userCode: deviceAuth.user_code,
			verificationUri: deviceAuth.verification_uri,
			verificationUrl: this.client.createVerificationUrl({
				verificationUri: deviceAuth.verification_uri,
				userCode: deviceAuth.user_code,
			}),
			intervalMs: deviceAuth.interval * 1000,
			expiresAt: Date.now() + deviceAuth.expires_in * 1000,
		}

		this.settings.pendingAuthorization = pendingAuthorization
		this.emitAuthState()
		await this.plugin.settingsService.saveSettings()
		this.resumeAuthorizationPolling()
		return pendingAuthorization
	}

	async openPendingAuthorizationPage() {
		const pending = this.settings.pendingAuthorization
		if (!pending) {
			throw new Error(
				i18n.t('settings.ai.nutstoreLlmGateway.errors.authorizationRequired'),
			)
		}

		const anchor = createEl('a')
		anchor.href = pending.verificationUrl
		anchor.target = '_blank'
		document.body.appendChild(anchor)
		anchor.click()
		document.body.removeChild(anchor)
	}

	async initializeProviderFromStoredAuth() {
		if (this.settings.pendingAuthorization) {
			if (this.settings.pendingAuthorization.expiresAt <= Date.now()) {
				this.settings.pendingAuthorization = undefined
				await this.plugin.settingsService.saveSettings()
			} else {
				this.emitAuthState()
				this.resumeAuthorizationPolling()
			}
		}

		if (!this.isAuthorized()) {
			this.stopTokenRefreshTimer()
			return
		}
		try {
			const refreshed = await this.refreshModels({ removeOnAuthError: true })
			this.startTokenRefreshTimer()
			if (refreshed) {
				await this.plugin.settingsService.saveSettings()
			}
		} catch (error) {
			this.noticeError(error)
			await this.plugin.settingsService.saveSettings()
			if (this.isAuthorized()) {
				this.startTokenRefreshTimer()
			} else {
				this.stopTokenRefreshTimer()
			}
		}
	}

	async disconnect() {
		await this.cancelPendingAuthorization()
		this.clearProviderAndAuth()
		await this.plugin.settingsService.saveSettings()
		new Notice(i18n.t('settings.ai.nutstoreLlmGateway.disconnected'))
	}

	override onunload() {
		this.stopAuthorizationPolling()
		this.stopTokenRefreshTimer()
	}

	private resumeAuthorizationPolling() {
		if (this.authorizationPollingSubscription) {
			return
		}

		const pending = this.settings.pendingAuthorization
		if (!pending) {
			this.emitAuthState()
			return
		}

		this.emitAuthState()
		this.scheduleDeviceTokenPoll(pending, pending.intervalMs)
	}

	private scheduleDeviceTokenPoll(
		pending: NutstoreLlmGatewayPendingAuthorization,
		pollIntervalMs: number,
	) {
		this.authorizationPollingSubscription?.unsubscribe()
		this.authorizationPollingSubscription = timer(pollIntervalMs).subscribe(
			() => {
				void this.pollDeviceTokenOnce(pending, pollIntervalMs)
			},
		)
	}

	private async pollDeviceTokenOnce(
		pending: NutstoreLlmGatewayPendingAuthorization,
		pollIntervalMs: number,
	) {
		try {
			if (Date.now() >= pending.expiresAt) {
				throw new Error(
					i18n.t('settings.ai.nutstoreLlmGateway.errors.authorizationExpired'),
				)
			}

			const currentPending = this.settings.pendingAuthorization
			if (!currentPending || currentPending.deviceCode !== pending.deviceCode) {
				this.stopAuthorizationPolling()
				this.emitAuthState()
				return
			}

			const result = await this.client.pollDeviceToken({
				deviceCode: pending.deviceCode,
				userCode: pending.userCode,
			})

			if (!result.ok) {
				if (result.error.code === 'authorization_pending') {
					this.scheduleDeviceTokenPoll(pending, pollIntervalMs)
					return
				}
				if (result.error.code === 'slow_down') {
					this.scheduleDeviceTokenPoll(
						pending,
						pollIntervalMs + pending.intervalMs,
					)
					return
				}
				throw new Error(
					i18n.t('settings.ai.nutstoreLlmGateway.errors.authorizationFailed', {
						code: result.error.code,
						message: result.error.message,
					}),
				)
			}

			this.stopAuthorizationPolling()
			await this.finishAuthorization(result.data)
			this.emitAuthState()
		} catch (error) {
			this.stopAuthorizationPolling()
			this.settings.pendingAuthorization = undefined
			await this.plugin.settingsService.saveSettings()
			this.noticeError(error)
			this.emitAuthState()
		}
	}

	private async finishAuthorization(token: OAuthTokenResponse) {
		this.applyToken(token)
		this.settings.pendingAuthorization = undefined
		try {
			await this.refreshModels({ removeOnAuthError: true })
			this.startTokenRefreshTimer()
			new Notice(i18n.t('settings.ai.nutstoreLlmGateway.authorized'))
		} finally {
			await this.plugin.settingsService.saveSettings()
		}
	}

	private async cancelPendingAuthorization() {
		const pending = this.settings.pendingAuthorization
		if (!pending) {
			return
		}

		try {
			await this.client.cancelDeviceAuthorization({
				deviceCode: pending.deviceCode,
			})
		} catch (error) {
			logger.error(error)
		}
	}
}
