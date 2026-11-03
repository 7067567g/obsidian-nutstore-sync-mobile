/**
 * A05 regression for the `vault_links` `truncated` flag.
 *
 * `executeVaultLinks` used to set `truncated: outgoing.length >= limit`, which
 * reported `true` when the number of unique outgoing links exactly equalled
 * `maxResults` even though nothing was dropped. It now reports `truncated` only
 * when a unique target beyond the limit was really discarded. These tests pin
 * that behaviour with a mock `App` metadata cache; no Obsidian runtime needed.
 */
import { describe, expect, it } from 'vitest'
import type { App } from 'obsidian'
import { executeVaultLinks } from './vault-links'

function createAppWithLinks(linkValues: string[]) {
	const source = { path: 'notes/a.md', name: 'a.md' }
	const links = linkValues.map((link) => ({ link }))
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) =>
				path === source.path ? source : null,
			getMarkdownFiles: () => [source],
		},
		metadataCache: {
			getFileCache: () => ({
				links,
				embeds: [],
				frontmatterLinks: [],
				frontmatter: {},
			}),
			getFirstLinkpathDest: () => null,
			resolvedLinks: {},
		},
	} as unknown as App
	return app
}

function createApp(linkCount: number) {
	return createAppWithLinks(
		Array.from({ length: linkCount }, (_, index) => `target-${index}`),
	)
}

describe('vault_links truncated flag (A05)', () => {
	it('reports truncated=false when the link count exactly equals the limit', async () => {
		const result = JSON.parse(
			await executeVaultLinks(createApp(3), '/notes/a.md', 'outgoing', 3),
		)

		expect(result.outgoing).toHaveLength(3)
		expect(result.truncated).toBe(false)
	})

	it('reports truncated=true when a unique link is dropped past the limit', async () => {
		const result = JSON.parse(
			await executeVaultLinks(createApp(4), '/notes/a.md', 'outgoing', 3),
		)

		expect(result.outgoing).toHaveLength(3)
		expect(result.truncated).toBe(true)
	})

	it('does not treat duplicate links past the limit as truncation', async () => {
		const result = JSON.parse(
			await executeVaultLinks(
				createAppWithLinks(['a', 'a', 'a', 'a']),
				'/notes/a.md',
				'outgoing',
				3,
			),
		)

		expect(result.outgoing).toHaveLength(1)
		expect(result.truncated).toBe(false)
	})

	it('reports truncated=false when below the limit', async () => {
		const result = JSON.parse(
			await executeVaultLinks(createApp(2), '/notes/a.md', 'outgoing', 3),
		)

		expect(result.outgoing).toHaveLength(2)
		expect(result.truncated).toBe(false)
	})
})
