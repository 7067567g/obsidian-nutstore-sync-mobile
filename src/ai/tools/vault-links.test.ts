import { describe, expect, it } from 'vitest'
import type { App } from 'obsidian'
import { executeVaultLinks } from './vault-links'

function createApp() {
	const source = { path: 'notes/a.md', name: 'a.md' }
	const target = { path: 'notes/b.md', name: 'b.md' }
	const other = { path: 'notes/other.md', name: 'other.md' }
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) =>
				path === source.path ? source : null,
			getMarkdownFiles: () => [source, target, other],
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => ({
				links: file.path === source.path ? [{ link: 'b' }] : [],
				embeds: [],
				frontmatterLinks: [{ link: 'missing' }],
				frontmatter:
					file.path === source.path
						? { 'see-also': ['notes/b.md'] }
						: file.path === other.path
							? { 'see-also': ['notes/a.md'] }
							: {},
			}),
			getFirstLinkpathDest: (link: string) => {
				if (link === 'b' || link === 'notes/b.md') return target
				if (link === 'notes/a.md') return source
				return null
			},
			resolvedLinks: {
				'notes/a.md': { 'notes/b.md': 1 },
				'notes/c.md': { 'notes/a.md': 2 },
			},
		},
	} as unknown as App
	return app
}

describe('vault_links', () => {
	it('returns outgoing and incoming links from metadata cache', async () => {
		const result = JSON.parse(
			await executeVaultLinks(createApp(), '/notes/a.md', 'both'),
		)
		expect(result.outgoing).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ target: 'notes/b.md' }),
				expect.objectContaining({ link: 'missing', unresolved: true }),
			]),
		)
		expect(result.incoming).toEqual([{ source: 'notes/c.md', count: 2 }])
	})

	it('resolves plain frontmatter path fields when frontmatterKeys are provided', async () => {
		const result = JSON.parse(
			await executeVaultLinks(createApp(), '/notes/a.md', 'both', 50, [
				'see-also',
			]),
		)
		expect(result.outgoing).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'frontmatter:see-also',
					target: 'notes/b.md',
				}),
			]),
		)
		expect(result.incoming).toEqual(
			expect.arrayContaining([
				{ source: 'notes/c.md', count: 2 },
				{ source: 'notes/other.md', count: 1 },
			]),
		)
	})
})
