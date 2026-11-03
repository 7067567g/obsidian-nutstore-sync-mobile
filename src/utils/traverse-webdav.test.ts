/**
 * WS-5 / H9 traversal cache regression.
 *
 * The original bug: `applyDeltaToNodes` fabricated `nodes[dir] = []` for a
 * delta-created directory. Because `[]` is truthy, the BFS cache short-circuit
 * treated the directory as "already listed" and never fetched its contents, so
 * pre-existing files stayed invisible and the wrong state was persisted.
 *
 * Fix mechanisms: K19 (only a real listing satisfies the cache; unknown dirs
 * are queued) and K20 (empty/negative listings are only trusted while fresh).
 * F3 (K15) is covered in `traversal-cache-compat.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'

const { getDirectoryContents } = vi.hoisted(() => {
	const contents: Record<string, unknown[]> = {
		'/base/newdir': [
			{
				filename: '/base/newdir/pre-existing.md',
				basename: 'pre-existing.md',
				type: 'file',
				size: 1,
				lastmod: '2026-10-16T00:00:00Z',
			},
		],
		'/base/empty': [],
	}
	return {
		getDirectoryContents: vi.fn(
			async (_settings: unknown, _token: string, path: string) =>
				contents[path] ?? [],
		),
	}
})

vi.mock('~/api/webdav', () => ({ getDirectoryContents }))
vi.mock('~/api/latest-delta-cursor', () => ({
	getLatestDeltaCursor: vi.fn(async () => ({
		response: { cursor: 'cursor-1' },
	})),
}))

import { ResumableWebDAVTraversal } from '~/utils/traverse-webdav'

type DeltaEntryLike = {
	path: string
	isDir: boolean
	isDeleted: boolean
	modified?: number
	size?: number
}

type Internals = {
	nodes: Record<string, Array<{ path: string }>>
	queue: string[]
	rootCursor: string
	listedDirs: Map<string, number>
	emptyDirRevalidateMs: number
	applyDeltaToNodes: (entries: DeltaEntryLike[]) => void
	bfsTraverse: () => Promise<Array<{ path: string }>>
	saveState: () => Promise<void>
}

function makeTraversal() {
	return new ResumableWebDAVTraversal({
		settings: {} as never,
		token: 'token',
		remoteBaseDir: '/base',
		kvKey: 'cache-key',
	}) as unknown as Internals
}

describe('H9 — delta-created directories are not treated as listed', () => {
	it('does not fabricate an empty listing and queues the directory (CT-WS5-H9-1)', () => {
		const traversal = makeTraversal()
		traversal.nodes = {}

		traversal.applyDeltaToNodes([
			{ path: '/base/newdir', isDir: true, isDeleted: false, modified: 1 },
		])

		expect(traversal.nodes['/base/newdir/']).toBeUndefined()
		expect(traversal.queue).toContain('/base/newdir')
	})

	it('re-lists a cached [] node that was never listed and finds its files (CT-WS5-H9-2)', async () => {
		const traversal = makeTraversal()
		// Old/buggy persisted state: the directory exists with a fabricated
		// empty listing that this process never verified.
		traversal.nodes = { '/base/newdir/': [] }
		traversal.queue = ['/base/newdir']
		traversal.rootCursor = ''
		traversal.saveState = async () => {}
		getDirectoryContents.mockClear()

		const results = await traversal.bfsTraverse()

		expect(
			getDirectoryContents.mock.calls.some(
				(call) => call[2] === '/base/newdir',
			),
		).toBe(true)
		expect(results.map((item) => item.path)).toContain(
			'/base/newdir/pre-existing.md',
		)
	})

	it('applies a delta-created directory end to end on the next BFS (CT-WS5-H9-3)', async () => {
		const traversal = makeTraversal()
		traversal.nodes = {}
		traversal.applyDeltaToNodes([
			{ path: '/base/newdir', isDir: true, isDeleted: false, modified: 1 },
		])
		traversal.rootCursor = ''
		traversal.saveState = async () => {}
		getDirectoryContents.mockClear()

		const results = await traversal.bfsTraverse()

		expect(
			getDirectoryContents.mock.calls.some(
				(call) => call[2] === '/base/newdir',
			),
		).toBe(true)
		expect(results.map((item) => item.path)).toContain(
			'/base/newdir/pre-existing.md',
		)
	})
})

describe('H9 — empty (negative) listings have a freshness bound', () => {
	it('serves a freshly listed empty directory from cache, then re-lists after TTL (CT-WS5-H9-4)', async () => {
		const traversal = makeTraversal()
		traversal.nodes = {}
		traversal.queue = ['/base/empty']
		traversal.rootCursor = ''
		traversal.saveState = async () => {}
		getDirectoryContents.mockClear()

		await traversal.bfsTraverse()
		const callsAfterFirst = getDirectoryContents.mock.calls.filter(
			(call) => call[2] === '/base/empty',
		).length
		expect(callsAfterFirst).toBe(1)
		expect(traversal.listedDirs.has('/base/empty/')).toBe(true)

		// Within the freshness window the empty node is trusted.
		traversal.queue = ['/base/empty']
		await traversal.bfsTraverse()
		expect(
			getDirectoryContents.mock.calls.filter(
				(call) => call[2] === '/base/empty',
			).length,
		).toBe(callsAfterFirst)

		// Once stale, the negative result must be revalidated.
		traversal.emptyDirRevalidateMs = 0
		traversal.queue = ['/base/empty']
		await traversal.bfsTraverse()
		expect(
			getDirectoryContents.mock.calls.filter(
				(call) => call[2] === '/base/empty',
			).length,
		).toBe(callsAfterFirst + 1)
	})
})
