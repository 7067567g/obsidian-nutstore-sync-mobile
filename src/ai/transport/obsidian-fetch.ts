import { getReasonPhrase } from 'http-status-codes'
import { raceWithAbort } from './abortable'
import { throwIfAborted } from './abort'
import requestUrl from '~/utils/request-url'

function toHeadersRecord(headers?: HeadersInit) {
	if (!headers) {
		return undefined
	}

	if (headers instanceof Headers) {
		const entries: Array<[string, string]> = []
		headers.forEach((value, key) => {
			entries.push([key, value])
		})
		return Object.fromEntries(entries)
	}
	if (Array.isArray(headers)) {
		return Object.fromEntries(headers)
	}
	return { ...headers }
}

/**
 * The Fetch `Response` constructor only accepts status codes in [200, 599].
 * Obsidian's `requestUrl` can surface 1xx informational responses or
 * non-standard codes; map those into the valid range so building a `Response`
 * never throws `RangeError`.
 */
function toResponseStatus(status: number): number {
	if (status < 200) {
		// Informational: the request produced no final body; treat it as 200.
		return 200
	}
	if (status > 599) {
		// Non-standard: keep "error" semantics instead of turning it into 200.
		return 500
	}
	return status
}

async function toRequestParts(input: RequestInfo | URL, init?: RequestInit) {
	if (input instanceof Request) {
		return {
			url: input.url,
			method: init?.method || input.method,
			headers: toHeadersRecord(init?.headers || input.headers),
			body: init?.body
				? await new Response(init.body).arrayBuffer()
				: input.method === 'GET' || input.method === 'HEAD'
					? undefined
					: await input.arrayBuffer(),
		}
	}

	return {
		url: input instanceof URL ? input.toString() : String(input),
		method: init?.method || 'GET',
		headers: toHeadersRecord(init?.headers),
		body: init?.body ? await new Response(init.body).arrayBuffer() : undefined,
	}
}

export const obsidianFetch: typeof fetch = async (
	input: RequestInfo | URL,
	init?: RequestInit,
) => {
	const signal = init?.signal ?? undefined
	throwIfAborted(signal)
	const request = await toRequestParts(input, init)
	const response = await raceWithAbort(
		requestUrl({
			url: request.url,
			method: request.method,
			headers: request.headers,
			body: request.body,
			throw: false,
		}),
		signal,
	)
	throwIfAborted(signal)
	const status = toResponseStatus(response.status)
	const statusText = getReasonPhrase(status)

	return new Response(
		[101, 103, 204, 205, 304].includes(response.status)
			? null
			: response.arrayBuffer,
		{
			status,
			statusText,
			headers: response.headers,
		},
	)
}
