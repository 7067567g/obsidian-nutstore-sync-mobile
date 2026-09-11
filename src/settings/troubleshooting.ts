import { Notice, Setting } from 'obsidian'
import { isNotNil } from 'ramda'
import CacheClearModal from '~/components/CacheClearModal'
import { IN_DEV } from '~/consts'
import { exportDiagnosticsPackage } from '~/diagnostics/report'
import i18n from '~/i18n'
import { blobStore } from '~/storage/blob'
import { formatLocalTimestampForFilename } from '~/utils/local-date'
import logger from '~/utils/logger'
import logsStringify from '~/utils/logs-stringify'
import BaseSettings from './settings.base'

export const CONFIG_BACKUP_DIR = '.agents/nutstore-sync/backups'

export default class TroubleshootingSettings extends BaseSettings {
	private readonly blobGarbageCount = 5000
	private readonly blobGarbageSizeBytes = 64 * 1024

	async display() {
		this.containerEl.empty()
		new Setting(this.containerEl)
			.setName(i18n.t('settings.troubleshooting.title'))
			.setHeading()

		new Setting(this.containerEl)
			.setName(i18n.t('settings.cache.clearName'))
			.setDesc(i18n.t('settings.cache.clearDesc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.cache.clear'))
					.onClick(async () => {
						new CacheClearModal(this.plugin, async (options) => {
							try {
								const cleared =
									await CacheClearModal.clearSelectedCaches(options)
								if (cleared.length > 0) {
									new Notice(i18n.t('settings.cache.cleared'))
								} else {
									new Notice(
										i18n.t('settings.cache.clearModal.nothingSelected'),
									)
								}
							} catch (error) {
								logger.error('Error clearing cache:', error)
								const message =
									error instanceof Error ? error.message : String(error)
								new Notice(`Error clearing cache: ${message}`)
							}
						}).open()
					})
			})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.log.name'))
			.setDesc(i18n.t('settings.log.desc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.log.saveToNote'))
					.onClick(async () => {
						await this.saveLogsToNote()
					})
			})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.log.clearName'))
			.setDesc(i18n.t('settings.log.clearDesc'))
			.addButton((button) => {
				button.setButtonText(i18n.t('settings.log.clear')).onClick(() => {
					this.plugin.loggerService.clear()
					new Notice(i18n.t('settings.log.cleared'))
				})
			})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.troubleshooting.exportName'))
			.setDesc(i18n.t('settings.troubleshooting.exportDesc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.troubleshooting.exportButton'))
					.onClick(async () => {
						button.setDisabled(true)
						try {
							const fileName = await exportDiagnosticsPackage(this.plugin, {
								reason: 'manual',
							})
							new Notice(
								i18n.t('settings.troubleshooting.exported', { fileName }),
							)
						} catch (error) {
							logger.error('Failed to export diagnostics package', error)
							new Notice(
								i18n.t('settings.troubleshooting.exportError', {
									message:
										error instanceof Error ? error.message : String(error),
								}),
							)
						} finally {
							button.setDisabled(false)
						}
					})
			})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.troubleshooting.localOnlyName'))
			.setDesc(i18n.t('settings.troubleshooting.localOnlyDesc'))

		new Setting(this.containerEl)
			.setName(i18n.t('settings.troubleshooting.backupName'))
			.setDesc(i18n.t('settings.troubleshooting.backupDesc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.troubleshooting.backupButton'))
					.onClick(async () => {
						button.setDisabled(true)
						try {
							const filePath = await this.exportLocalConfig()
							new Notice(
								i18n.t('settings.troubleshooting.backupDone', { filePath }),
							)
						} catch (error) {
							logger.error('Failed to export local config backup', error)
							new Notice(i18n.t('settings.troubleshooting.backupFailed'))
						} finally {
							button.setDisabled(false)
						}
					})
			})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.troubleshooting.restoreName'))
			.setDesc(i18n.t('settings.troubleshooting.restoreDesc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.troubleshooting.restoreButton'))
					.onClick(async () => {
						button.setDisabled(true)
						try {
							const filePath = await this.restoreLatestConfig()
							new Notice(
								i18n.t('settings.troubleshooting.restored', { filePath }),
							)
							void this.display()
						} catch (error) {
							logger.error('Failed to restore local config backup', error)
							new Notice(
								i18n.t('settings.troubleshooting.restoreFailed', {
									message:
										error instanceof Error ? error.message : String(error),
								}),
							)
						} finally {
							button.setDisabled(false)
						}
					})
			})

		if (IN_DEV) {
			new Setting(this.containerEl)
				.setName(i18n.t('settings.cache.generateBlobGarbageName'))
				.setDesc(
					i18n.t('settings.cache.generateBlobGarbageDesc', {
						count: this.blobGarbageCount,
						sizeKiB: this.blobGarbageSizeBytes / 1024,
					}),
				)
				.addButton((button) => {
					button
						.setButtonText(i18n.t('settings.cache.generateBlobGarbage'))
						.onClick(async () => {
							button.setDisabled(true)
							try {
								new Notice(i18n.t('settings.cache.generateBlobGarbageRunning'))
								const created = await this.generateBlobGarbage()
								new Notice(
									i18n.t('settings.cache.generateBlobGarbageDone', {
										count: created,
									}),
								)
							} catch (error) {
								logger.error('Error generating blob garbage:', error)
								new Notice(`Error: ${(error as Error).message}`)
							} finally {
								button.setDisabled(false)
							}
						})
				})
		}
	}

	hide() {}

	private async exportLocalConfig(): Promise<string> {
		const now = new Date()
		const payload = {
			schemaVersion: 1,
			exportedAt: now.toISOString(),
			plugin: {
				id: this.plugin.manifest.id,
				version: this.plugin.manifest.version,
			},
			settings: this.plugin.settings,
			localSettings: this.plugin.localSettings,
		}
		await this.plugin.diagnosticsLogFile.ensureDirectory(CONFIG_BACKUP_DIR)
		const fileName = `nutstore-sync-config-${formatLocalTimestampForFilename(now)}.json`
		const filePath = `${CONFIG_BACKUP_DIR}/${fileName}`
		await this.app.vault.adapter.write(
			filePath,
			`${JSON.stringify(payload, null, 2)}\n`,
		)
		logger.info('Local config backup exported', { filePath })
		return filePath
	}

	private async restoreLatestConfig(): Promise<string> {
		const listed = await this.app.vault.adapter
			.list(CONFIG_BACKUP_DIR)
			.catch(() => ({ files: [] as string[], folders: [] as string[] }))
		const filePath = listed.files
			.filter((file) => file.endsWith('.json'))
			.sort()
			.at(-1)
		if (!filePath) {
			throw new Error(i18n.t('settings.troubleshooting.restoreNoBackup'))
		}
		const parsed: unknown = JSON.parse(
			await this.app.vault.adapter.read(filePath),
		)
		if (!parsed || typeof parsed !== 'object') {
			throw new Error('invalid backup payload')
		}
		const payload = parsed as {
			settings?: unknown
			localSettings?: unknown
		}
		if (!payload.settings || typeof payload.settings !== 'object') {
			throw new Error('backup has no settings')
		}
		this.plugin.settings = Object.assign(
			{},
			this.plugin.settings,
			payload.settings,
		)
		if (payload.localSettings && typeof payload.localSettings === 'object') {
			this.plugin.localSettings = Object.assign(
				{},
				this.plugin.localSettings,
				payload.localSettings,
			)
		}
		await this.plugin.settingsService.saveSettings()
		await this.plugin.settingsService.saveLocalSettings()
		await this.plugin.settingsService.reloadSettingsFromDisk()
		logger.info('Local config backup restored', { filePath })
		return filePath
	}

	private get logs() {
		return this.plugin.loggerService.logs
			.map(logsStringify)
			.filter(isNotNil)
			.join('\n\n')
	}

	private async saveLogsToNote() {
		try {
			const now = new Date()
			const timestamp = formatLocalTimestampForFilename(now)
			const fileName = `nutstore-logs-${timestamp}.md`
			const dirPath = 'nutstore-sync/logs'
			const filePath = `${dirPath}/${fileName}`
			const content = `# Nutstore Plugin Logs\n\nGenerated at: ${now.toLocaleString()}\n\nPlugin version: ${this.plugin.manifest.version}\n\n---\n\n${this.logs}`

			const folderExists = await this.app.vault.adapter.exists(dirPath)
			if (!folderExists) {
				await this.app.vault.adapter.mkdir(dirPath)
			}

			const file = await this.app.vault.create(filePath, content)
			new Notice(i18n.t('settings.log.savedToNote', { fileName: filePath }))
			await this.app.workspace.getLeaf().openFile(file)
		} catch (error) {
			new Notice(i18n.t('settings.log.saveError'))
			logger.error('Failed to save logs to note:', error)
		}
	}

	private async generateBlobGarbage() {
		function createRandomBytes(size: number) {
			const bytes = new Uint8Array(size)
			if (window.crypto?.getRandomValues) {
				window.crypto.getRandomValues(bytes)
				return bytes
			}
			for (let i = 0; i < bytes.length; i++) {
				bytes[i] = Math.floor(Math.random() * 256)
			}
			return bytes
		}

		let created = 0
		for (let i = 0; i < this.blobGarbageCount; i++) {
			const payload = createRandomBytes(this.blobGarbageSizeBytes)
			await blobStore.store(payload.buffer)
			created++
		}
		return created
	}
}
