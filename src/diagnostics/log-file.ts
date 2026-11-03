import { normalizePath, type App, type DataAdapter } from 'obsidian'
import logsStringify from '~/utils/logs-stringify'
import type { LogEntry } from '~/services/logger.service'

export const DIAGNOSTICS_ROOT_DIR = '.agents/nutstore-sync'
export const DIAGNOSTICS_LOGS_DIR = `${DIAGNOSTICS_ROOT_DIR}/logs`
export const DIAGNOSTICS_EXPORT_DIR = `${DIAGNOSTICS_ROOT_DIR}/diagnostics`
export const DIAGNOSTICS_LOG_FILE = 'plugin-log.txt'
export const DIAGNOSTICS_ROTATED_LOG_FILE = 'plugin-log.1.txt'

/** Rotated generations kept before the oldest is discarded. */
export const DIAGNOSTICS_LOG_GENERATIONS = 3
/** Rotate once the active log reaches this size. */
export const DIAGNOSTICS_MAX_LOG_BYTES = 256 * 1024

function rotatedLogFileName(generation: number) {
	return `plugin-log.${generation}.txt`
}

/**
 * A serialized writer for a rolling `.agents/nutstore-sync/logs/plugin-log.txt`.
 * Writes go through the Obsidian DataAdapter only; no Node APIs are used.
 */
export class DiagnosticsLogFile {
	private readonly ensuredDirectories = new Set<string>()
	private queue: Promise<unknown> = Promise.resolve()

	private readonly logFilePath = normalizePath(
		`${DIAGNOSTICS_LOGS_DIR}/${DIAGNOSTICS_LOG_FILE}`,
	)
	private readonly rotatedLogFilePaths = Array.from(
		{ length: DIAGNOSTICS_LOG_GENERATIONS },
		(_, index) =>
			normalizePath(`${DIAGNOSTICS_LOGS_DIR}/${rotatedLogFileName(index + 1)}`),
	)

	constructor(private readonly app: App) {}

	private get adapter(): DataAdapter {
		return this.app.vault.adapter
	}

	async ensureDirectory(path: string): Promise<void> {
		const normalized = normalizePath(path)
		if (!normalized) return
		if (this.ensuredDirectories.has(normalized)) return
		const segments = normalized.split('/').filter(Boolean)
		let current = ''
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment
			try {
				await this.adapter.mkdir(current)
			} catch {
				/* Directory exists or is not creatable on this platform. */
			}
		}
		this.ensuredDirectories.add(normalized)
	}

	append(level: string, args: unknown[], timestamp?: string): Promise<void> {
		const entry: LogEntry = {
			timestamp: timestamp ?? new Date().toISOString(),
			level,
			args,
		}
		const line = logsStringify(entry)
		if (!line) return Promise.resolve()
		const task = this.queue
			.then(async () => {
				await this.ensureDirectory(DIAGNOSTICS_LOGS_DIR)
				await this.rotateIfNeeded()
				if (!(await this.adapter.exists(this.logFilePath))) {
					await this.adapter.write(this.logFilePath, '')
				}
				await this.adapter.append(this.logFilePath, `${line}\n`)
			})
			.catch((error) => {
				// Diagnostics must never take down the plugin.
				console.warn('[diagnostics] failed to append log', error)
			})
		this.queue = task
		return task
	}

	async readRecent(maxBytes = 128 * 1024): Promise<string> {
		await this.queue.catch(() => undefined)
		const paths = [
			...this.rotatedLogFilePaths.slice().reverse(),
			this.logFilePath,
		]
		const chunks: string[] = []
		for (const path of paths) {
			try {
				if (!(await this.adapter.exists(path))) continue
				chunks.push(await this.adapter.read(path))
			} catch {
				/* Skip an unreadable generation and keep the others. */
			}
		}
		const content = chunks.join('')
		return maxBytes > 0
			? content.slice(Math.max(0, content.length - maxBytes))
			: content
	}
	async listLogFiles(): Promise<string[]> {
		try {
			const listed = await this.adapter.list(DIAGNOSTICS_LOGS_DIR)
			return listed.files.filter((file) => file.includes('plugin-log'))
		} catch {
			return []
		}
	}

	async clear(): Promise<void> {
		const task = this.queue.then(async () => {
			try {
				const listed = await this.adapter.list(DIAGNOSTICS_LOGS_DIR)
				for (const file of listed.files) {
					if (file.includes('plugin-log')) {
						await this.adapter.remove(file)
					}
				}
			} catch {
				/* Nothing to clear. */
			}
		})
		this.queue = task.catch(() => undefined)
		return task
	}

	async flush(): Promise<void> {
		await this.queue.catch(() => undefined)
	}

	private async rotateIfNeeded(): Promise<void> {
		try {
			const stat = await this.adapter.stat(this.logFilePath)
			if (!stat || stat.size < DIAGNOSTICS_MAX_LOG_BYTES) return
			const oldest = this.rotatedLogFilePaths.at(-1)
			if (oldest && (await this.adapter.exists(oldest))) {
				await this.adapter.remove(oldest)
			}
			for (
				let index = this.rotatedLogFilePaths.length - 1;
				index > 0;
				index -= 1
			) {
				const from = this.rotatedLogFilePaths[index - 1]
				const to = this.rotatedLogFilePaths[index]
				if (from && to && (await this.adapter.exists(from))) {
					await this.adapter.rename(from, to)
				}
			}
			const first = this.rotatedLogFilePaths[0]
			if (first) {
				if (await this.adapter.exists(first)) {
					await this.adapter.remove(first)
				}
				await this.adapter.rename(this.logFilePath, first)
			}
		} catch (error) {
			// Rotation failing should not prevent the append fallback.
			console.warn('[diagnostics] failed to rotate log', error)
		}
	}
}
