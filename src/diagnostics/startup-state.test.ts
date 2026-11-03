import type { App } from 'obsidian'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	ABNORMAL_START_NOTICE_THRESHOLD,
	ABNORMAL_START_WINDOW_MS,
	STARTUP_STATE_FILE,
	markBackgrounded,
	markCleanExit,
	markStartup,
	readStartupState,
} from './startup-state'

class MemoryAdapter {
	readonly files = new Map<string, string>()
	readonly dirs = new Set<string>()

	async exists(path: string) {
		return this.files.has(path) || this.dirs.has(path)
	}

	async read(path: string) {
		const value = this.files.get(path)
		if (value === undefined) throw new Error(`missing file: ${path}`)
		return value
	}

	async write(path: string, data: string) {
		this.files.set(path, data)
	}

	async mkdir(path: string) {
		this.dirs.add(path)
	}

	async stat(path: string) {
		if (this.dirs.has(path)) return { type: 'folder' as const, size: 0 }
		const value = this.files.get(path)
		return value === undefined
			? null
			: { type: 'file' as const, size: value.length }
	}
}

function makeApp() {
	const adapter = new MemoryAdapter()
	const app = { vault: { adapter, configDir: '.obsidian' } } as unknown as App
	return { app, adapter }
}

afterEach(() => {
	vi.useRealTimers()
})

describe('startup crash-loop breadcrumb', () => {
	it('increments on suspected foreground crashes and resets after a clean exit', async () => {
		const { app } = makeApp()
		expect((await markStartup(app, '1.5.5')).consecutiveAbnormalStarts).toBe(0)
		expect((await markStartup(app, '1.5.5')).consecutiveAbnormalStarts).toBe(1)
		const third = await markStartup(app, '1.5.6')
		expect(third.consecutiveAbnormalStarts).toBe(
			ABNORMAL_START_NOTICE_THRESHOLD,
		)
		expect(third.lastStartVersion).toBe('1.5.6')
		expect(third.lastAbnormalAt).toBe(third.lastStartAt)

		await markCleanExit(app)
		const afterClean = await readStartupState(app)
		expect(afterClean?.lastExitClean).toBe(true)
		expect((await markStartup(app, '1.5.6')).consecutiveAbnormalStarts).toBe(0)
	})

	it('treats a backgrounded process kill as an ordinary exit', async () => {
		const { app } = makeApp()
		await markStartup(app, '1.5.7')
		await markBackgrounded(app)

		const backgrounded = await readStartupState(app)
		expect(backgrounded).toMatchObject({
			lastExitClean: false,
			lastExitReason: 'background',
		})
		expect(backgrounded?.lastBackgroundAt).toBeTruthy()

		const restarted = await markStartup(app, '1.5.7')
		expect(restarted.consecutiveAbnormalStarts).toBe(0)
		expect(restarted.lastExitReason).toBe('running')
		expect(restarted.lastAbnormalAt).toBeUndefined()
	})

	it('does not overwrite a clean unload with a late background event', async () => {
		const { app } = makeApp()
		await markStartup(app, '1.5.7')
		await markCleanExit(app)
		await markBackgrounded(app)

		const state = await readStartupState(app)
		expect(state?.lastExitClean).toBe(true)
		expect(state?.lastExitReason).toBe('unload')
	})

	it('restarts the crash streak after the abnormal window expires', async () => {
		vi.useFakeTimers()
		const start = new Date('2026-10-25T00:00:00.000Z')
		vi.setSystemTime(start)
		const { app } = makeApp()

		await markStartup(app, '1.5.7')
		vi.setSystemTime(start.getTime() + 60_000)
		expect((await markStartup(app, '1.5.7')).consecutiveAbnormalStarts).toBe(1)

		vi.setSystemTime(start.getTime() + 60_000 + ABNORMAL_START_WINDOW_MS + 1)
		expect((await markStartup(app, '1.5.7')).consecutiveAbnormalStarts).toBe(1)
	})

	it('does not count legacy state that predates the exit-reason split', async () => {
		const { app, adapter } = makeApp()
		adapter.files.set(
			STARTUP_STATE_FILE,
			JSON.stringify({
				schemaVersion: 1,
				lastStartAt: '2026-10-09T00:00:00.000Z',
				lastStartVersion: '1.5.7',
				lastExitClean: false,
				consecutiveAbnormalStarts: 15,
			}),
		)

		const state = await markStartup(app, '1.5.8')
		expect(state.consecutiveAbnormalStarts).toBe(0)
	})

	it('is best-effort when the state file is corrupt or missing', async () => {
		const { app, adapter } = makeApp()
		await expect(readStartupState(app)).resolves.toBeUndefined()

		adapter.files.set(STARTUP_STATE_FILE, '{broken')
		await expect(readStartupState(app)).resolves.toBeUndefined()
		await expect(markStartup(app, '1.5.6')).resolves.toMatchObject({
			consecutiveAbnormalStarts: 0,
		})
	})
})
