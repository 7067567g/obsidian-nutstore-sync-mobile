import { parse as bytesParse } from 'bytes-iec'
import { Notice, type TextComponent } from 'obsidian'
import i18n from '~/i18n'
import type NutstorePlugin from '~/index'
import {
	DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE,
	MAX_MOBILE_APP_DOWNLOAD_FILE_CHUNK_BYTES,
	MIN_MOBILE_APP_DOWNLOAD_FILE_CHUNK_BYTES,
	normalizeByteSizeInput,
} from '~/utils/download-chunk-size'

/**
 * https://help.jianguoyun.com/?p=2064
 */
export const MAX_FILE_SIZE = '500MB'
export const MAX_BYTES = bytesParse(MAX_FILE_SIZE, { mode: 'jedec' })!

export async function handleMaxFileSizeBlur(
	plugin: NutstorePlugin,
	component: TextComponent,
) {
	let value = normalizeByteSizeInput(component.getValue(), MAX_FILE_SIZE)
	// Validate the input format
	const parsedBytes = bytesParse(value, { mode: 'jedec' })
	// Invalid format (e.g., "100FOO"): show error and revert to last saved value
	if (parsedBytes === null) {
		new Notice(i18n.t('settings.skipLargeFiles.invalidFormat'))
		component.setValue(plugin.settings.skipLargeFiles.maxSize)
		return
	}
	// Exceeds max limit (e.g., "1GB"): show error and clamp to max allowed value
	if (parsedBytes > MAX_BYTES) {
		new Notice(i18n.t('settings.skipLargeFiles.exceedsMaxSize'))
		value = MAX_FILE_SIZE
	}
	// Update UI with formatted value to ensure consistency
	component.setValue(value)
	// Save to disk only if value actually changed
	if (plugin.settings.skipLargeFiles.maxSize !== value) {
		plugin.settings.skipLargeFiles.maxSize = value
		await plugin.settingsService.saveSettings()
	}
}

export async function handleMobileAppDownloadFileChunkSizeBlur(
	plugin: NutstorePlugin,
	component: TextComponent,
) {
	let value = normalizeByteSizeInput(
		component.getValue(),
		DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE,
	)
	const parsedBytes = bytesParse(value, { mode: 'jedec' })
	if (parsedBytes === null) {
		new Notice(i18n.t('settings.mobileAppDownloadFileChunkSize.invalidFormat'))
		component.setValue(
			plugin.settings.mobileAppDownloadFileChunkSize ||
				DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE,
		)
		return
	}
	if (parsedBytes < MIN_MOBILE_APP_DOWNLOAD_FILE_CHUNK_BYTES) {
		new Notice(i18n.t('settings.mobileAppDownloadFileChunkSize.belowMinSize'))
		value = '64 KiB'
	} else if (parsedBytes > MAX_MOBILE_APP_DOWNLOAD_FILE_CHUNK_BYTES) {
		new Notice(i18n.t('settings.mobileAppDownloadFileChunkSize.exceedsMaxSize'))
		value = '64 MiB'
	}

	component.setValue(value)
	if (plugin.settings.mobileAppDownloadFileChunkSize !== value) {
		plugin.settings.mobileAppDownloadFileChunkSize = value
		await plugin.settingsService.saveSettings()
	}
}
