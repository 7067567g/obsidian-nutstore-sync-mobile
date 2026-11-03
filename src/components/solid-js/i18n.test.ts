import { afterEach, describe, expect, it } from 'vitest'
import i18nClient from '~/i18n'
import en from '~/i18n/locales/en.json'
import zh from '~/i18n/locales/zh.json'
import { t } from './i18n'

const SEND_KEY = 'chatbox.ui.actions.send'
const COPY_KEY = 'chatbox.ui.actions.copy'

function collectLeafKeys(dict: unknown, prefix = ''): string[] {
	if (typeof dict !== 'object' || dict === null) return [prefix]
	return Object.entries(dict).flatMap(([key, value]) =>
		collectLeafKeys(value, prefix ? `${prefix}.${key}` : key),
	)
}

afterEach(async () => {
	// Never leak the language into sibling assertions.
	await i18nClient.changeLanguage('en')
})

describe('component i18n follows the shared plugin i18n language', () => {
	it('switches the ChatBox strings to zh when the i18n service changes language', async () => {
		await i18nClient.changeLanguage('zh')
		expect(t(SEND_KEY)).toBe('发送')
	})

	it('switches back to en after a second changeLanguage', async () => {
		await i18nClient.changeLanguage('zh')
		await i18nClient.changeLanguage('en')
		expect(t(SEND_KEY)).toBe('Send')
	})

	it('resolves regional tags such as zh-CN through the zh bundle', async () => {
		await i18nClient.changeLanguage('zh-CN')
		expect(t(COPY_KEY)).toBe('复制')
	})

	it('keeps the zh/en key sets identical (664/664)', () => {
		const enKeys = collectLeafKeys(en).sort()
		const zhKeys = collectLeafKeys(zh).sort()
		expect(enKeys).toHaveLength(664)
		expect(zhKeys).toEqual(enKeys)
	})
})
