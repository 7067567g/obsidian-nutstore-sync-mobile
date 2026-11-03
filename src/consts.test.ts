import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ENV_KEYS = [
	'NS_NSDAV_ENDPOINT',
	'NS_DAV_ENDPOINT',
	'LLM_GATEWAY_CLIENT_ID',
	'PLUGIN_VERSION',
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key]
	}
	vi.resetModules()
})

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) {
			delete process.env[key]
		} else {
			process.env[key] = saved[key]
		}
	}
})

async function importConsts() {
	vi.resetModules()
	return import('./consts')
}

describe('consts build-time fallbacks (A23)', () => {
	it('falls back to the public endpoint defaults when defines are unset', async () => {
		delete process.env.NS_NSDAV_ENDPOINT
		delete process.env.NS_DAV_ENDPOINT
		delete process.env.LLM_GATEWAY_CLIENT_ID

		const consts = await importConsts()

		expect(consts.DEFAULT_NS_NSDAV_ENDPOINT).toBe(
			'https://dav.jianguoyun.com/nsdav',
		)
		expect(consts.DEFAULT_NS_DAV_ENDPOINT).toBe(
			'https://dav.jianguoyun.com/dav',
		)
		expect(consts.LLM_GATEWAY_CLIENT_ID).toBe('dc_obsidian_dp0gymrn')
	})

	it('keeps values provided by the build', async () => {
		process.env.NS_NSDAV_ENDPOINT = 'https://nsdav.example.com'
		process.env.NS_DAV_ENDPOINT = 'https://dav.example.com'
		process.env.LLM_GATEWAY_CLIENT_ID = 'client-123'

		const consts = await importConsts()

		expect(consts.DEFAULT_NS_NSDAV_ENDPOINT).toBe('https://nsdav.example.com')
		expect(consts.DEFAULT_NS_DAV_ENDPOINT).toBe('https://dav.example.com')
		expect(consts.LLM_GATEWAY_CLIENT_ID).toBe('client-123')
	})

	it('treats an empty define as missing instead of exporting undefined', async () => {
		process.env.NS_NSDAV_ENDPOINT = ''
		process.env.NS_DAV_ENDPOINT = ''
		process.env.LLM_GATEWAY_CLIENT_ID = ''

		const consts = await importConsts()

		expect(consts.DEFAULT_NS_NSDAV_ENDPOINT).toBe(
			'https://dav.jianguoyun.com/nsdav',
		)
		expect(consts.DEFAULT_NS_DAV_ENDPOINT).toBe(
			'https://dav.jianguoyun.com/dav',
		)
		expect(consts.LLM_GATEWAY_CLIENT_ID).toBe('dc_obsidian_dp0gymrn')
	})
})
