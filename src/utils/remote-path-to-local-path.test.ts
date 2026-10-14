import { describe, expect, it } from 'vitest'
import { remotePathToLocalPath } from './remote-path-to-local-path'
import { stdRemotePath } from './std-remote-path'

describe('remotePathToLocalPath', () => {
	it('strips a stdRemotePath base and returns a vault-relative path', () => {
		expect(remotePathToLocalPath(stdRemotePath('/base'), '/base/a/b.txt')).toBe(
			'a/b.txt',
		)
		expect(
			remotePathToLocalPath(stdRemotePath('/base/inner'), '/base/inner/f.md'),
		).toBe('f.md')
	})

	it('strips a base without a trailing slash without leaking a leading slash', () => {
		expect(remotePathToLocalPath('/base', '/base/a/b.txt')).toBe('a/b.txt')
		expect(remotePathToLocalPath('/base/a', '/base/a/b.txt')).toBe('b.txt')
	})

	it('does not treat a sibling prefix as a child of the base', () => {
		expect(remotePathToLocalPath('/base', '/basex/a.txt')).toBe('/basex/a.txt')
		expect(remotePathToLocalPath(stdRemotePath('/base'), '/base2/a.txt')).toBe(
			'/base2/a.txt',
		)
	})

	it('leaves paths that are not under the base untouched', () => {
		expect(
			remotePathToLocalPath(stdRemotePath('/base'), '/other/x.txt'),
		).toBe('/other/x.txt')
	})

	it('maps the base itself to the vault root', () => {
		expect(remotePathToLocalPath(stdRemotePath('/base'), '/base')).toBe('')
	})
})
