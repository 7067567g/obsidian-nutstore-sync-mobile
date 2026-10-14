import { afterEach, describe, expect, it, vi } from 'vitest'

const t = vi.hoisted(() => vi.fn((key: string) => key))

vi.mock('~/i18n', () => ({ default: { t } }))

import { obsidianFetch } from './obsidian-fetch'
import { createProviderFetch } from './provider-fetch'

function provider(allowBrowserCors: boolean) {
	return {
		id: 'provider-1',
		allowBrowserCors,
		apiKey: 'key',
		name: 'Provider',
	} as unknown as Parameters<typeof createProviderFetch>[0]
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

describe('createProviderFetch', () => {
	it('uses obsidianFetch directly when browser CORS is disabled', () => {
		expect(createProviderFetch(provider(false))).toBe(obsidianFetch)
	})

	it('passes through successful browser fetch responses', async () => {
		const response = new Response('ok')
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

		const fetchImpl = createProviderFetch(provider(true))
		await expect(fetchImpl('https://example.com')).resolves.toBe(response)
	})

	it('reports browser CORS failures with the disable link', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
		)

		const fetchImpl = createProviderFetch(provider(true))

		await expect(fetchImpl('https://example.com')).rejects.toMatchObject({
			message: 'settings.ai.errors.browserCorsFailedWithDisableLink',
			cause: expect.any(TypeError),
		})
		expect(t).toHaveBeenCalledWith(
			'settings.ai.errors.browserCorsFailedWithDisableLink',
			expect.objectContaining({
				link: expect.stringContaining('providerId=provider-1'),
			}),
		)
	})

	it('rethrows unrelated errors unchanged', async () => {
		const error = new Error('boom')
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error))

		const fetchImpl = createProviderFetch(provider(true))

		await expect(fetchImpl('https://example.com')).rejects.toBe(error)
	})
})
