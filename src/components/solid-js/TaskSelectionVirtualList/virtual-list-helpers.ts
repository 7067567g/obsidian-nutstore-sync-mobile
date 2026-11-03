import type { VirtualItem } from '@tanstack/solid-virtual'
import type { TaskSelectionItem } from './TaskSelectionVirtualList'

export interface ScoredItem {
	item: TaskSelectionItem
	originalIndex: number
	score: number
}

export const ALL_TYPE = '__all__'
export const ROW_ESTIMATE = 95
export const SEPARATOR = /[/\\.,\s_-]/
export const estimateSize = () => ROW_ESTIMATE

export function subsequenceScore(text: string, q: string): number {
	if (!q) return 0
	if (text.length < q.length) return -1
	const idx = text.indexOf(q)
	if (idx !== -1) {
		return 10000 - idx + (idx === 0 ? 500 : 0)
	}
	const positions: number[] = []
	let from = 0
	for (let i = 0; i < q.length; i++) {
		const found = text.indexOf(q[i], from)
		if (found === -1) return -1
		positions.push(found)
		from = found + 1
	}
	let score = 1000
	if (positions[0] === 0) score += 500
	let gapUnits = 0
	let boundaryCrossings = 0
	for (let i = 1; i < positions.length; i++) {
		const gap = positions[i] - positions[i - 1] - 1
		if (gap > 0) {
			gapUnits += gap
			for (let j = positions[i - 1] + 1; j < positions[i]; j++) {
				if (SEPARATOR.test(text[j])) boundaryCrossings++
			}
		}
	}
	score -= gapUnits
	score -= boundaryCrossings * 30
	score -= positions[0]
	return score
}

export interface VirtualRow {
	index: number
	start: number
	end: number
}

export function projectRows(items: VirtualItem[]): VirtualRow[] {
	return items
		.filter((v): v is VirtualItem => v != null)
		.map((v) => ({ index: v.index, start: v.start, end: v.end }))
}
