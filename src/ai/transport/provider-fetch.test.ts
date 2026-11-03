import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AIProviderConfig } from '~/ai/core/types'
import { createProviderFetch } from './provider-fetch'

function createProvider(
	overrides: Partial<AIProviderConfig> = {},
): AIProviderConfig {
	return {
		id: 'provider',
		name: 'Provider',
		env: [],
		npm: '@ai-sdk/openai-compatible',
		api: 'https://example.com/v1',
		doc: '',
		apiKey: 'test-key',
		allowBrowserCors: true,
		models: {},
		...overrides,
	} as AIProviderConfig
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('createProviderFetch', () => {
	it('merges configured provider headers with request headers', async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response('{}'),
		)
		vi.stubGlobal('fetch', fetchMock)
		const providerFetch = createProviderFetch(
			createProvider({ headers: { 'x-custom': 'custom-value' } }),
		)

		await providerFetch('https://example.com/v1/chat/completions', {
			headers: { 'content-type': 'application/json' },
		})

		const init = fetchMock.mock.calls[0]?.[1]
		const headers = new Headers(init?.headers)
		expect(headers.get('x-custom')).toBe('custom-value')
		expect(headers.get('content-type')).toBe('application/json')
	})

	it('adds the stable OpenCode Go session header and a client user agent', async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response('{}'),
		)
		vi.stubGlobal('fetch', fetchMock)
		const providerFetch = createProviderFetch(
			createProvider({
				id: 'opencode-go',
				api: 'https://opencode.ai/inference/go/openai/v1',
			}),
			{ sessionId: 'session_test-1' },
		)

		await providerFetch(
			'https://opencode.ai/inference/go/openai/v1/chat/completions',
		)

		const init = fetchMock.mock.calls[0]?.[1]
		const headers = new Headers(init?.headers)
		expect(headers.get('x-opencode-session')).toBe('session_test-1')
		expect(headers.get('user-agent')).toContain('ObsidianNutstoreSync/')
	})

	it('lets an explicit user header override the automatic session id', async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response('{}'),
		)
		vi.stubGlobal('fetch', fetchMock)
		const providerFetch = createProviderFetch(
			createProvider({
				id: 'opencode-go',
				headers: { 'x-opencode-session': 'manual-session' },
			}),
			{ sessionId: 'session_test-1' },
		)

		await providerFetch(
			'https://opencode.ai/inference/go/openai/v1/chat/completions',
		)

		const init = fetchMock.mock.calls[0]?.[1]
		expect(new Headers(init?.headers).get('x-opencode-session')).toBe(
			'manual-session',
		)
	})
})
