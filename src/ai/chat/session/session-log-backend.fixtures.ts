/* eslint obsidianmd/hardcoded-config-path: "off" -- test fixture mirrors Obsidian's default config dir */
import type { Vault } from 'obsidian'

/**
 * Per-op bridge-call counters. Obsidian's `DataAdapter` crosses the JS/native
 * bridge on Android, so call counts are a mobile-cost proxy that is stable
 * across machines (durations are not). Tests that do not read these fields are
 * unaffected.
 */
export interface BridgeCallCounts {
	exists: number
	read: number
	write: number
	append: number
	mkdir: number
	list: number
	stat: number
	remove: number
	rename: number
	rmdir: number
}

export class MemoryAdapter {
	files = new Map<string, string>()
	dirs = new Set<string>()
	appendBytes = 0
	appendCalls = 0
	writeCalls = 0
	writeCountsByPath = new Map<string, number>()
	readonly bridgeCalls: BridgeCallCounts = {
		exists: 0,
		read: 0,
		write: 0,
		append: 0,
		mkdir: 0,
		list: 0,
		stat: 0,
		remove: 0,
		rename: 0,
		rmdir: 0,
	}

	resetBridgeCalls() {
		for (const key of Object.keys(this.bridgeCalls) as Array<
			keyof BridgeCallCounts
		>) {
			this.bridgeCalls[key] = 0
		}
	}

	totalBridgeCalls() {
		const counts = this.bridgeCalls
		return (
			counts.exists +
			counts.read +
			counts.write +
			counts.append +
			counts.mkdir +
			counts.list +
			counts.stat +
			counts.remove +
			counts.rename +
			counts.rmdir
		)
	}

	async exists(path: string) {
		this.bridgeCalls.exists += 1
		return this.files.has(path) || this.dirs.has(path)
	}

	async read(path: string) {
		this.bridgeCalls.read += 1
		const value = this.files.get(path)
		if (value === undefined) throw new Error(`missing file: ${path}`)
		return value
	}

	async write(path: string, data: string) {
		this.bridgeCalls.write += 1
		this.writeCalls += 1
		this.writeCountsByPath.set(
			path,
			(this.writeCountsByPath.get(path) ?? 0) + 1,
		)
		this.ensureParent(path)
		this.files.set(path, data)
	}

	async append(path: string, data: string) {
		this.bridgeCalls.append += 1
		this.appendCalls += 1
		this.appendBytes += data.length
		if (!this.files.has(path)) throw new Error(`missing append file: ${path}`)
		this.files.set(path, (this.files.get(path) ?? '') + data)
	}

	async mkdir(path: string) {
		this.bridgeCalls.mkdir += 1
		this.ensureParent(path)
		this.dirs.add(path)
	}

	async list(path: string) {
		this.bridgeCalls.list += 1
		const prefix = path.endsWith('/') ? path : `${path}/`
		return {
			files: [...this.files.keys()].filter((file) => file.startsWith(prefix)),
			folders: [...this.dirs].filter((dir) => dir.startsWith(prefix)),
		}
	}

	async stat(path: string) {
		this.bridgeCalls.stat += 1
		if (this.dirs.has(path)) return { type: 'folder' as const, size: 0 }
		const file = this.files.get(path)
		return file === undefined
			? null
			: { type: 'file' as const, size: file.length }
	}

	async remove(path: string) {
		this.bridgeCalls.remove += 1
		this.files.delete(path)
	}

	async rmdir(path: string) {
		this.bridgeCalls.rmdir += 1
		const prefix = path.endsWith('/') ? path : `${path}/`
		for (const file of [...this.files.keys()]) {
			if (file === path || file.startsWith(prefix)) this.files.delete(file)
		}
		for (const dir of [...this.dirs]) {
			if (dir === path || dir.startsWith(prefix)) this.dirs.delete(dir)
		}
	}

	async rename(from: string, to: string) {
		this.bridgeCalls.rename += 1
		const content = this.files.get(from)
		if (content === undefined) throw new Error(`missing source: ${from}`)
		this.files.delete(from)
		this.files.set(to, content)
	}

	private ensureParent(path: string) {
		const parts = path.split('/')
		parts.pop()
		let current = ''
		for (const part of parts) {
			current = current ? `${current}/${part}` : part
			this.dirs.add(current)
		}
	}
}

export function makeVault(adapter: MemoryAdapter) {
	return { configDir: '.obsidian', adapter } as unknown as Vault
}

export function makeSession(count: number) {
	return {
		schemaVersion: 2,
		id: 'session-log-1',
		createdAt: 1,
		updatedAt: 1,
		subagents: {
			master: {
				id: 'master',
				type: 'master',
				status: 'idle',
				createdAt: 1,
				updatedAt: 1,
				timeline: Array.from({ length: count }, (_, index) => ({
					id: `message-${index + 1}`,
					role: index % 2 === 0 ? 'user' : 'assistant',
					parts: [{ type: 'text', text: `message ${index + 1}` }],
				})),
				operations: {},
				toolTimings: {},
				subagents: {},
			},
		},
	} as never
}

export function encoded(session: unknown) {
	return JSON.parse(JSON.stringify(session)) as never
}

export function timelineOf(payload: unknown) {
	return (
		payload as {
			session: { subagents: { master: { timeline: unknown[] } } }
		}
	).session.subagents.master.timeline
}
