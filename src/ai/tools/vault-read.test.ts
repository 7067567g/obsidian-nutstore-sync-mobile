import { describe, expect, it } from 'vitest'
import type { App } from 'obsidian'
import { executeVaultRead } from './vault-read'

function createApp(
	options: { size?: number | null; node?: boolean; content?: string } = {},
) {
	const content = options.content ?? 'line 1\nline 2'
	const file = { path: 'notes/a.md', name: 'a.md', extension: 'md' }
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) =>
				options.node === false ? null : path === file.path ? file : null,
			cachedRead: async () => content,
			read: async () => content,
			adapter: {
				read: async () => content,
				stat: async () => {
					if (options.size === null) return null
					return {
						type: 'file' as const,
						size: options.size ?? content.length,
					}
				},
			},
		},
	} as unknown as App
	return app
}

describe('executeVaultRead size guard (A02)', () => {
	it('stats through the adapter when the vault node has no known size', async () => {
		const result = await executeVaultRead(createApp(), '/notes/a.md', 1, 10)
		expect(result.text).toContain('line 2')
	})

	it('fails closed when the size cannot be determined', async () => {
		await expect(
			executeVaultRead(
				createApp({ node: false, size: null }),
				'/notes/a.md',
				1,
				10,
			),
		).rejects.toThrow('Unable to determine the size')
	})

	it('rejects a file above the 5MiB mobile limit', async () => {
		await expect(
			executeVaultRead(
				createApp({ node: false, size: 5 * 1024 * 1024 + 1 }),
				'/notes/a.md',
				1,
				10,
			),
		).rejects.toThrow('too large for mobile vault_read')
	})

	it('reads an explicit hidden adapter file when it reports a size', async () => {
		const result = await executeVaultRead(
			createApp(),
			'/.obsidian/app.json',
			1,
			10,
		)
		expect(result.text).toContain('line 1')
	})

	it('clamps an offset past EOF so the range never inverts', async () => {
		const result = await executeVaultRead(
			createApp({ content: 'one\ntwo\nthree' }),
			'/notes/a.md',
			100,
			10,
		)
		expect(result.text).toBe('')
		expect(result.header).toContain('no lines in range')
		expect(result.header).not.toMatch(/lines\s+100-3/)
	})
})
