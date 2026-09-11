import { normalizePath, type App, type DataAdapter } from 'obsidian'
import logsStringify from '~/utils/logs-stringify'
import type { LogEntry } from '~/services/logger.service'

export const DIAGNOSTICS_ROOT_DIR = '.agents/nutstore-sync'
export const DIAGNOSTICS_LOGS_DIR = `${DIAGNOSTICS_ROOT_DIR}/logs`
export const DIAGNOSTICS_EXPORT_DIR = `${DIAGNOSTICS_ROOT_DIR}/diagnostics`
export const DIAGNOSTICS_LOG_FILE = 'plugin-log.txt'
export const DIAGNOSTICS_ROTATED_LOG_FILE = 'plugin-log.1.txt'

const MAX_LOG_BYTES = 256 * 1024

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
	private readonly rotatedLogFilePath = normalizePath(
		`${DIAGNOSTICS_LOGS_DIR}/${DIAGNOSTICS_ROTATED_LOG_FILE}`,
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
		for (const path of [this.logFilePath, this.rotatedLogFilePath]) {
			try {
				if (!(await this.adapter.exists(path))) continue
				const content = await this.adapter.read(path)
				return maxBytes > 0
					? content.slice(Math.max(0, content.length - maxBytes))
					: content
			} catch {
				/* Try the rotated file next. */
			}
		}
		return ''
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
			if (!stat || stat.size < MAX_LOG_BYTES) return
			if (await this.adapter.exists(this.rotatedLogFilePath)) {
				await this.adapter.remove(this.rotatedLogFilePath)
			}
			await this.adapter.rename(this.logFilePath, this.rotatedLogFilePath)
		} catch (error) {
			// Rotation failing should not prevent the append fallback.
			console.warn('[diagnostics] failed to rotate log', error)
		}
	}
}
