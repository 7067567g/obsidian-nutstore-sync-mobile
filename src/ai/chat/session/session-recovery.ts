import { normalizePath, Vault } from 'obsidian'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import logger from '~/utils/logger'

export const SESSION_WRITE_MARKER = '.write-in-progress.json'

export interface SessionWriteMarker {
	sessionId: string
	startedAt: string
	reason?: string
}

export class SessionRecovery {
	constructor(
		private readonly vault: Vault,
		private readonly sessionsDir: string,
	) {}

	private get adapter() {
		return this.vault.adapter
	}

	private sessionDir(id: string) {
		return normalizePath(`${this.sessionsDir}/${id}`)
	}

	private markerPath(id: string) {
		return normalizePath(`${this.sessionDir(id)}/${SESSION_WRITE_MARKER}`)
	}

	async markStarted(id: string, reason = 'session-write') {
		try {
			await mkdirsVault(this.vault, this.sessionDir(id))
			const marker: SessionWriteMarker = {
				sessionId: id,
				startedAt: new Date().toISOString(),
				reason,
			}
			await this.adapter.write(
				this.markerPath(id),
				`${JSON.stringify(marker, null, 2)}\n`,
			)
		} catch (error) {
			logger.warn(`[SessionRecovery] failed to write marker for ${id}`, error)
		}
	}

	async markCompleted(id: string) {
		try {
			if (await this.adapter.exists(this.markerPath(id))) {
				await this.adapter.remove(this.markerPath(id))
			}
		} catch (error) {
			logger.warn(`[SessionRecovery] failed to clear marker for ${id}`, error)
		}
	}

	async listPendingIds(): Promise<string[]> {
		try {
			const listed = await this.adapter.list(this.sessionsDir)
			const pending: string[] = []
			for (const folder of listed.folders) {
				const id = normalizePath(folder).split('/').pop() ?? ''
				if (!id) continue
				if (await this.adapter.exists(this.markerPath(id))) {
					pending.push(id)
				}
			}
			return pending
		} catch {
			return []
		}
	}

	/**
	 * Run `reader` for every interrupted write marker. A marker is only cleared
	 * when the session backend can read the session back successfully.
	 */
	async recoverPending(reader: (id: string) => Promise<void>) {
		const pending = await this.listPendingIds()
		for (const id of pending) {
			try {
				await reader(id)
				await this.markCompleted(id)
				logger.info(`[SessionRecovery] recovered interrupted write for ${id}`)
			} catch (error) {
				logger.error(
					`[SessionRecovery] session ${id} is still unreadable; keeping marker for diagnostics`,
					error,
				)
			}
		}
	}
}
