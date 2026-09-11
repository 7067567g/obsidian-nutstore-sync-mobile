/**
 * Minimal runtime stub for the type-only `obsidian` package used by Vitest.
 * Keep this small: it only implements APIs exercised by unit tests.
 */
export function normalizePath(path: string) {
	return path
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
}

export class Vault {}

export const apiVersion = '1.13.7'

export const Platform = {
	isMobileApp: false,
	isMobile: false,
}

export function requestUrl() {
	throw new Error('requestUrl is not implemented in unit tests')
}

export function stringifyYaml(value: Record<string, unknown>) {
	return (
		Object.entries(value)
			.map(([key, item]) => key + ': ' + JSON.stringify(item))
			.join('\n') + '\n'
	)
}

export function parseYaml(text: string): Record<string, unknown> {
	const result: Record<string, unknown> = {}
	for (const line of text.split(/\r?\n/)) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
		if (!match) continue
		const value = match[2].trim()
		result[match[1]] = value === '' ? [] : value
	}
	return result
}

export function loadPdfJs(): Promise<never> {
	return Promise.reject(new Error('loadPdfJs is not implemented in unit tests'))
}
