import { describe, expect, it } from 'vitest'
import { remotePathToLocalPath } from './remote-path-to-local-path'

describe('remotePathToLocalPath', () => {
	it('strips the base directory on a full segment boundary', () => {
		expect(remotePathToLocalPath('/a/b', '/a/b/notes/x.md')).toBe('notes/x.md')
	})

	it('does not mistake a sibling prefix for a child of the base', () => {
		// Regression (A16 / WS5-S2-03): `/a/b` used to be sliced out of
		// `/a/bc/d` by a naive startsWith, yielding the bogus `c/d`.
		expect(remotePathToLocalPath('/a/b', '/a/bc/d')).toBe('/a/bc/d')
		expect(remotePathToLocalPath('/a/b', '/a/bcd')).toBe('/a/bcd')
	})

	it('returns an empty path when the remote path equals the base', () => {
		// Regression (A16): `normalize('')` used to yield `.`.
		expect(remotePathToLocalPath('/a/b', '/a/b')).toBe('')
		expect(remotePathToLocalPath('/a/b/', '/a/b')).toBe('')
		expect(remotePathToLocalPath('/', '/')).toBe('')
	})

	it('accepts a base with a trailing slash (stdRemotePath output)', () => {
		expect(remotePathToLocalPath('/a/b/', '/a/b/c.txt')).toBe('c.txt')
	})

	it('leaves relative and unrelated paths untouched', () => {
		expect(remotePathToLocalPath('/a/b', 'notes/x.md')).toBe('notes/x.md')
		expect(remotePathToLocalPath('/a/b', '/other/x.md')).toBe('/other/x.md')
	})
})
