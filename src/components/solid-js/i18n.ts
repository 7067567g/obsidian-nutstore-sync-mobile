import * as i18n from '@solid-primitives/i18n'
import { createSignal } from 'solid-js'
import i18nClient from '~/i18n'
import en from '~/i18n/locales/en.json'
import zh from '~/i18n/locales/zh.json'

type ComponentMessages = typeof en

const messagesByLocale: Record<Locale, ComponentMessages> = {
	en,
	zh: zh,
}

type ComponentDict = i18n.Flatten<ComponentMessages>

type Locale = 'zh' | 'en'

function toLocale(language: string): Locale {
	switch (language.split('-')[0].toLowerCase()) {
		case 'zh':
			return 'zh'
		default:
			return 'en'
	}
}

/**
 * Mirrors `I18nService.update()`: the shared i18next instance carries the
 * plugin language (`settings.language`) and only falls back to the host
 * language when no explicit language is configured.
 */
function currentLocale(): Locale {
	const language = i18nClient.language
	if (typeof language === 'string' && language.length > 0) {
		return toLocale(language)
	}
	return toLocale(typeof navigator === 'undefined' ? 'en' : navigator.language)
}

function buildDict(locale: Locale): ComponentDict {
	return i18n.flatten(messagesByLocale[locale])
}

const [dict, setDict] = createSignal<ComponentDict>(buildDict(currentLocale()))

/**
 * `I18nService.update()` drives `~/i18n` through `changeLanguage`, so the
 * Solid components (ChatBox / WebDAV explorer / task list) follow the plugin
 * language setting instead of freezing `navigator.language` at import time.
 */
i18nClient.on('languageChanged', (language) => {
	setDict(buildDict(toLocale(language)))
})

export const t = i18n.translator(dict, i18n.resolveTemplate)
