import { createSignal } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { sortedFileStats, type FileStat } from './FileList'

function stat(path: string, isDir: boolean): FileStat {
	return { path, basename: path.split('/').pop() ?? path, isDir }
}

describe('sortedFileStats', () => {
	it('puts directories before files and sorts names by locale', () => {
		const input = [
			stat('beta.md', false),
			stat('alpha.md', false),
			stat('zeta', true),
			stat('alpha', true),
		]
		expect(sortedFileStats(input).map((item) => item.path)).toEqual([
			'alpha',
			'zeta',
			'alpha.md',
			'beta.md',
		])
	})

	it('does not mutate the input array (reactive signal safety)', () => {
		const input = [stat('b.md', false), stat('a', true), stat('a.md', false)]
		const snapshot = input.map((item) => item.path)
		const originalRef = input
		sortedFileStats(input)
		expect(input).toBe(originalRef)
		expect(input.map((item) => item.path)).toEqual(snapshot)
	})

	it('keeps the reference stored in the items signal intact', () => {
		const [items] = createSignal<FileStat[]>([
			stat('b.md', false),
			stat('a', true),
		])
		const signalRef = items()
		const snapshot = items().map((item) => item.path)
		sortedFileStats(items())
		expect(items()).toBe(signalRef)
		expect(items().map((item) => item.path)).toEqual(snapshot)
	})

	it('returns a new array for the empty input', () => {
		const input: FileStat[] = []
		const sorted = sortedFileStats(input)
		expect(sorted).toEqual([])
		expect(sorted).not.toBe(input)
	})
})
