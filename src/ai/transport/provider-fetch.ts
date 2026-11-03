import type { AIProviderConfig } from '~/ai/core/types'
import { PLUGIN_VERSION } from '~/consts'
import i18n from '~/i18n'
import { obsidianFetch } from './obsidian-fetch'

export interface ProviderRequestContext {
	/** Stable id for the current conversation, used by OpenCode Go routing. */
	sessionId?: string
}

function isBrowserCorsFailure(error: unknown) {
	return error instanceof TypeError
}

function isNetworkDisconnected(error: unknown) {
	return (
		(typeof navigator !== 'undefined' && navigator.onLine === false) ||
		(error instanceof Error &&
			error.message.includes('ERR_INTERNET_DISCONNECTED'))
	)
}

function buildDisableCorsLink(providerId: string) {
	return `obsidian://nutstore-sync/modal/provider-edit?providerId=${encodeURIComponent(providerId)}`
}

function isOpenCodeGoProvider(provider: AIProviderConfig) {
	if (provider.id.trim().toLowerCase() === 'opencode-go') return true
	try {
		const hostname = new URL(provider.api ?? '').hostname.toLowerCase()
		return hostname === 'opencode.ai' || hostname.endsWith('.opencode.ai')
	} catch {
		return false
	}
}

/**
 * Merge provider-configured headers and OpenCode Go routing headers into one
 * request. Header values are never logged. `x-opencode-session` must be stable
 * for a conversation, so callers pass the chat session id through
 * `ProviderRequestContext`.
 */
function mergeRequestHeaders(
	provider: AIProviderConfig,
	context: ProviderRequestContext,
	input: RequestInfo | URL,
	init?: RequestInit,
) {
	const headers = new Headers(
		init?.headers ?? (input instanceof Request ? input.headers : undefined),
	)
	for (const [key, value] of Object.entries(provider.headers ?? {})) {
		const name = key.trim()
		if (!name) continue
		try {
			headers.set(name, value)
		} catch {
			// Ignore malformed names; one bad custom header must not crash every
			// request. The provider editor keeps the raw value so it can be fixed.
		}
	}
	if (isOpenCodeGoProvider(provider)) {
		if (context.sessionId && !headers.has('x-opencode-session')) {
			headers.set('x-opencode-session', context.sessionId)
		}
		if (!headers.has('user-agent')) {
			try {
				headers.set(
					'user-agent',
					`ObsidianNutstoreSync/${PLUGIN_VERSION} (mobile; opencode-go)`,
				)
			} catch {
				// User-Agent is a forbidden header in some browser fetch paths;
				// Obsidian's requestUrl path can still pass it through.
			}
		}
	}
	return headers
}

export function createProviderFetch(
	provider: AIProviderConfig,
	context: ProviderRequestContext = {},
): typeof fetch {
	const baseFetch: typeof fetch = provider.allowBrowserCors
		? fetch
		: obsidianFetch

	return async (input, init) => {
		const requestInit: RequestInit = {
			...init,
			headers: mergeRequestHeaders(provider, context, input, init),
		}
		if (!provider.allowBrowserCors) {
			return baseFetch(input, requestInit)
		}
		try {
			return await baseFetch(input, requestInit)
		} catch (error) {
			if (isNetworkDisconnected(error)) {
				throw new Error(i18n.t('settings.ai.errors.networkDisconnected'), {
					cause: error,
				})
			}
			if (!isBrowserCorsFailure(error)) {
				throw error
			}
			throw new Error(
				i18n.t('settings.ai.errors.browserCorsFailedWithDisableLink', {
					link: buildDisableCorsLink(provider.id),
				}),
				{ cause: error },
			)
		}
	}
}
