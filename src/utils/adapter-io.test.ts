import { describe, expect, it } from 'vitest'
import {
	appendTextWithParents,
	writeBinaryWithParents,
	writeTextWithParents,
} from './adapter-io'

class MemoryAdapter {
	files = new Map<string, string | ArrayBuffer>()
	dirs = new Set<string>()

	async stat(path: string) {
		if (this.dirs.has(path)) return { type: 'folder' as const }
		const file = this.files.get(path)
		return file === undefined ? null : { type: 'file' as const }
	}

	async mkdir(path: string) {
		this.dirs.add(path)
	}

	async write(path: string, data: string) {
		this.files.set(path, data)
	}

	async writeBinary(path: string, data: ArrayBuffer) {
		this.files.set(path, data)
	}

	async append(path: string, data: string) {
		const current = this.files.get(path)
		if (typeof current !== 'string') {
			throw new Error(`not a text file: ${path}`)
		}
		this.files.set(path, current + data)
	}
}

describe('adapter io', () => {
	it('creates hidden parent directories before writes', async () => {
		const adapter = new MemoryAdapter()
		await writeTextWithParents(
			adapter as never,
			'.agents/nutstore-sync/logs/plugin-log.txt',
			'hello',
		)
		expect(adapter.files.get('.agents/nutstore-sync/logs/plugin-log.txt')).toBe(
			'hello',
		)
		expect(adapter.dirs.has('.agents')).toBe(true)
		expect(adapter.dirs.has('.agents/nutstore-sync/logs')).toBe(true)
	})

	it('creates parents for binary writes and appends', async () => {
		const adapter = new MemoryAdapter()
		await writeBinaryWithParents(
			adapter as never,
			'.agents/nutstore-sync/binary/data.bin',
			new Uint8Array([1, 2, 3]).buffer,
		)
		expect(
			adapter.files.get('.agents/nutstore-sync/binary/data.bin'),
		).toBeInstanceOf(ArrayBuffer)
		await writeTextWithParents(
			adapter as never,
			'.agents/nutstore-sync/logs/plugin-log.txt',
			'',
		)
		await appendTextWithParents(
			adapter as never,
			'.agents/nutstore-sync/logs/plugin-log.txt',
			'first',
		)
		await appendTextWithParents(
			adapter as never,
			'.agents/nutstore-sync/logs/plugin-log.txt',
			'second',
		)
		expect(adapter.files.get('.agents/nutstore-sync/logs/plugin-log.txt')).toBe(
			'firstsecond',
		)
	})
})
