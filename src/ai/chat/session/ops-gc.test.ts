import { describe, expect, it, vi } from 'vitest'
import {
	formatOpsGcReport,
	runOpsGc,
	type OpsGcBackend,
	type RetentionFile,
} from './ops-gc'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

function createBackend(
	options: {
		sessionListFails?: boolean
		sessionReadFails?: boolean
		retentionFiles?: RetentionFile[]
		orphanMtimes?: Record<string, number>
	} = {},
): OpsGcBackend & {
	removed: string[]
	removedRetention: string[]
} {
	const removed: string[] = []
	const removedRetention: string[] = []
	return {
		removed,
		removedRetention,
		async listSessionIds() {
			if (options.sessionListFails) throw new Error('index unreadable')
			return ['session-a', 'session-corrupt']
		},
		async readSessionOperationRefPaths(id) {
			if (options.sessionReadFails || id === 'session-corrupt') {
				throw new Error('corrupt session')
			}
			return ['.agents/nutstore-sync/ops/session-a/keep.json']
		},
		async listOperationFiles() {
			return [
				{ path: '.agents/nutstore-sync/ops/session-a/keep.json', size: 10 },
				{
					path: '.agents/nutstore-sync/ops/session-a/orphan.json',
					size: 20,
					mtime:
						options.orphanMtimes?.[
							'.agents/nutstore-sync/ops/session-a/orphan.json'
						],
				},
				{
					path: '.agents/nutstore-sync/ops/session-b/orphan.json',
					size: 30,
					mtime:
						options.orphanMtimes?.[
							'.agents/nutstore-sync/ops/session-b/orphan.json'
						],
				},
			]
		},
		async removeOperationFiles(paths) {
			removed.push(...paths)
		},
		async listRetentionFiles() {
			return { files: options.retentionFiles ?? [] }
		},
		async removeRetentionFiles(paths) {
			removedRetention.push(...paths)
		},
	}
}

function retentionFixture(): RetentionFile[] {
	return [
		{
			category: 'sessions',
			path: '.agents/nutstore-sync/sessions/session-a/log.jsonl',
			size: 100,
			mtime: NOW - 400 * DAY,
		},
		{
			category: 'ops',
			path: '.agents/nutstore-sync/ops/session-a/keep.json',
			size: 10,
			mtime: NOW - 400 * DAY,
		},
		{
			category: 'spill',
			path: '.agents/nutstore-sync/spill/session-a/old.txt',
			size: 1000,
			mtime: NOW - 31 * DAY,
		},
		{
			category: 'spill',
			path: '.agents/nutstore-sync/spill/session-a/new.txt',
			size: 2000,
			mtime: NOW - 1 * DAY,
		},
		{
			category: 'trash',
			path: '.trash/old-note.md',
			size: 500,
			mtime: NOW - 400 * DAY,
		},
		{
			category: 'tmp',
			path: `.agents/nutstore-sync/sessions/session-a/x.json.nutstore-sync-temp-1`,
			size: 300,
			mtime: NOW - 8 * DAY,
		},
		{
			category: 'diagnostics',
			path: '.agents/nutstore-sync/logs/plugin-log.txt',
			size: 50,
			mtime: NOW - 400 * DAY,
		},
		{
			category: 'diagnostics',
			path: '.agents/nutstore-sync/diagnostics/nutstore-diagnostics-x.json',
			size: 400,
			mtime: NOW - 31 * DAY,
		},
	]
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
		expect(report.retention.categories.sessions.files).toBe(0)
	})

	it('deletes only orphan files when deletion is explicitly requested', async () => {
		const backend = createBackend({
			orphanMtimes: {
				'.agents/nutstore-sync/ops/session-a/orphan.json': NOW - 8 * DAY,
				'.agents/nutstore-sync/ops/session-b/orphan.json': NOW - 8 * DAY,
			},
		})
		// The corrupt session makes the reference set incomplete, so even an
		// explicit delete must fail closed; use a clean backend for the happy path.
		backend.readSessionOperationRefPaths = async () => [
			'.agents/nutstore-sync/ops/session-a/keep.json',
		]
		const removeSpy = vi.spyOn(backend, 'removeOperationFiles')
		const report = await runOpsGc(backend, {
			deleteOrphans: true,
			retention: { now: NOW },
		})

		expect(report.mode).toBe('delete')
		expect(report.deletedFiles).toHaveLength(2)
		expect(report.deletionSkippedReason).toBeUndefined()
		expect(removeSpy).toHaveBeenCalledWith([
			'.agents/nutstore-sync/ops/session-a/orphan.json',
			'.agents/nutstore-sync/ops/session-b/orphan.json',
		])
	})

	it('applies the ops grace window when a retention policy is supplied', async () => {
		const oldPath = '.agents/nutstore-sync/ops/session-a/orphan.json'
		const backend = createBackend({
			orphanMtimes: {
				[oldPath]: NOW - 8 * DAY,
				'.agents/nutstore-sync/ops/session-b/orphan.json': NOW - 1 * DAY,
			},
		})
		backend.readSessionOperationRefPaths = async () => [
			'.agents/nutstore-sync/ops/session-a/keep.json',
		]
		const report = await runOpsGc(backend, {
			deleteOrphans: true,
			retention: { now: NOW },
		})

		expect(backend.removed).toEqual([oldPath])
		expect(report.orphanFiles).toHaveLength(2)
		expect(report.deletedFiles).toEqual([oldPath])
	})

	it('refuses to delete when a session ref is unreadable', async () => {
		const backend = createBackend()
		const report = await runOpsGc(backend, { deleteOrphans: true })

		expect(backend.removed).toEqual([])
		expect(report.deletedFiles).toEqual([])
		expect(report.deletionSkippedReason).toContain('unreadable')
	})

	it('refuses to delete when the session list itself fails', async () => {
		const backend = createBackend({ sessionListFails: true })
		const report = await runOpsGc(backend, { deleteOrphans: true })

		expect(backend.removed).toEqual([])
		expect(report.deletionSkippedReason).toContain('session list unavailable')
		expect(report.errors).toContain('listSessionIds: index unreadable')
	})

	it('reports six classes with bytes and only age-expires safe classes', async () => {
		const backend = createBackend({ retentionFiles: retentionFixture() })
		const report = await runOpsGc(backend, {
			retention: { now: NOW, deleteExpired: false },
		})

		expect(report.retention.categories.sessions).toMatchObject({
			files: 1,
			bytes: 100,
			expiredFiles: 0,
		})
		expect(report.retention.categories.ops).toMatchObject({
			files: 1,
			bytes: 10,
			expiredFiles: 0,
		})
		expect(report.retention.categories.spill).toMatchObject({
			files: 2,
			bytes: 3000,
			expiredFiles: 1,
			expiredBytes: 1000,
		})
		expect(report.retention.categories.trash).toMatchObject({
			files: 1,
			bytes: 500,
			expiredFiles: 0,
		})
		expect(report.retention.categories.tmp).toMatchObject({
			files: 1,
			bytes: 300,
			expiredFiles: 1,
		})
		expect(report.retention.categories.diagnostics).toMatchObject({
			files: 2,
			bytes: 450,
			expiredFiles: 1,
			expiredBytes: 400,
		})
		expect(backend.removedRetention).toEqual([])
		expect(report.retention.expiredFiles).toHaveLength(3)
	})

	it('deletes only expired age-managed files when explicitly requested', async () => {
		const backend = createBackend({ retentionFiles: retentionFixture() })
		const report = await runOpsGc(backend, {
			retention: { now: NOW, deleteExpired: true },
		})

		const expected = [
			'.agents/nutstore-sync/spill/session-a/old.txt',
			`.agents/nutstore-sync/sessions/session-a/x.json.nutstore-sync-temp-1`,
			'.agents/nutstore-sync/diagnostics/nutstore-diagnostics-x.json',
		].sort()
		expect(backend.removedRetention.sort()).toEqual(expected)
		expect(report.retention.deletedFiles.sort()).toEqual(expected)
		expect(backend.removedRetention).not.toContain(
			'.agents/nutstore-sync/logs/plugin-log.txt',
		)
		expect(backend.removedRetention).not.toContain('.trash/old-note.md')
		expect(report.retention.categories.trash.deletedFiles).toBe(0)
		expect(report.retention.categories.sessions.deletedFiles).toBe(0)
	})

	it('renders the six byte counts in a readable report', async () => {
		const backend = createBackend({ retentionFiles: retentionFixture() })
		const report = await runOpsGc(backend, { retention: { now: NOW } })
		const text = formatOpsGcReport(report)

		for (const category of [
			'sessions',
			'ops',
			'spill',
			'trash',
			'tmp',
			'diagnostics',
		]) {
			expect(text).toMatch(new RegExp(`^${category}: files=`, 'm'))
		}
		expect(text).toContain('spill: files=2 bytes=3000 expired=1/1000B')
	})
})
