import { describe, expect, it } from 'vitest'

import { isTraversalCacheCompatible } from './traversal-cache-compat'

/**
 * WS-5 / H9-F3 (K15 validator): the traversal cache compatibility gate must
 * fail closed. A cache key that is not absolute cannot be proven to belong to
 * the configured remote base dir, so it must be rejected instead of being
 * treated as "belongs to any base".
 */
describe('isTraversalCacheCompatible', () => {
	it('accepts absolute paths under the configured base dir', () => {
		expect(
			isTraversalCacheCompatible(
				{ rootCursor: 'c', queue: ['/base/x/'], nodes: {} } as never,
				'/base',
			),
		).toBe(true)
	})

	it('rejects absolute paths outside the configured base dir', () => {
		expect(
			isTraversalCacheCompatible(
				{ rootCursor: 'c', queue: ['/other/x/'], nodes: {} } as never,
				'/base',
			),
		).toBe(false)
	})

	it('rejects relative queue paths instead of failing open (CT-WS5-F3-1)', () => {
		expect(
			isTraversalCacheCompatible(
				{
					rootCursor: 'c',
					queue: ['some/relative/path'],
					nodes: {},
				} as never,
				'/completely/different/base',
			),
		).toBe(false)
	})

	it('rejects a relative node directory key', () => {
		expect(
			isTraversalCacheCompatible(
				{
					rootCursor: 'c',
					queue: [],
					nodes: { 'relative/dir/': [] },
				} as never,
				'/base',
			),
		).toBe(false)
	})

	it('rejects a relative stat path inside a node', () => {
		expect(
			isTraversalCacheCompatible(
				{
					rootCursor: 'c',
					queue: [],
					nodes: {
						'/base/dir/': [{ path: 'relative/file.md', isDir: false } as never],
					},
				} as never,
				'/base',
			),
		).toBe(false)
	})
})
