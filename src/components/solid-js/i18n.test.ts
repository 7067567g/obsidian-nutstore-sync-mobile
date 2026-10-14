import { describe, expect, it } from 'vitest'
import { syncComponentLocale, t } from './i18n'

describe('syncComponentLocale', () => {
	it('applies the plugin language setting over the host language', () => {
		syncComponentLocale('zh')
		expect(t('chatbox.ui.actions.send')).toBe('发送')

		syncComponentLocale('en')
		expect(t('chatbox.ui.actions.send')).toBe('Send')
	})

	it('accepts regional language tags such as zh-CN', () => {
		syncComponentLocale('zh-CN')
		expect(t('chatbox.ui.actions.copy')).toBe('复制')

		syncComponentLocale('en-US')
		expect(t('chatbox.ui.actions.copy')).toBe('Copy')
	})

	it('falls back to the host locale when no explicit language is given', () => {
		// Must not throw and must resolve one of the bundled locales.
		syncComponentLocale(undefined)
		expect(typeof t('chatbox.ui.actions.send')).toBe('string')
		expect(t('chatbox.ui.actions.send').length).toBeGreaterThan(0)
	})
})
