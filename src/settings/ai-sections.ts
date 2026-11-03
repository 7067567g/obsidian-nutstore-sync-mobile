import { Setting } from 'obsidian'
import {
	getFirstModel,
	getModelById,
	getProviderById,
	listModels,
	listProviders,
} from '~/ai/catalog/config'
import { DEFAULT_MAX_INLINE_OPERATION_BYTES } from '~/ai/chat/session/session-operations'
import type NutstorePlugin from '~/index'
import McpServersManagerModal from '~/components/McpServersManagerModal'
import ProvidersManagerModal from '~/components/ProvidersManagerModal'
import i18n from '~/i18n'

export interface AISettingsSectionContext {
	plugin: NutstorePlugin
	persist: (showNotice?: boolean) => Promise<void>
	rerender: () => void
}

export function listUserManagedProviders(plugin: NutstorePlugin) {
	return listProviders(plugin.settings.ai.providers).filter(
		(provider) => !plugin.nutstoreLlmGatewayService.isManagedProvider(provider),
	)
}

export function renderProvidersSection(
	containerEl: HTMLElement,
	ctx: AISettingsSectionContext,
): void {
	new Setting(containerEl)
		.setName(i18n.t('settings.ai.providers.name'))
		.setDesc(
			i18n.t('settings.ai.providers.summary', {
				count: listUserManagedProviders(ctx.plugin).length,
			}),
		)
		.addButton((button) =>
			button
				.setButtonText(i18n.t('settings.ai.providers.manage'))
				.onClick(() => {
					new ProvidersManagerModal(ctx.plugin, async () => {
						await ctx.persist(false)
						ctx.rerender()
					}).open()
				}),
		)

	if (listUserManagedProviders(ctx.plugin).length === 0) {
		containerEl.createEl('p', {
			cls: ':uno: -mt-1 mb-5 opacity-75',
			text: i18n.t('settings.ai.providers.emptyHint'),
		})
	}
}

export function renderDefaultModelSection(
	containerEl: HTMLElement,
	ctx: AISettingsSectionContext,
): void {
	new Setting(containerEl)
		.setName(i18n.t('settings.ai.defaultModel.name'))
		.setDesc(i18n.t('settings.ai.defaultModel.desc'))
		.addDropdown((dropdown) => {
			dropdown.addOption('', i18n.t('settings.ai.none'))
			for (const provider of listProviders(ctx.plugin.settings.ai.providers)) {
				dropdown.addOption(
					provider.id,
					provider.name || i18n.t('settings.ai.unnamedProvider'),
				)
			}
			dropdown
				.setValue(ctx.plugin.settings.ai.defaultModel?.providerId || '')
				.onChange(async (value) => {
					if (!value) {
						ctx.plugin.settings.ai.defaultModel = undefined
					} else {
						const provider = getProviderById(
							ctx.plugin.settings.ai.providers,
							value,
						)
						const currentModelId = ctx.plugin.settings.ai.defaultModel?.modelId
						const model =
							getModelById(provider, currentModelId) || getFirstModel(provider)
						ctx.plugin.settings.ai.defaultModel = model
							? { providerId: value, modelId: model.id }
							: undefined
					}
					await ctx.persist()
					ctx.rerender()
				})
		})
		.addDropdown((dropdown) => {
			const provider = getProviderById(
				ctx.plugin.settings.ai.providers,
				ctx.plugin.settings.ai.defaultModel?.providerId,
			)
			dropdown.addOption('', i18n.t('settings.ai.none'))
			for (const model of listModels(provider)) {
				dropdown.addOption(
					model.id,
					model.name || i18n.t('settings.ai.unnamedModel'),
				)
			}
			dropdown
				.setValue(ctx.plugin.settings.ai.defaultModel?.modelId || '')
				.setDisabled(!provider)
				.onChange(async (value) => {
					const providerId = ctx.plugin.settings.ai.defaultModel?.providerId
					if (providerId && value) {
						ctx.plugin.settings.ai.defaultModel = {
							providerId,
							modelId: value,
						}
					} else {
						ctx.plugin.settings.ai.defaultModel = undefined
					}
					await ctx.persist()
				})
		})
}

export function renderMcpSection(
	containerEl: HTMLElement,
	ctx: AISettingsSectionContext,
): void {
	new Setting(containerEl)
		.setName(i18n.t('settings.ai.mcp.name'))
		.setDesc(
			i18n.t('settings.ai.mcp.summary', {
				count: Object.keys(ctx.plugin.mcpService.getServers()).length,
			}),
		)
		.addButton((button) =>
			button.setButtonText(i18n.t('settings.ai.mcp.manage')).onClick(() => {
				new McpServersManagerModal(ctx.plugin, async () => {
					ctx.rerender()
				}).open()
			}),
		)
}

export function renderBehaviorSections(
	containerEl: HTMLElement,
	ctx: AISettingsSectionContext,
): void {
	new Setting(containerEl)
		.setName(i18n.t('settings.ai.yolo.name'))
		.setDesc(i18n.t('settings.ai.yolo.desc'))
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.plugin.settings.ai.yolo ?? false)
				.onChange(async (value) => {
					ctx.plugin.settings.ai.yolo = value
					await ctx.persist(false)
				}),
		)

	new Setting(containerEl)
		.setName(i18n.t('settings.ai.bashAccess.name'))
		.setDesc(i18n.t('settings.ai.bashAccess.desc'))
		.addDropdown((dropdown) =>
			dropdown
				.addOption('deny', i18n.t('settings.ai.bashAccess.options.deny'))
				.addOption('ask', i18n.t('settings.ai.bashAccess.options.ask'))
				.addOption('always', i18n.t('settings.ai.bashAccess.options.always'))
				.setValue(ctx.plugin.settings.ai.bashAccess ?? 'deny')
				.onChange(async (value: string) => {
					ctx.plugin.settings.ai.bashAccess = value as 'deny' | 'ask' | 'always'
					await ctx.persist(false)
				}),
		)

	new Setting(containerEl)
		.setName(i18n.t('settings.ai.compressionBackend.name'))
		.setDesc(i18n.t('settings.ai.compressionBackend.desc'))
		.addDropdown((dropdown) =>
			dropdown
				.addOption(
					'deterministic',
					i18n.t('settings.ai.compressionBackend.options.deterministic'),
				)
				.addOption('llm', i18n.t('settings.ai.compressionBackend.options.llm'))
				.setValue(ctx.plugin.settings.ai.compressionBackend ?? 'deterministic')
				.onChange(async (value: string) => {
					ctx.plugin.settings.ai.compressionBackend = value as
						| 'deterministic'
						| 'llm'
					await ctx.persist(false)
				}),
		)

	new Setting(containerEl)
		.setName(i18n.t('settings.ai.sessionStorage.name'))
		.setDesc(i18n.t('settings.ai.sessionStorage.desc'))
		.addText((text) => {
			text.inputEl.type = 'number'
			text.inputEl.min = '0'
			text.inputEl.step = '64'
			text.setValue(
				String(
					Math.round(
						(ctx.plugin.settings.ai.maxInlineOperationBytes ??
							DEFAULT_MAX_INLINE_OPERATION_BYTES) / 1024,
					),
				),
			)
			text.onChange(async (value) => {
				const kilobytes = Number.parseInt(value, 10)
				ctx.plugin.settings.ai.maxInlineOperationBytes =
					Number.isFinite(kilobytes) && kilobytes > 0
						? kilobytes * 1024
						: undefined
				await ctx.persist(false)
			})
		})
	new Setting(containerEl)
		.setName(i18n.t('settings.ai.toolTimeout.name'))
		.setDesc(i18n.t('settings.ai.toolTimeout.desc'))
		.addText((text) => {
			text.inputEl.type = 'number'
			text.inputEl.min = '0'
			text.inputEl.step = '1'
			const current = ctx.plugin.settings.ai.toolTimeoutMs
			text.setValue(
				current === undefined ? '' : String(Math.round(current / 1000)),
			)
			text.onChange(async (value) => {
				const seconds = Number.parseInt(value, 10)
				ctx.plugin.settings.ai.toolTimeoutMs =
					Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
				await ctx.persist(false)
			})
		})

	new Setting(containerEl)
		.setName(i18n.t('settings.ai.windowedRendering.name'))
		.setDesc(i18n.t('settings.ai.windowedRendering.desc'))
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.plugin.settings.ai.windowedRendering !== false)
				.onChange(async (value) => {
					ctx.plugin.settings.ai.windowedRendering = value
					await ctx.persist(false)
				}),
		)
}

export function renderSubagentSetting(
	containerEl: HTMLElement,
	type: 'explorer',
	ctx: AISettingsSectionContext & { rerenderSubagents: () => void },
): void {
	const config = ctx.plugin.settings.ai.subagents[type]
	const keys = `settings.ai.subagents.${type}` as const
	new Setting(containerEl)
		.setName(i18n.t(`${keys}.name`))
		.setDesc(i18n.t(`${keys}.desc`))
		.addToggle((toggle) =>
			toggle.setValue(config.enabled).onChange(async (enabled) => {
				config.enabled = enabled
				await ctx.persist(false)
				ctx.rerenderSubagents()
			}),
		)
	if (!config.enabled) return

	new Setting(containerEl)
		.setName(i18n.t(`${keys}.model.name`))
		.setDesc(i18n.t(`${keys}.model.desc`))
		.addDropdown((dropdown) => {
			dropdown.addOption('', i18n.t('settings.ai.none'))
			for (const provider of listProviders(ctx.plugin.settings.ai.providers)) {
				dropdown.addOption(
					provider.id,
					provider.name || i18n.t('settings.ai.unnamedProvider'),
				)
			}
			dropdown
				.setValue(config.model?.providerId || '')
				.onChange(async (providerId) => {
					if (!providerId) {
						config.model = undefined
					} else {
						const provider = getProviderById(
							ctx.plugin.settings.ai.providers,
							providerId,
						)
						const model =
							getModelById(provider, config.model?.modelId) ||
							getFirstModel(provider)
						config.model = model ? { providerId, modelId: model.id } : undefined
					}
					await ctx.persist()
					ctx.rerenderSubagents()
				})
		})
		.addDropdown((dropdown) => {
			const provider = getProviderById(
				ctx.plugin.settings.ai.providers,
				config.model?.providerId,
			)
			dropdown.addOption('', i18n.t('settings.ai.none'))
			for (const model of listModels(provider)) {
				dropdown.addOption(
					model.id,
					model.name || i18n.t('settings.ai.unnamedModel'),
				)
			}
			dropdown
				.setValue(config.model?.modelId || '')
				.setDisabled(!provider)
				.onChange(async (modelId) => {
					const providerId = config.model?.providerId
					config.model =
						providerId && modelId ? { providerId, modelId } : undefined
					await ctx.persist()
				})
		})
}
