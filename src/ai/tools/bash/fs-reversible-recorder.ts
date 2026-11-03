import type { ReversibleFileSnapshot, ReversibleToolOp } from '~/ai/chat/types'
import {
	decodeReversibleFileSnapshot,
	isSkippedFileSnapshot,
} from '~/ai/chat/messages/reversible-content'
import { getPathDepth } from './fs-path-index'

export class ReversibleOpRecorder {
	private captureDepth = 0
	private readonly virtualInitial = new Map<
		string,
		ReversibleFileSnapshot | { kind: 'dir' } | undefined
	>()
	private readonly virtualLatest = new Map<
		string,
		ReversibleFileSnapshot | { kind: 'dir' } | undefined
	>()

	get isCapturing() {
		return this.captureDepth > 0
	}
	beginCapture() {
		this.captureDepth++
	}
	endCapture() {
		this.captureDepth--
	}

	recordVirtualTransition(
		path: string,
		before: ReversibleFileSnapshot | { kind: 'dir' } | undefined,
		after: ReversibleFileSnapshot | { kind: 'dir' } | undefined,
	) {
		if (!this.virtualInitial.has(path)) this.virtualInitial.set(path, before)
		this.virtualLatest.set(path, after)
	}

	private async sameFileContent(
		left: Extract<ReversibleToolOp, { operation: 'update' }>['before'],
		right: Extract<ReversibleToolOp, { operation: 'update' }>['before'],
	) {
		if (isSkippedFileSnapshot(left) || isSkippedFileSnapshot(right)) {
			// Without retained content we cannot prove equality; keep the
			// transition recorded so the operation is not silently dropped.
			return false
		}
		const [leftBuffer, rightBuffer] = await Promise.all([
			decodeReversibleFileSnapshot(left),
			decodeReversibleFileSnapshot(right),
		])
		const leftBytes = new Uint8Array(leftBuffer)
		const rightBytes = new Uint8Array(rightBuffer)
		return (
			leftBytes.length === rightBytes.length &&
			leftBytes.every((byte, index) => byte === rightBytes[index])
		)
	}

	async getNetOperations(): Promise<ReversibleToolOp[]> {
		const result: ReversibleToolOp[] = []
		for (const [path, initial] of [...this.virtualInitial].sort(
			([left], [right]) => {
				const depth = getPathDepth(left) - getPathDepth(right)
				return depth !== 0 ? depth : left.localeCompare(right)
			},
		)) {
			const after = this.virtualLatest.get(path)
			if (!initial && after) {
				result.push({
					vaultPath: path,
					operation: 'create',
					before: { kind: after.kind },
					after,
				})
			} else if (initial && !after) {
				result.push({ vaultPath: path, operation: 'delete', before: initial })
			} else if (initial?.kind === 'file' && after?.kind === 'file') {
				if (!(await this.sameFileContent(initial, after))) {
					result.push({
						vaultPath: path,
						operation: 'update',
						before: initial,
						after,
					})
				}
			} else if (initial && after && initial.kind !== after.kind) {
				result.push({ vaultPath: path, operation: 'delete', before: initial })
				result.push({
					vaultPath: path,
					operation: 'create',
					before: { kind: after.kind },
					after,
				})
			}
		}
		return result
	}
}
