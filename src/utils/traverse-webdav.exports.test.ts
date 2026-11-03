import { describe, expect, it } from 'vitest'
import * as traverseWebdav from './traverse-webdav'

/**
 * P9 export-contract lock for `~/utils/traverse-webdav`.
 *
 * The public value export surface is frozen by the interface-freeze task:
 * only the traversal class is exported as a runtime value; the progress
 * payload is a type-only export. The retry/state modules added by the split
 * are internal implementation details of this module and must not leak into
 * this module's public surface.
 */
describe('traverse-webdav export contract', () => {
	it('keeps the public runtime export surface stable', () => {
		expect(Object.keys(traverseWebdav).sort()).toEqual([
			'ResumableWebDAVTraversal',
		])
	})
})
