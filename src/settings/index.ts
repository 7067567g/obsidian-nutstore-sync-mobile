import { App, PluginSettingTab, Setting } from 'obsidian'
import { Subscription } from 'rxjs'
import { onNutstoreLlmGatewayAuth } from '~/events/nutstore-llm-gateway-auth'
import { onSsoReceive } from '~/events/sso-receive'
import i18n from '~/i18n'
import type NutstorePlugin from '~/index'
import AccountSettings from './account'
import AISettings from './ai'
import CommonSettings from './common'
import BaseSettings from './settings.base'
import FilterSettings from './filter'
import { SETTINGS_TABS, SettingsTabKey } from './tabs'
import TroubleshootingSettings from './troubleshooting'

export * from './definitions'

interface SettingsSectionEntry {
	section: BaseSettings
	containerEl: HTMLElement
}

export class NutstoreSettingTab extends PluginSettingTab {
	plugin: NutstorePlugin
	accountSettings: AccountSettings
	commonSettings: CommonSettings
	filterSettings: FilterSettings
	troubleshootingSettings: TroubleshootingSettings
	aiSettings: AISettings
	warningContainerEl: HTMLElement
	private tabBarEl: HTMLElement
	private activeTab: SettingsTabKey = 'sync'
	private readonly tabSections: Record<SettingsTabKey, SettingsSectionEntry[]>

	private readonly subscriptions: Subscription[] = [
		onSsoReceive().subscribe(() => {
			void this.rerenderIfVisible()
		}),
		onNutstoreLlmGatewayAuth().subscribe(() => {
			void this.rerenderIfVisible()
		}),
	]

	constructor(app: App, plugin: NutstorePlugin) {
		super(app, plugin)
		this.plugin = plugin
		this.tabBarEl = this.containerEl.createDiv()
		this.warningContainerEl = this.containerEl.createDiv()
		const accountContainerEl = this.containerEl.createDiv()
		this.accountSettings = new AccountSettings(
			this.app,
			this.plugin,
			this,
			accountContainerEl,
		)
		const commonContainerEl = this.containerEl.createDiv()
		this.commonSettings = new CommonSettings(
			this.app,
			this.plugin,
			this,
			commonContainerEl,
		)
		const filterContainerEl = this.containerEl.createDiv()
		this.filterSettings = new FilterSettings(
			this.app,
			this.plugin,
			this,
			filterContainerEl,
		)
		const aiContainerEl = this.containerEl.createDiv()
		this.aiSettings = new AISettings(this.app, this.plugin, this, aiContainerEl)
		const troubleshootingContainerEl = this.containerEl.createDiv()
		this.troubleshootingSettings = new TroubleshootingSettings(
			this.app,
			this.plugin,
			this,
			troubleshootingContainerEl,
		)
		this.tabSections = {
			sync: [
				{ section: this.accountSettings, containerEl: accountContainerEl },
				{ section: this.commonSettings, containerEl: commonContainerEl },
				{ section: this.filterSettings, containerEl: filterContainerEl },
			],
			ai: [{ section: this.aiSettings, containerEl: aiContainerEl }],
			troubleshooting: [
				{
					section: this.troubleshootingSettings,
					containerEl: troubleshootingContainerEl,
				},
			],
		}
	}

	display() {
		this.renderTabBar()
		void this.renderActiveTabContent()
	}

	private async renderActiveTabContent() {
		const isSyncTab = this.activeTab === 'sync'
		if (isSyncTab) this.warningContainerEl.show()
		else this.warningContainerEl.hide()
		if (isSyncTab) {
			this.warningContainerEl.empty()
			new Setting(this.warningContainerEl)
				.setName(i18n.t('settings.backupWarning.name'))
				.setDesc(i18n.t('settings.backupWarning.desc'))
		}
		for (const tab of SETTINGS_TABS) {
			const isActive = tab.key === this.activeTab
			for (const { containerEl } of this.tabSections[tab.key]) {
				if (isActive) containerEl.show()
				else containerEl.hide()
			}
			if (isActive) {
				for (const { section } of this.tabSections[tab.key]) {
					await section.display()
				}
			}
		}
	}

	private renderTabBar() {
		this.tabBarEl.empty()
		const barEl = this.tabBarEl.createDiv({ cls: 'ns-settings-tabs' })
		const buttonEls = new Map<SettingsTabKey, HTMLElement>()
		for (const tab of SETTINGS_TABS) {
			const buttonEl = barEl.createEl('button', {
				cls: 'ns-settings-tab',
				text: i18n.t(tab.i18nKey),
			})
			buttonEl.classList.toggle('is-active', tab.key === this.activeTab)
			buttonEl.addEventListener('click', () => {
				if (this.activeTab !== tab.key) {
					this.activeTab = tab.key
					for (const [key, el] of buttonEls) {
						el.classList.toggle('is-active', key === this.activeTab)
					}
					void this.renderActiveTabContent()
				}
			})
			buttonEls.set(tab.key, buttonEl)
		}
	}

	get isSSO() {
		return this.plugin.settings.loginMode === 'sso'
	}

	isVisible() {
		return (
			this.containerEl.isConnected &&
			document.contains(this.containerEl) &&
			this.containerEl.offsetParent !== null
		)
	}

	async rerenderIfVisible() {
		if (!this.isVisible()) {
			return
		}
		this.renderTabBar()
		await this.renderActiveTabContent()
	}

	async onClose() {
		await this.accountSettings.hide()
		this.troubleshootingSettings.hide()
	}

	unload() {
		for (const subscription of this.subscriptions) {
			subscription.unsubscribe()
		}
	}
}
