import { normalizePath } from 'obsidian'
import { atomicReplaceContent } from '~/utils/atomic-replace'
import { readLocalText } from '~/utils/local-vault-io'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import { perfMetrics } from '~/diagnostics/perf-metrics'
import {
	agentPathKey,
	sessionWithoutSubagents,
	splitSessionSnapshot,
	stateKey,
	stringifySessionLogRecord,
	type JsonRecord,
} from './session-log-format'
import {
	materializeSession,
	SessionLogCorruptionError,
	scanSessionLog,
	type SessionLogScan,
} from './session-log-parse'
import { SessionLogStateBase, type SessionState } from './session-log-state'
import { sessionNeedsEncoding } from './session-persistence'

export type { SessionLogBackendOptions } from './session-log-segments'
export { SessionLogCorruptionError, scanSessionLog, type SessionLogScan }

export class SessionLogBackend extends SessionLogStateBase {
	/**
	 * R2b / S2: drop the write-path state so the next persist re-reads the log
	 * instead of trusting the freshness TTL. Called from the explicit
	 * external-write path (`SessionStore.invalidateSession`).
	 */
	invalidateSessionState(id: string): void {
		this.sessions.delete(id)
	}

	async exists(id: string): Promise<boolean> {
		try {
			return (
				(await this.adapter.exists(this.logPath(id))) ||
				(await this.adapter.exists(this.metaPath(id))) ||
				(await this.adapter.exists(this.indexPath(id)))
			)
		} catch {
			return false
		}
	}

	async readSessionFile(id: string): Promise<JsonRecord> {
		await this.promoteSessionTemps(id)
		const metaText = await readLocalText(this.vault, this.metaPath(id)).catch(
			() => null,
		)
		const meta: JsonRecord = metaText
			? (JSON.parse(metaText) as JsonRecord)
			: { schemaVersion: 2, id, createdAt: 0, updatedAt: 0 }
		const index = await this.readIndexInfo(id)
		const segment = await this.readLatestSegment(id, index)
		const logText = await readLocalText(this.vault, this.logPath(id)).catch(
			() => null,
		)
		const records: JsonRecord[] = []
		if (segment) records.push(segment.record)
		if (logText) {
			const scan = scanSessionLog(logText)
			const logRecords = [...scan.records, ...scan.recoveredTail]
			// A segment named by the index is the authoritative base; a stale
			// whole-session snapshot in the log must not wipe it (WS1-N1).
			records.push(
				...(segment?.authoritative
					? logRecords.filter((record) => record.type !== 'snapshot')
					: logRecords),
			)
		}
		if (records.length === 0) {
			throw new Error(`Session log not found: ${this.logPath(id)}`)
		}
		return materializeSession(meta, records)
	}

	async writeSessionFile(
		id: string,
		session: JsonRecord,
		/**
		 * R2b / D-008 #3: the live session the snapshot was encoded from. For
		 * plain sessions it is used for delta comparison only (stable message
		 * identities → S1 cache hits); the persisted records still come from the
		 * isolated `session` snapshot.
		 */
		sourceSession?: unknown,
	): Promise<void> {
		const state = await this.loadState(id)
		const split = splitSessionSnapshot(session)
		const sourceSplit =
			sourceSession &&
			typeof sourceSession === 'object' &&
			!sessionNeedsEncoding(sourceSession)
				? splitSessionSnapshot(sourceSession as JsonRecord)
				: undefined
		const records: JsonRecord[] = []
		const sessionMeta = sessionWithoutSubagents(session)
		const metaJson = JSON.stringify(sessionMeta)

		if (!state.loaded) {
			records.push({ type: 'snapshot', session })
			state.loaded = true
			state.activeSegment = undefined
			state.metaJson = metaJson
			for (const agent of split) {
				const pathKey = agentPathKey(agent.path)
				state.agentMeta.set(pathKey, JSON.stringify(agent.meta))
				for (const [toolCallId, timing] of Object.entries(agent.toolTimings)) {
					state.toolTimings.set(
						stateKey(pathKey, toolCallId),
						JSON.stringify(timing),
					)
				}
				for (const item of agent.messages) {
					state.messages.set(stateKey(pathKey, item.id), {
						json: JSON.stringify(item.message),
						index: item.index,
					})
				}
				for (const [messageId, operations] of agent.operations) {
					state.operations.set(stateKey(pathKey, messageId), {
						json: JSON.stringify(operations),
					})
				}
			}
		} else {
			this.appendDeltaRecords(state, split, records, sourceSplit)
			if (state.metaJson !== metaJson) {
				records.push({ type: 'session-meta', meta: sessionMeta })
			}
		}

		if (state.loaded && records.length === 0 && state.metaJson === metaJson) {
			const cacheReady = await (async () => {
				try {
					return (
						(await this.adapter.exists(this.metaPath(id))) &&
						(await this.adapter.exists(this.indexPath(id)))
					)
				} catch {
					return false
				}
			})()
			if (cacheReady) return
		}

		await mkdirsVault(this.vault, this.sessionDir(id))
		try {
			// The append/repair below is the commit point. Only after it lands do
			// we advance generation and write the derived meta/index caches.
			if (records.length > 0) {
				const logPath = this.logPath(id)
				const repair = state.pendingLogRepair
				let writtenBytes = 0
				if (repair) {
					const currentText = await readLocalText(this.vault, logPath).catch(
						() => null,
					)
					let prefix = repair.prefix
					let recovered = repair.recovered
					if (currentText !== null) {
						// Re-scan the *current* log so an external append/sync that
						// landed after loadState is preserved instead of being
						// overwritten by the stale in-memory prefix (WS1-N7).
						const rescan = scanSessionLog(currentText)
						prefix = currentText.slice(0, rescan.committedLength)
						recovered = rescan.recoveredTail
					}
					const appended =
						[...recovered, ...records]
							.map(stringifySessionLogRecord)
							.join('\n') + '\n'
					writtenBytes = prefix.length + appended.length
					const repaired = prefix + appended
					await atomicReplaceContent(this.vault, logPath, repaired, 'text')
					state.pendingLogRepair = undefined
				} else {
					if (!(await this.adapter.exists(logPath))) {
						await this.adapter.write(logPath, '')
					}
					const chunk = `${records.map(stringifySessionLogRecord).join('\n')}\n`
					writtenBytes = chunk.length
					await this.adapter.append(logPath, chunk)
				}
				// R2b / D-008 #3: sample the bytes actually serialised for this
				// write (delta after the first snapshot), not a fresh whole-session
				// `JSON.stringify` on every persist.
				perfMetrics.recordSessionSize(writtenBytes)
				state.generation += 1
				// Record the committed log size so the next loadState can detect an
				// external write (K15/K16 freshness validator).
				state.logSize = await this.getLogSize(id)
			}
			await atomicReplaceContent(
				this.vault,
				this.metaPath(id),
				metaJson,
				'text',
			)
			state.metaJson = metaJson
			await this.writeIndexFile(
				id,
				state.generation,
				typeof session.updatedAt === 'number' ? session.updatedAt : Date.now(),
				split,
				state.activeSegment,
			)
			// R2b / S2: this instance just wrote the session, so its in-memory
			// state is authoritative for the freshness TTL.
			this.touchStateFreshness(state)
			const compactionBytes = this.options.compactionBytes
			if (compactionBytes && (await this.getLogSize(id)) > compactionBytes) {
				await this.compactSession(id, session)
			}
		} catch (error) {
			// Persistence is the commit point: never leave in-memory state ahead
			// of disk. The next write reloads from the committed prefix.
			this.sessions.delete(id)
			throw error
		}
	}

	async compactSession(id: string, session: JsonRecord): Promise<void> {
		const state = await this.loadState(id)
		const split = splitSessionSnapshot(session)
		const segDir = normalizePath(`${this.sessionDir(id)}/seg`)
		await mkdirsVault(this.vault, segDir)
		const messageCount = split.reduce(
			(total, agent) => total + agent.messages.length,
			0,
		)
		const segments = await this.listSegmentEntries(id)
		const highestGeneration = segments.reduce(
			(max, entry) => Math.max(max, entry.generation),
			state.generation,
		)
		let segmentGeneration = highestGeneration + 1
		let segmentName = `${String(segmentGeneration).padStart(4, '0')}-${String(
			messageCount,
		).padStart(4, '0')}.json`
		while (
			await this.adapter.exists(normalizePath(`${segDir}/${segmentName}`))
		) {
			segmentGeneration += 1
			segmentName = `${String(segmentGeneration).padStart(4, '0')}-${String(
				messageCount,
			).padStart(4, '0')}.json`
		}
		const segmentJson = JSON.stringify(session)
		await atomicReplaceContent(
			this.vault,
			normalizePath(`${segDir}/${segmentName}`),
			segmentJson,
			'text',
		)
		perfMetrics.recordSessionSize(segmentJson.length)
		const metaJson = JSON.stringify(sessionWithoutSubagents(session))
		const nextState: SessionState = {
			loaded: true,
			generation: state.generation + 1,
			activeSegment: segmentName,
			metaJson,
			logSize: 0,
			validatedAt: Date.now(),
			agentMeta: new Map(),
			toolTimings: new Map(),
			messages: new Map(),
			operations: new Map(),
		}
		for (const agent of split) {
			const pathKey = agentPathKey(agent.path)
			nextState.agentMeta.set(pathKey, JSON.stringify(agent.meta))
			for (const [toolCallId, timing] of Object.entries(agent.toolTimings)) {
				nextState.toolTimings.set(
					stateKey(pathKey, toolCallId),
					JSON.stringify(timing),
				)
			}
			for (const item of agent.messages) {
				nextState.messages.set(stateKey(pathKey, item.id), {
					json: JSON.stringify(item.message),
					index: item.index,
				})
			}
			for (const [messageId, operations] of agent.operations) {
				nextState.operations.set(stateKey(pathKey, messageId), {
					json: JSON.stringify(operations),
				})
			}
		}
		await atomicReplaceContent(this.vault, this.metaPath(id), metaJson, 'text')
		// Publish the new active segment before removing the old log; a crash
		// between these steps leaves the old log available for replay.
		await this.writeIndexFile(
			id,
			nextState.generation,
			typeof session.updatedAt === 'number' ? session.updatedAt : Date.now(),
			split,
			segmentName,
		)
		this.sessions.set(id, nextState)
		// Keep an empty log file so session existence checks and appends remain cheap.
		try {
			if (await this.adapter.exists(this.logPath(id))) {
				await this.adapter.remove(this.logPath(id))
			}
		} catch {
			/* Best effort: index already points at the segment. */
		}
		await this.adapter.write(this.logPath(id), '')
		await this.pruneOldSegments(id, segmentName)
	}

	async deleteSessionFile(id: string): Promise<void> {
		try {
			await this.adapter.rmdir(this.sessionDir(id), true)
		} catch {
			/* No directory on disk. */
		}
		this.sessions.delete(id)
	}
}
