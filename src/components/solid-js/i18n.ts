import * as i18n from '@solid-primitives/i18n'
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
 * Resolves the locale for the Solid components (chatbox / WebDAV explorer).
 * An explicit plugin language (`settings.language`) always wins; when it is
 * unset we mirror `I18nService.update()` and fall back to the host language.
 */
function resolveLocale(language?: string): Locale {
	if (language) return toLocale(language)
	return toLocale(typeof navigator === 'undefined' ? 'en' : navigator.language)
}

function buildDict(locale: Locale): ComponentDict {
	return i18n.flatten(messagesByLocale[locale])
}

let currentLocale: Locale = resolveLocale()
let dict: ComponentDict = buildDict(currentLocale)

/**
 * Applies the plugin language setting to the component i18n. Must be called
 * before mounting a Solid tree so the chatbox matches the settings UI instead
 * of always following `navigator.language`.
 */
export function syncComponentLocale(language?: string): void {
	const next = resolveLocale(language)
	if (next === currentLocale) return
	currentLocale = next
	dict = buildDict(next)
}

export const t = i18n.translator(() => dict, i18n.resolveTemplate)
