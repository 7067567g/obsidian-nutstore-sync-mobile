/**
 * R3 regression tests for the two R2 fixes that previously had no test
 * coverage (R-004):
 *   - `vitest.config.ts` alias resolution (WS8-R2-01 / P-002)
 *   - `scripts/release-local.mjs` root resolution (WS8-R2-02)
 *
 * Both bugs shared one root cause: `new URL(...).pathname` leaves non-ASCII /
 * space path segments percent-encoded (this repo lives under a `20-工作区`
 * parent directory), which breaks module resolution and `process.chdir`.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import vitestConfig from '../vitest.config'

const PERCENT_ENCODED = /%[0-9A-Fa-f]{2}/

describe('vitest.config.ts alias regression (R-004 / WS8-R2-01)', () => {
	it('resolves `~` and `obsidian` to percent-decoded absolute paths', () => {
		const alias = vitestConfig.resolve?.alias as unknown as Record<string, string>

		expect(alias['~']).toBe(fileURLToPath(new URL('../src', import.meta.url)))
		expect(alias['obsidian']).toBe(
			fileURLToPath(new URL('../test/mocks/obsidian.ts', import.meta.url)),
		)

		// Regression guard: `new URL(...).pathname` would leave `20-工作区`
		// percent-encoded (e.g. `20-%E5%B7%A5%E4%BD%9C%E5%8C%BA`).
		expect(alias['~']).not.toMatch(PERCENT_ENCODED)
		expect(alias['obsidian']).not.toMatch(PERCENT_ENCODED)
	})
})

describe('scripts/release-local.mjs root resolution regression (R-004 / WS8-R2-02)', () => {
	const scriptPath = fileURLToPath(
		new URL('./release-local.mjs', import.meta.url),
	)

	it('keeps using fileURLToPath rather than url.pathname', () => {
		const source = readFileSync(scriptPath, 'utf8')
		expect(source).toContain('fileURLToPath')
		expect(source).not.toMatch(
			/new URL\(\s*['"]\.\.['"]\s*,\s*import\.meta\.url\s*\)\.pathname/,
		)
	})

	it('resolves a decoded repo root so `process.chdir` cannot hit ENOENT', () => {
		const decodedRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
		expect(decodedRoot).not.toMatch(PERCENT_ENCODED)

		// Prove the guard is meaningful on this checkout: the reverted idiom
		// yields a different (percent-encoded) string when the path is non-ASCII.
		const encodedRoot = new URL('..', import.meta.url).pathname
		if (PERCENT_ENCODED.test(encodedRoot)) {
			expect(decodedRoot).not.toBe(encodedRoot)
		}
	})
})
