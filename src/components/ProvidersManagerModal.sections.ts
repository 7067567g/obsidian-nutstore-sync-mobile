import { cloneDeep } from 'lodash-es'
import { Notice, Setting, setIcon } from 'obsidian'
import {
	createModelConfig,
	listMissingPresetModelsForProvider,
	listModels,
	listProviders,
} from '~/ai/catalog/config'
import { AIProviderConfig } from '~/ai/core/types'
import { getProviderDefaultBaseURL } from '~/ai/providers/defaults'
import { NUTSTORE_LLM_GATEWAY_PROVIDER_ID } from '~/consts'
import i18n from '~/i18n'
import type { ModelsPresetRefreshResult } from '~/services/models-preset.service'
import {
	addClassTokens,
	removeClassTokens,
	toggleClassTokens,
} from '~/utils/class-tokens'
import logger from '~/utils/logger'
import type NutstorePlugin from '~/index'
import NutstoreLlmGatewayBetaConfirmModal from './NutstoreLlmGatewayBetaConfirmModal'
import ProviderEditorModal from './ProviderEditorModal'
import ProviderModelsUpdateConfirmModal from './ProviderModelsUpdateConfirmModal'

export const CUSTOM_OPTION = '__custom__'

export type PresetModelsRefreshState = 'idle' | 'loading' | 'success' | 'error'

export interface PresetModelsRefreshSummary {
	providersDelta: number
	modelsDelta: number
}

/** Mutating callbacks shared by the extracted manager sections. */
export interface ProvidersManagerContext {
	plugin: NutstorePlugin
	contentEl: HTMLElement
	render: () => void
	onChanged: () => Promise<void> | void
}

function formatSignedDelta(value: number) {
	if (value >= 0) {
		return `+${value}`
	}
	return `${value}`
}

function getPresetRefreshButtonText(
	state: PresetModelsRefreshState,
	summary: PresetModelsRefreshSummary,
) {
	switch (state) {
		case 'loading':
			return i18n.t('settings.ai.providers.refreshPresetModelsLoading')
		case 'success':
			return i18n.t('settings.ai.providers.refreshPresetModelsSuccess', {
				providers: formatSignedDelta(summary.providersDelta),
				models: formatSignedDelta(summary.modelsDelta),
			})
		case 'error':
			return i18n.t('settings.ai.providers.refreshPresetModelsFailure')
		default:
			return i18n.t('settings.ai.providers.refreshPresetModels')
	}
}

function applyPresetRefreshButtonState(
	buttonEl: HTMLElement,
	state: PresetModelsRefreshState,
) {
	toggleClassTokens(buttonEl, ':uno: connection-button', state !== 'idle')
	toggleClassTokens(buttonEl, ':uno: loading', state === 'loading')
	toggleClassTokens(buttonEl, ':uno: opacity-50', state === 'loading')
	toggleClassTokens(buttonEl, ':uno: pointer-events-none', state === 'loading')
	toggleClassTokens(buttonEl, ':uno: success', state === 'success')
	toggleClassTokens(buttonEl, ':uno: mod-warning', state === 'error')
}

export function createPresetRefreshSetting(options: {
	contentEl: HTMLElement
	getState: () => PresetModelsRefreshState
	getSummary: () => PresetModelsRefreshSummary
	setState: (state: PresetModelsRefreshState) => void
	setSummary: (summary: PresetModelsRefreshSummary) => void
	refresh: () => Promise<ModelsPresetRefreshResult>
	render: () => void
}): void {
	const {
		contentEl,
		getState,
		getSummary,
		setState,
		setSummary,
		refresh,
		render,
	} = options

	new Setting(contentEl)
		.setName(i18n.t('settings.ai.providers.refreshPresetName'))
		.setDesc(i18n.t('settings.ai.providers.refreshPresetDesc'))
		.addButton((button) => {
			button
				.setButtonText(getPresetRefreshButtonText(getState(), getSummary()))
				.setDisabled(getState() === 'loading')

			applyPresetRefreshButtonState(button.buttonEl, getState())

			button.onClick(async () => {
				if (getState() === 'loading') {
					return
				}
				setState('loading')
				setSummary({
					providersDelta: 0,
					modelsDelta: 0,
				})
				render()
				try {
					const result = await refresh()
					setState(result.success ? 'success' : 'error')
					setSummary({
						providersDelta: result.providersDelta,
						modelsDelta: result.modelsDelta,
					})
					if (!result.success) {
						new Notice(
							result.errorMessage
								? i18n.t(
										'settings.ai.providers.presetModelsRefreshFailedWithReason',
										{ reason: result.errorMessage },
									)
								: i18n.t('settings.ai.providers.presetModelsRefreshFailed'),
							10000,
						)
					}
				} catch (error) {
					logger.error(error)
					setState('error')
					new Notice(
						error instanceof Error
							? i18n.t(
									'settings.ai.providers.presetModelsRefreshFailedWithReason',
									{ reason: error.message },
								)
							: i18n.t('settings.ai.providers.presetModelsRefreshFailed'),
						10000,
					)
				} finally {
					render()
				}
			})
		})
}

export function validateProviderKey(
	plugin: NutstorePlugin,
	provider: AIProviderConfig,
	currentId?: string,
): boolean {
	if (!provider.id) {
		new Notice(i18n.t('settings.ai.errors.emptyProviderId'))
		return false
	}
	if (plugin.nutstoreLlmGatewayService.isProviderId(provider.id)) {
		new Notice(i18n.t('settings.ai.errors.reservedProviderId'))
		return false
	}
	const existing = plugin.settings.ai.providers[provider.id]
	if (existing && existing.id !== currentId) {
		new Notice(i18n.t('settings.ai.errors.duplicateProviderId'))
		return false
	}
	return true
}

export async function deleteProvider(
	ctx: Pick<ProvidersManagerContext, 'plugin' | 'render' | 'onChanged'>,
	provider: AIProviderConfig,
): Promise<void> {
	try {
		const { [provider.id]: _deleted, ...providers } =
			ctx.plugin.settings.ai.providers
		ctx.plugin.settings.ai.providers = providers
		await ctx.onChanged()
		new Notice(i18n.t('settings.ai.modals.provider.deleted'))
		ctx.render()
	} catch (error) {
		logger.error(error)
		new Notice(
			error instanceof Error
				? error.message
				: i18n.t('settings.ai.errors.saveFailed'),
		)
	}
}

export async function addMissingPresetModels(
	ctx: Pick<ProvidersManagerContext, 'plugin' | 'render' | 'onChanged'>,
	provider: AIProviderConfig,
	models: AIProviderConfig['models'][string][],
): Promise<void> {
	try {
		const existing = ctx.plugin.settings.ai.providers[provider.id]
		if (!existing) return
		const mergedModels = { ...existing.models }
		for (const model of models) {
			mergedModels[model.id] = createModelConfig(cloneDeep(model), model.id)
		}
		ctx.plugin.settings.ai.providers = {
			...ctx.plugin.settings.ai.providers,
			[provider.id]: {
				...existing,
				models: mergedModels,
			},
		}
		await ctx.onChanged()
		new Notice(
			i18n.t('settings.ai.providers.updateModelsSuccess', {
				count: models.length,
			}),
		)
		ctx.render()
	} catch (error) {
		logger.error(error)
		new Notice(
			error instanceof Error
				? error.message
				: i18n.t('settings.ai.errors.saveFailed'),
		)
	}
}

export function renderNutstoreGatewaySection(ctx: {
	plugin: NutstorePlugin
	contentEl: HTMLElement
	render: () => void
}): void {
	const { plugin, contentEl, render } = ctx
	const isAuthorized = plugin.nutstoreLlmGatewayService.isAuthorized()
	const isAuthorizing = plugin.nutstoreLlmGatewayService.isAuthorizing()
	const pendingAuthorization =
		plugin.nutstoreLlmGatewayService.getPendingAuthorization()
	const provider =
		plugin.settings.ai.providers[NUTSTORE_LLM_GATEWAY_PROVIDER_ID]
	const modelsCount = listModels(provider).length

	const setting = new Setting(contentEl)
		.setName(i18n.t('settings.ai.nutstoreLlmGateway.name'))
		.setDesc(
			isAuthorized
				? i18n.t('settings.ai.nutstoreLlmGateway.connectedDesc', {
						count: modelsCount,
					})
				: pendingAuthorization
					? i18n.t('settings.ai.nutstoreLlmGateway.pendingDesc', {
							code: pendingAuthorization.userCode,
						})
					: i18n.t('settings.ai.nutstoreLlmGateway.desc'),
		)

	if (!isAuthorized) {
		setting.addButton((button) => {
			button
				.setButtonText(
					isAuthorizing
						? i18n.t('settings.ai.nutstoreLlmGateway.authorizing')
						: i18n.t('settings.ai.nutstoreLlmGateway.authorize'),
				)
				.setDisabled(isAuthorizing)
			if (isAuthorizing) {
				addClassTokens(
					button.buttonEl,
					':uno: connection-button',
					':uno: loading',
					':uno: opacity-50',
					':uno: pointer-events-none',
				)
				return
			}
			button.onClick(() => {
				new NutstoreLlmGatewayBetaConfirmModal(plugin.app, async () => {
					try {
						await plugin.nutstoreLlmGatewayService.startAuthorization()
						await plugin.nutstoreLlmGatewayService.openPendingAuthorizationPage()
						render()
					} catch (error) {
						logger.error(error)
						new Notice(
							error instanceof Error
								? error.message
								: i18n.t('settings.login.failure'),
							10000,
						)
					}
				}).open()
			})
		})
		if (pendingAuthorization) {
			setting.addButton((button) =>
				button
					.setButtonText(
						i18n.t('settings.ai.nutstoreLlmGateway.openAuthorizationPage'),
					)
					.onClick(async () => {
						try {
							await plugin.nutstoreLlmGatewayService.openPendingAuthorizationPage()
						} catch (error) {
							logger.error(error)
							new Notice(
								error instanceof Error
									? error.message
									: i18n.t('settings.login.failure'),
								10000,
							)
						}
					}),
			)
			setting.addButton((button) => {
				button.buttonEl.addClass('mod-warning')
				button
					.setButtonText(
						i18n.t('settings.ai.nutstoreLlmGateway.cancelAuthorization'),
					)
					.onClick(async () => {
						await plugin.nutstoreLlmGatewayService.disconnect()
						render()
					})
			})
		}
		return
	}

	setting
		.addButton((button) =>
			button
				.setButtonText(i18n.t('settings.ai.nutstoreLlmGateway.refreshModels'))
				.onClick(async () => {
					try {
						await plugin.nutstoreLlmGatewayService.refreshModels({
							removeOnAuthError: true,
						})
						await plugin.settingsService.saveSettings()
						render()
					} catch (error) {
						logger.error(error)
						new Notice(
							error instanceof Error
								? error.message
								: i18n.t('settings.ai.nutstoreLlmGateway.errors.refreshFailed'),
							10000,
						)
					}
				}),
		)
		.addButton((button) => {
			let confirmDisconnect = false

			const resetButton = () => {
				confirmDisconnect = false
				button.buttonEl.empty()
				setIcon(button.buttonEl, 'trash')
				removeClassTokens(button.buttonEl, ':uno: mod-warning')
			}

			button.setIcon('trash').onClick(async () => {
				if (!confirmDisconnect) {
					confirmDisconnect = true
					button.buttonEl.empty()
					button.buttonEl.createSpan({
						text: i18n.t('settings.ai.modals.confirmDeleteLabel'),
					})
					addClassTokens(button.buttonEl, ':uno: mod-warning')
					return
				}
				await plugin.nutstoreLlmGatewayService.disconnect()
				render()
			})

			button.buttonEl.addEventListener('blur', resetButton)
		})
}

export function renderProvidersList(ctx: ProvidersManagerContext): void {
	const { plugin, contentEl, render, onChanged } = ctx
	const providers = listProviders(plugin.settings.ai.providers).filter(
		(provider) => !plugin.nutstoreLlmGatewayService.isManagedProvider(provider),
	)
	if (providers.length === 0) {
		contentEl.createDiv({
			cls: ':uno: setting-item-description',
			text: i18n.t('settings.ai.providers.empty'),
		})
		return
	}

	for (const provider of providers) {
		const missingPresetModels = listMissingPresetModelsForProvider(provider)
		new Setting(contentEl)
			.setName(provider.name || i18n.t('settings.ai.unnamedProvider'))
			.setDesc(
				provider.api ||
					getProviderDefaultBaseURL(provider.npm) ||
					i18n.t('settings.ai.providers.defaultEndpoint'),
			)
			.then((setting) => {
				if (missingPresetModels.length > 0) {
					setting.descEl.createDiv({
						cls: ':uno: setting-item-description',
						text: i18n.t('settings.ai.providers.updateModelsHint', {
							count: missingPresetModels.length,
						}),
					})
				}
			})
			.addButton((button) => {
				if (missingPresetModels.length === 0) {
					button.buttonEl.hide()
					return
				}
				button
					.setButtonText(i18n.t('settings.ai.providers.updateModels'))
					.setCta()
					.onClick(async () => {
						const confirmed = await new ProviderModelsUpdateConfirmModal(
							plugin.app,
							provider,
							missingPresetModels,
						).openAndWait()
						if (!confirmed) return
						await addMissingPresetModels(
							{ plugin, render, onChanged },
							provider,
							missingPresetModels,
						)
					})
			})
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.ai.modals.provider.edit'))
					.onClick(() => {
						new ProviderEditorModal(
							plugin,
							provider,
							async (savedProvider) => {
								if (!validateProviderKey(plugin, savedProvider, provider.id)) {
									return false
								}
								const { [provider.id]: _old, ...rest } =
									plugin.settings.ai.providers
								plugin.settings.ai.providers = {
									...rest,
									[savedProvider.id]: savedProvider,
								}
								await onChanged()
								render()
								return true
							},
							false,
						).open()
					}),
			)
			.addButton((button) => {
				let confirmDelete = false

				const resetButton = () => {
					confirmDelete = false
					button.buttonEl.empty()
					setIcon(button.buttonEl, 'trash')
					removeClassTokens(button.buttonEl, ':uno: mod-warning')
				}

				button.setIcon('trash').onClick(async () => {
					if (!confirmDelete) {
						confirmDelete = true
						button.buttonEl.empty()
						button.buttonEl.createSpan({
							text: i18n.t('settings.ai.modals.confirmDeleteLabel'),
						})
						addClassTokens(button.buttonEl, ':uno: mod-warning')
						return
					}
					await deleteProvider({ plugin, render, onChanged }, provider)
				})
				button.buttonEl.addEventListener('blur', resetButton)
			})
	}
}
