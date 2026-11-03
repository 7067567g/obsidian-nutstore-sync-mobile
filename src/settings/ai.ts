import { Notice, Setting } from 'obsidian'
import {
	sanitizeDefaultSelections,
	sanitizeProviders,
} from '~/ai/catalog/config'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import {
	type AISettingsSectionContext,
	renderBehaviorSections,
	renderDefaultModelSection,
	renderMcpSection,
	renderProvidersSection,
	renderSubagentSetting,
} from './ai-sections'
import BaseSettings from './settings.base'

export default class AISettings extends BaseSettings {
	private subagentsContainerEl?: HTMLElement

	async display() {
		this.containerEl.empty()

		new Setting(this.containerEl)
			.setName(i18n.t('settings.sections.ai'))
			.setHeading()

		const ctx = this.sectionContext()

		renderProvidersSection(this.containerEl, ctx)
		renderDefaultModelSection(this.containerEl, ctx)
		renderMcpSection(this.containerEl, ctx)
		renderBehaviorSections(this.containerEl, ctx)

		this.containerEl.createEl('h3', {
			text: i18n.t('settings.ai.subagents.heading'),
		})
		this.subagentsContainerEl = this.containerEl.createDiv()
		this.renderSubagentSettings()
	}

	private sectionContext(): AISettingsSectionContext {
		return {
			plugin: this.plugin,
			persist: (showNotice?: boolean) => this.persist(showNotice),
			rerender: () => {
				void this.display()
			},
		}
	}

	private renderSubagentSettings() {
		const containerEl = this.subagentsContainerEl
		if (!containerEl) return
		containerEl.empty()
		renderSubagentSetting(containerEl, 'explorer', {
			...this.sectionContext(),
			rerenderSubagents: () => this.renderSubagentSettings(),
		})
	}

	private async persist(showNotice: boolean = true) {
		try {
			this.plugin.settings.ai.providers = sanitizeProviders(
				this.plugin.settings.ai.providers,
			)
			this.plugin.settings.ai.defaultModel = sanitizeDefaultSelections(
				this.plugin.settings.ai.providers,
				this.plugin.settings.ai.defaultModel,
			)
			await this.plugin.settingsService.saveSettings()
			if (showNotice) {
				new Notice(i18n.t('settings.ai.saved'))
			}
		} catch (error) {
			logger.error(error)
			new Notice(
				error instanceof Error
					? i18n.t('settings.ai.errors.saveFailedWithReason', {
							reason: error.message,
						})
					: i18n.t('settings.ai.errors.saveFailed'),
				10000,
			)
		}
	}
}
