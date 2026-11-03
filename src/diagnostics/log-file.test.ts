import { describe, expect, it } from 'vitest'
import type { App } from 'obsidian'
import {
	DIAGNOSTICS_LOGS_DIR,
	DIAGNOSTICS_MAX_LOG_BYTES,
	DiagnosticsLogFile,
} from './log-file'

class MemoryAdapter {
	files = new Map<string, string>()
	folders = new Set<string>()

	async exists(path: string) {
		return this.files.has(path) || this.folders.has(path)
	}

	async mkdir(path: string) {
		this.folders.add(path)
	}

	async write(path: string, data: string) {
		this.files.set(path, data)
	}

	async append(path: string, data: string) {
		if (!this.files.has(path)) {
			throw new Error(`missing file: ${path}`)
		}
		this.files.set(path, (this.files.get(path) ?? '') + data)
	}

	async read(path: string) {
		const content = this.files.get(path)
		if (content === undefined) throw new Error(`missing file: ${path}`)
		return content
	}

	async stat(path: string) {
		const content = this.files.get(path)
		return content === undefined ? null : { size: content.length }
	}

	async list(path: string) {
		const prefix = `${path}/`
		return {
			files: [...this.files.keys()].filter((file) => file.startsWith(prefix)),
			folders: [],
		}
	}

	async remove(path: string) {
		this.files.delete(path)
	}

	async rename(from: string, to: string) {
		const content = this.files.get(from)
		if (content === undefined) throw new Error(`missing file: ${from}`)
		this.files.delete(from)
		this.files.set(to, content)
	}
}

function createLogFile() {
	const adapter = new MemoryAdapter()
	const app = { vault: { adapter } } as unknown as App
	return { adapter, logFile: new DiagnosticsLogFile(app) }
}

describe('diagnostics log file', () => {
	it('appends and reads recent lines through the adapter', async () => {
		const { adapter, logFile } = createLogFile()
		await logFile.append('info', ['hello'], '2026-09-10 10:00:00')
		await logFile.append('error', [new Error('boom')], '2026-09-10 10:00:01')

		const content = await logFile.readRecent()
		expect(content).toContain('[2026-09-10 10:00:00] [info] hello')
		expect(content).toContain('Error: boom')
		expect(await logFile.listLogFiles()).toContain(
			`${DIAGNOSTICS_LOGS_DIR}/plugin-log.txt`,
		)
		expect(adapter.files.size).toBeGreaterThan(0)
	})

	it('rotates up to three generations and reads them oldest-first', async () => {
		const { adapter, logFile } = createLogFile()
		const dir = DIAGNOSTICS_LOGS_DIR
		adapter.files.set(`${dir}/plugin-log.1.txt`, 'gen1')
		adapter.files.set(`${dir}/plugin-log.2.txt`, 'gen2')
		adapter.files.set(
			`${dir}/plugin-log.txt`,
			'x'.repeat(DIAGNOSTICS_MAX_LOG_BYTES),
		)

		await logFile.append('info', ['new'], '2026-09-10 10:00:02')

		expect(adapter.files.get(`${dir}/plugin-log.3.txt`)).toBe('gen2')
		expect(adapter.files.get(`${dir}/plugin-log.2.txt`)).toBe('gen1')
		expect(adapter.files.get(`${dir}/plugin-log.1.txt`)).toBe(
			'x'.repeat(DIAGNOSTICS_MAX_LOG_BYTES),
		)
		const recent = await logFile.readRecent(0)
		expect(recent).toContain('gen2')
		expect(recent).toContain('gen1')
		expect(recent).toContain('new')
	})

	it('clears all managed log files', async () => {
		const { logFile } = createLogFile()
		await logFile.append('info', ['one'], '2026-09-10 10:00:00')
		await logFile.clear()
		expect(await logFile.readRecent()).toBe('')
	})
})
