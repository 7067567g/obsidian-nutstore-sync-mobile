import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type BuildOptions = { define: Record<string, unknown> }

const build = vi.hoisted(() => vi.fn(async (_options: BuildOptions) => ({})))
const context = vi.hoisted(() =>
	vi.fn((_options: BuildOptions) => ({
		watch: vi.fn(async () => undefined),
	})),
)

vi.mock('esbuild', () => ({ default: { build, context } }))
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }))
vi.mock('../scripts/esbuild/plugins/index.mjs', () => ({
	createBuildPlugins: () => [],
}))

const ENV_KEYS = [
	'NS_NSDAV_ENDPOINT',
	'NS_DAV_ENDPOINT',
	'LLM_GATEWAY_CLIENT_ID',
	'NODE_ENV',
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key]
	}
	build.mockClear()
	context.mockClear()
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

function capturedOptions(): BuildOptions | undefined {
	return (build.mock.calls[0]?.[0] ?? context.mock.calls[0]?.[0]) as
		| BuildOptions
		| undefined
}

describe('esbuild.config.mjs build-time defines (A23)', () => {
	it('uses string defaults for unset endpoint/client defines', async () => {
		delete process.env.NS_NSDAV_ENDPOINT
		delete process.env.NS_DAV_ENDPOINT
		delete process.env.LLM_GATEWAY_CLIENT_ID

		await import('../esbuild.config.mjs')
		const define = capturedOptions()?.define ?? {}

		const expected: Array<[string, string]> = [
			['process.env.NS_NSDAV_ENDPOINT', 'https://dav.jianguoyun.com/nsdav'],
			['process.env.NS_DAV_ENDPOINT', 'https://dav.jianguoyun.com/dav'],
			['process.env.LLM_GATEWAY_CLIENT_ID', 'dc_obsidian_dp0gymrn'],
		]
		for (const [key, value] of expected) {
			expect(typeof define[key]).toBe('string')
			expect(JSON.parse(define[key] as string)).toBe(value)
		}
	})

	it('keeps explicit env values', async () => {
		process.env.NS_NSDAV_ENDPOINT = 'https://nsdav.example.com'
		process.env.NS_DAV_ENDPOINT = 'https://dav.example.com'
		process.env.LLM_GATEWAY_CLIENT_ID = 'client-xyz'

		await import('../esbuild.config.mjs')
		const define = capturedOptions()?.define ?? {}

		expect(JSON.parse(define['process.env.NS_NSDAV_ENDPOINT'] as string)).toBe(
			'https://nsdav.example.com',
		)
		expect(JSON.parse(define['process.env.NS_DAV_ENDPOINT'] as string)).toBe(
			'https://dav.example.com',
		)
		expect(
			JSON.parse(define['process.env.LLM_GATEWAY_CLIENT_ID'] as string),
		).toBe('client-xyz')
	})
})
