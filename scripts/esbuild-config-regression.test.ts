/**
 * P-007 regression test for the R2 fix in `esbuild.config.mjs`.
 *
 * Without a `.env`, `process.env.NS_NSDAV_ENDPOINT` (and friends) are
 * `undefined`, and `JSON.stringify(undefined)` yields `undefined` (not a
 * string), which esbuild rejects as a `define` value → `pnpm build` crashed.
 * The fix supplies public fallback defaults. This test imports the real config
 * with `esbuild`/`dotenv`/plugins mocked, captures `buildOptions.define`, and
 * asserts the fallbacks (and the env override path) are in place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const build = vi.hoisted(() => vi.fn())
const context = vi.hoisted(() => vi.fn())

vi.mock('esbuild', () => ({ default: { build, context } }))
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }))
vi.mock('../scripts/esbuild/plugins/index.mjs', () => ({
	createBuildPlugins: () => [],
}))

const ENV_KEYS = [
	'NS_NSDAV_ENDPOINT',
	'NS_DAV_ENDPOINT',
	'LLM_GATEWAY_CLIENT_ID',
] as const
const ORIGINAL_ARGV = process.argv

async function loadConfig() {
	vi.resetModules()
	await import('../esbuild.config.mjs')
	return build.mock.calls[0]?.[0] as { define: Record<string, string> }
}

function definedKeys(define: Record<string, string>) {
	return [
		'process.env.NS_NSDAV_ENDPOINT',
		'process.env.NS_DAV_ENDPOINT',
		'process.env.LLM_GATEWAY_CLIENT_ID',
	].map((key) => define[key])
}

describe('esbuild.config.mjs env default regression (P-007)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		process.argv = ['node', 'esbuild.config.mjs', 'production']
		for (const key of ENV_KEYS) {
			delete process.env[key]
		}
	})

	afterEach(() => {
		process.argv = ORIGINAL_ARGV
	})

	it('falls back to public endpoints/ids when env vars are unset', async () => {
		const options = await loadConfig()

		// Every define value must be a real JSON string (never `undefined`),
		// otherwise esbuild rejects the build.
		for (const value of definedKeys(options.define)) {
			expect(typeof value).toBe('string')
		}
		expect(options.define['process.env.NS_NSDAV_ENDPOINT']).toBe(
			JSON.stringify('https://dav.jianguoyun.com/nsdav'),
		)
		expect(options.define['process.env.NS_DAV_ENDPOINT']).toBe(
			JSON.stringify('https://dav.jianguoyun.com/dav'),
		)
		expect(options.define['process.env.LLM_GATEWAY_CLIENT_ID']).toBe(
			JSON.stringify('dc_obsidian_dp0gymrn'),
		)
	})

	it('uses the provided env var when it is set', async () => {
		process.env.NS_NSDAV_ENDPOINT = 'https://custom.example/nsdav'

		const options = await loadConfig()

		expect(options.define['process.env.NS_NSDAV_ENDPOINT']).toBe(
			JSON.stringify('https://custom.example/nsdav'),
		)
	})
})
