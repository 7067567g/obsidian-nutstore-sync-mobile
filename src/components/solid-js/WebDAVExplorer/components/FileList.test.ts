import { describe, expect, it } from 'vitest'
import { sortedFileStats, type FileStat } from './FileList'

function stat(path: string, isDir: boolean): FileStat {
	return { path, basename: path.split('/').pop() ?? path, isDir }
}

describe('sortedFileStats', () => {
	it('puts directories before files and sorts names case-insensitively', () => {
		const input = [
			stat('beta.md', false),
			stat('alpha.md', false),
			stat('zeta', true),
			stat('alpha', true),
		]
		const sorted = sortedFileStats(input)
		expect(sorted.map((item) => item.path)).toEqual([
			'alpha',
			'zeta',
			'alpha.md',
			'beta.md',
		])
	})

	it('does not mutate the input array (reactive-state safety)', () => {
		const input = [stat('b.md', false), stat('a', true), stat('a.md', false)]
		const snapshot = input.map((item) => item.path)
		sortedFileStats(input)
		expect(input.map((item) => item.path)).toEqual(snapshot)
	})

	it('returns an empty array unchanged', () => {
		expect(sortedFileStats([])).toEqual([])
	})
})
