import type { DataAdapter, Vault } from 'obsidian'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '~/utils/sha256'
import {
	TOOL_OUTPUT_INLINE_BUDGET_BYTES,
	TOOL_OUTPUT_OMISSION_MARKER,
	TOOL_OUTPUT_SPILL_ROOT,
	ToolOutputRetention,
	formatSpillNotice,
	hasSpillNotice,
	hydrateToolOutput,
	removeSessionSpill,
	retainToolOutputText,
	spillToolOutput,
} from './tool-output-retention'

function createFakeVault() {
	const files = new Map<string, string>()
	const dirs = new Set<string>()
	const adapter = {
		async stat(path: string) {
			if (files.has(path)) return { type: 'file' }
			if (dirs.has(path)) return { type: 'folder' }
			return null
		},
		async mkdir(path: string) {
			dirs.add(path)
		},
		async write(path: string, data: string) {
			files.set(path, data)
		},
		async read(path: string) {
			const value = files.get(path)
			if (value === undefined) throw new Error(`ENOENT: ${path}`)
			return value
		},
		async rmdir(path: string, recursive?: boolean) {
			dirs.delete(path)
			if (!recursive) return
			for (const key of [...files.keys()]) {
				if (key.startsWith(`${path}/`)) files.delete(key)
			}
		},
	} as unknown as DataAdapter
	const vault = {
		adapter,
		configDir: '.obsidian',
		getAbstractFileByPath: () => null,
	} as unknown as Vault
	return { vault, files, dirs }
}

function loneSurrogatePattern(text: string) {
	return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
		text,
	)
}

describe('retainToolOutputText', () => {
	it('keeps short output unchanged', () => {
		const text = 'short output'
		const retained = retainToolOutputText(text)
		expect(retained).toEqual({
			preview: text,
			omittedBytes: 0,
			truncated: false,
		})
	})

	it('keeps head and tail around the omission marker', () => {
		const head = 'H'.repeat(5000)
		const middle = 'M'.repeat(5000)
		const tail = 'T'.repeat(2000)
		const retained = retainToolOutputText(`${head}${middle}${tail}`)
		expect(retained.truncated).toBe(true)
		expect(retained.preview.startsWith('H')).toBe(true)
		expect(retained.preview.endsWith('T')).toBe(true)
		expect(retained.preview).toContain(TOOL_OUTPUT_OMISSION_MARKER)
		expect(retained.omittedBytes).toBeGreaterThan(0)
		expect(new TextEncoder().encode(retained.preview).byteLength).toBeLessThan(
			TOOL_OUTPUT_INLINE_BUDGET_BYTES + 200,
		)
	})

	it('never splits a UTF-8 sequence at either cut', () => {
		const text = '中'.repeat(4000) + '🙂'.repeat(1000)
		const retained = retainToolOutputText(text)
		expect(retained.truncated).toBe(true)
		expect(retained.preview).not.toContain('\uFFFD')
		expect(loneSurrogatePattern(retained.preview)).toBe(false)
		const omitted =
			new TextEncoder().encode(text).byteLength -
			new TextEncoder().encode(retained.preview).byteLength +
			new TextEncoder().encode(TOOL_OUTPUT_OMISSION_MARKER).byteLength
		expect(retained.omittedBytes).toBe(omitted)
	})

	it('bounds a 1 MB output to a small preview with exact omitted bytes', () => {
		const text = 'x'.repeat(1_000_000)
		const retained = retainToolOutputText(text)
		expect(retained.truncated).toBe(true)
		expect(new TextEncoder().encode(retained.preview).byteLength).toBeLessThan(
			6000,
		)
		expect(retained.omittedBytes).toBeGreaterThan(990_000)
	})
})

describe('spillToolOutput', () => {
	it('writes full text plus sidecar and hydrates with hash verification', async () => {
		const { vault, files } = createFakeVault()
		const text = `prefix-${'x'.repeat(9000)}-suffix`
		const ref = await spillToolOutput(vault, 'session_test', text, {
			toolName: 'bash',
			toolCallId: 'call_1',
		})
		expect(ref.locator.startsWith(`${TOOL_OUTPUT_SPILL_ROOT}/session-`)).toBe(
			true,
		)
		expect(files.get(ref.locator)).toBe(text)
		expect(await sha256Hex(new TextEncoder().encode(text))).toBe(ref.hash)
		const hydrated = await hydrateToolOutput(vault, ref.locator)
		expect(hydrated.text).toBe(text)
		expect(hydrated.meta?.hash).toBe(ref.hash)
		expect(hydrated.meta?.omittedBytes).toBe(0)
	})

	it('rejects a locator outside the spill root', async () => {
		const { vault } = createFakeVault()
		await expect(
			hydrateToolOutput(vault, '.agents/other/x.txt'),
		).rejects.toThrow('Invalid tool-output spill locator')
	})
})

describe('ToolOutputRetention', () => {
	it('truncates, spills and keeps the notice hydratable', async () => {
		const { vault } = createFakeVault()
		const retention = new ToolOutputRetention(vault)
		const text = `head-${'z'.repeat(20000)}-tail`
		const output = await retention.retain('session_test', text, {
			toolName: 'bash',
		})
		expect(hasSpillNotice(output)).toBe(true)
		expect(output).toContain(TOOL_OUTPUT_OMISSION_MARKER)
		const locator = /Full result stored at: (.+?)\. Use /.exec(output)?.[1]
		expect(locator).toBeTruthy()
		const hydrated = await retention.hydrate(locator!)
		expect(hydrated.text).toBe(text)
		expect(hydrated.meta?.omittedBytes).toBeGreaterThan(0)
	})

	it('keeps original text when spill storage fails', async () => {
		const { vault } = createFakeVault()
		const failing = {
			...vault,
			adapter: {
				...vault.adapter,
				write: async () => {
					throw new Error('disk full')
				},
			},
		} as unknown as Vault
		const retention = new ToolOutputRetention(failing)
		const text = 'q'.repeat(20000)
		await expect(retention.retain('session_test', text)).resolves.toBe(text)
	})

	it('does not re-spill text that already carries a notice', async () => {
		const { vault } = createFakeVault()
		const retention = new ToolOutputRetention(vault)
		const notice = formatSpillNotice(10, {
			locator: `${TOOL_OUTPUT_SPILL_ROOT}/session-abc/file.txt`,
			retrievalHint: 'hint',
			hash: 'a'.repeat(64),
			bytes: 100,
			omittedBytes: 10,
			createdAt: 1,
		})
		await expect(retention.retain('session_test', notice)).resolves.toBe(notice)
	})

	it('removes a session spill directory recursively', async () => {
		const { vault, files, dirs } = createFakeVault()
		const ref = await spillToolOutput(vault, 'session_test', 'content')
		await removeSessionSpill(vault, 'session_test')
		expect(files.has(ref.locator)).toBe(false)
		expect([...dirs].some((path) => path.includes('session-'))).toBe(false)
	})
})
