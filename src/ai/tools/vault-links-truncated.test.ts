/**
 * R-006 mock evidence (no real device required) for the `vault_links`
 * `truncated` flag (WS-2 待确认).
 *
 * `executeVaultLinks` sets `truncated: outgoing.length >= limit`. When the
 * number of unique outgoing links exactly equals `maxResults`, nothing is
 * dropped but the flag still reports `true`. These tests pin the current
 * behaviour with a mock `App` metadata cache; no Obsidian runtime is needed.
 */
import { describe, expect, it } from 'vitest'
import type { App } from 'obsidian'
import { executeVaultLinks } from './vault-links'

function createApp(linkCount: number) {
	const source = { path: 'notes/a.md', name: 'a.md' }
	const links = Array.from({ length: linkCount }, (_, index) => ({
		link: `target-${index}`,
	}))
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

describe('vault_links truncated flag (R-006 / WS-2)', () => {
	it('reports truncated=true even when the link count exactly equals the limit', async () => {
		const result = JSON.parse(
			await executeVaultLinks(createApp(3), '/notes/a.md', 'outgoing', 3),
		)

		expect(result.outgoing).toHaveLength(3)
		// False positive: exactly `limit` links were found and none dropped.
		expect(result.truncated).toBe(true)
	})

	it('reports truncated=false when below the limit', async () => {
		const result = JSON.parse(
			await executeVaultLinks(createApp(2), '/notes/a.md', 'outgoing', 3),
		)

		expect(result.outgoing).toHaveLength(2)
		expect(result.truncated).toBe(false)
	})
})
