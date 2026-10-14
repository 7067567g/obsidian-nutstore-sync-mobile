import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestUrl = vi.hoisted(() => vi.fn())

vi.mock('~/utils/request-url', () => ({ default: requestUrl }))

import { obsidianFetch } from './obsidian-fetch'

function makeResponse(status = 200) {
	return {
		status,
		headers: { 'content-type': 'application/json' },
		arrayBuffer: new TextEncoder().encode('{"ok":true}').buffer,
	}
}

describe('obsidianFetch', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		requestUrl.mockResolvedValue(makeResponse())
	})

	it('forwards a string URL as a GET without a body', async () => {
		const response = await obsidianFetch('https://example.com/data')

		expect(requestUrl).toHaveBeenCalledWith({
			url: 'https://example.com/data',
			method: 'GET',
			headers: undefined,
			body: undefined,
			throw: false,
		})
		expect(response.status).toBe(200)
		expect(response.statusText).toBe('OK')
		await expect(response.text()).resolves.toBe('{"ok":true}')
	})

	it('forwards method, headers and serialized body', async () => {
		await obsidianFetch('https://example.com/data', {
			method: 'POST',
			headers: { 'x-token': 'abc' },
			body: 'payload',
		})

		const arg = requestUrl.mock.calls.at(-1)?.[0] as {
			method: string
			headers: Record<string, string>
			body: ArrayBuffer
		}
		expect(arg.method).toBe('POST')
		expect(arg.headers).toEqual({ 'x-token': 'abc' })
		expect(new TextDecoder().decode(arg.body)).toBe('payload')
	})

	it('preserves request method, headers and body from a Request input', async () => {
		const request = new Request('https://example.com/upload', {
			method: 'POST',
			headers: { 'x-upload': '1' },
			body: 'request-body',
		})

		await obsidianFetch(request)

		const arg = requestUrl.mock.calls.at(-1)?.[0] as {
			url: string
			method: string
			headers: Record<string, string>
			body: ArrayBuffer
		}
		expect(arg.url).toBe('https://example.com/upload')
		expect(arg.method).toBe('POST')
		expect(arg.headers).toMatchObject({ 'x-upload': '1' })
		expect(new TextDecoder().decode(arg.body)).toBe('request-body')
	})

	it('omits the body for bodiless statuses', async () => {
		requestUrl.mockResolvedValue({ status: 204, headers: {}, arrayBuffer: null })

		const response = await obsidianFetch('https://example.com/data')

		expect(response.status).toBe(204)
		const body = await response.arrayBuffer()
		expect(body.byteLength).toBe(0)
	})

	it('rejects before issuing a request when the signal is already aborted', async () => {
		const controller = new AbortController()
		controller.abort()

		await expect(
			obsidianFetch('https://example.com/data', { signal: controller.signal }),
		).rejects.toThrow()
		expect(requestUrl).not.toHaveBeenCalled()
	})
})
