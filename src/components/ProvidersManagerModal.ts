import { Modal, Setting } from 'obsidian'
import { Subscription } from 'rxjs'
import {
	createProviderConfig,
	createProviderFromPreset,
	listPresetProviders,
} from '~/ai/catalog/config'
import { onNutstoreLlmGatewayAuth } from '~/events/nutstore-llm-gateway-auth'
import i18n from '~/i18n'
import { addClassTokens } from '~/utils/class-tokens'
import type NutstorePlugin from '~/index'
import ProviderEditorModal from './ProviderEditorModal'
import {
	CUSTOM_OPTION,
	createPresetRefreshSetting,
	type PresetModelsRefreshState,
	type PresetModelsRefreshSummary,
	renderNutstoreGatewaySection,
	renderProvidersList,
	validateProviderKey,
} from './ProvidersManagerModal.sections'

export default class ProvidersManagerModal extends Modal {
	private selectedPresetId = CUSTOM_OPTION
	private authSubscription: Subscription | null = null
	private presetModelsRefreshState: PresetModelsRefreshState = 'idle'
	private presetModelsRefreshSummary: PresetModelsRefreshSummary = {
		providersDelta: 0,
		modelsDelta: 0,
	}

	constructor(
		private plugin: NutstorePlugin,
		private onChanged: () => Promise<void> | void,
	) {
		super(plugin.app)
	}

	onOpen() {
		this.authSubscription = onNutstoreLlmGatewayAuth().subscribe(() => {
			this.render()
		})
		this.render()
	}

	private render() {
		const { contentEl } = this
		contentEl.empty()
		contentEl.createEl('h2', {
			text: i18n.t('settings.ai.modals.providers.title'),
		})

		const presets = listPresetProviders()

		createPresetRefreshSetting({
			contentEl,
			getState: () => this.presetModelsRefreshState,
			getSummary: () => this.presetModelsRefreshSummary,
			setState: (state) => {
				this.presetModelsRefreshState = state
			},
			setSummary: (summary) => {
				this.presetModelsRefreshSummary = summary
			},
			refresh: () => this.plugin.modelsPresetService.refreshFromRemote(),
			render: () => this.render(),
		})

		new Setting(contentEl)
			.setName(i18n.t('settings.ai.providers.name'))
			.setDesc(i18n.t('settings.ai.providers.desc'))
			.addDropdown((dropdown) => {
				addClassTokens(dropdown.selectEl, ':uno: max-w-32!')
				dropdown.addOption(
					CUSTOM_OPTION,
					i18n.t('settings.ai.providers.presetCustom'),
				)
				for (const preset of presets) {
					dropdown.addOption(preset.id, preset.name)
				}
				dropdown.setValue(this.selectedPresetId)
				dropdown.onChange((value) => {
					this.selectedPresetId = value
				})
			})
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.ai.providers.add'))
					.setCta()
					.onClick(() => {
						const preset =
							this.selectedPresetId !== CUSTOM_OPTION
								? presets.find((p) => p.id === this.selectedPresetId)
								: undefined
						const draft = preset
							? createProviderFromPreset(preset, '')
							: createProviderConfig()
						new ProviderEditorModal(
							this.plugin,
							draft,
							async (provider) => {
								if (!validateProviderKey(this.plugin, provider)) {
									return false
								}
								this.plugin.settings.ai.providers = {
									...this.plugin.settings.ai.providers,
									[provider.id]: provider,
								}
								await this.onChanged()
								this.render()
								return true
							},
							true,
						).open()
					}),
			)

		renderNutstoreGatewaySection({
			plugin: this.plugin,
			contentEl,
			render: () => this.render(),
		})

		renderProvidersList({
			plugin: this.plugin,
			contentEl,
			onChanged: this.onChanged,
			render: () => this.render(),
		})
	}

	onClose() {
		this.authSubscription?.unsubscribe()
		this.authSubscription = null
		this.contentEl.empty()
	}
}
