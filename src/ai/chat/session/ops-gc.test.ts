import { describe, expect, it, vi } from 'vitest'
import { runOpsGc, type OpsGcBackend } from './ops-gc'

function createBackend(): OpsGcBackend & {
	removed: string[]
} {
	const removed: string[] = []
	return {
		removed,
		async listSessionIds() {
			return ['session-a', 'session-corrupt']
		},
		async readSessionOperationRefPaths(id) {
			if (id === 'session-corrupt') throw new Error('corrupt session')
			return ['.agents/nutstore-sync/ops/session-a/keep.json']
		},
		async listOperationFiles() {
			return [
				{ path: '.agents/nutstore-sync/ops/session-a/keep.json', size: 10 },
				{ path: '.agents/nutstore-sync/ops/session-a/orphan.json', size: 20 },
				{ path: '.agents/nutstore-sync/ops/session-b/orphan.json', size: 30 },
			]
		},
		async removeOperationFiles(paths) {
			removed.push(...paths)
		},
	}
}

describe('ops GC', () => {
	it('reports orphan files without deleting them by default', async () => {
		const backend = createBackend()
		const report = await runOpsGc(backend)

		expect(report.mode).toBe('report')
		expect(report.orphanFiles).toHaveLength(2)
		expect(report.orphanBytes).toBe(50)
		expect(backend.removed).toEqual([])
		expect(report.errors).toEqual(['session-corrupt: corrupt session'])
	})

	it('deletes only orphan files when deletion is explicitly requested', async () => {
		const backend = createBackend()
		const removeSpy = vi.spyOn(backend, 'removeOperationFiles')
		const report = await runOpsGc(backend, { deleteOrphans: true })

		expect(report.mode).toBe('delete')
		expect(report.deletedFiles).toHaveLength(2)
		expect(removeSpy).toHaveBeenCalledWith([
			'.agents/nutstore-sync/ops/session-a/orphan.json',
			'.agents/nutstore-sync/ops/session-b/orphan.json',
		])
	})
})
