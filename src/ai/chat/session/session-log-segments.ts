import { normalizePath, Vault } from 'obsidian'
import {
	ATOMIC_BACKUP_MARKER,
	ATOMIC_TEMP_MARKER,
	atomicReplaceContent,
} from '~/utils/atomic-replace'
import { readLocalText } from '~/utils/local-vault-io'
import {
	agentPathKey,
	isJsonRecord,
	SESSION_INDEX_FILENAME,
	SESSION_LOG_FILENAME,
	SESSION_LOG_FORMAT_VERSION,
	SESSION_META_FILENAME,
	SESSION_SEGMENT_RETENTION_GENERATIONS,
	type JsonRecord,
	type SplitAgent,
} from './session-log-format'
import { SessionLogCorruptionError } from './session-log-parse'

export interface SessionLogBackendOptions {
	sessionsDir: string
	compactionBytes?: number
	/**
	 * R2b / S2: how long an already-loaded in-memory state may skip the
	 * write-before freshness probe (`index.json` read + `log.jsonl` stat).
	 *
	 * Every persist used to pay those two bridge calls even when the previous
	 * write was milliseconds earlier. A short TTL coalesces a burst of tool-call
	 * persists into one probe; an external writer (sync / second window) is
	 * detected at most one TTL late. Set `0` to force the old per-write probe.
	 */
	stateFreshnessTtlMs?: number
}

/** R2b / S2 default: one extra bridge probe per 2 s of writes, not per write. */
export const DEFAULT_STATE_FRESHNESS_TTL_MS = 2000

function isParseableJson(text: string): boolean {
	try {
		JSON.parse(text)
		return true
	} catch {
		return false
	}
}

export class SessionLogSegmentsBase {
	constructor(
		protected readonly vault: Vault,
		protected readonly options: SessionLogBackendOptions,
	) {}

	protected get adapter() {
		return this.vault.adapter
	}

	protected sessionDir(id: string) {
		return normalizePath(`${this.options.sessionsDir}/${id}`)
	}

	protected logPath(id: string) {
		return normalizePath(`${this.sessionDir(id)}/${SESSION_LOG_FILENAME}`)
	}

	protected indexPath(id: string) {
		return normalizePath(`${this.sessionDir(id)}/${SESSION_INDEX_FILENAME}`)
	}

	protected metaPath(id: string) {
		return normalizePath(`${this.sessionDir(id)}/${SESSION_META_FILENAME}`)
	}

	protected async readIndexInfo(id: string): Promise<{
		generation?: number
		activeSegment?: string
		formatVersion?: number
		/** The index belongs to a different session id (mis-synced/renamed). */
		ownerMismatch?: boolean
	}> {
		let text: string
		try {
			text = await readLocalText(this.vault, this.indexPath(id))
		} catch {
			return {}
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch {
			// Index is a rebuildable cache; malformed index must not block log replay.
			return {}
		}
		if (!isJsonRecord(parsed)) return {}
		const formatVersion =
			typeof parsed.formatVersion === 'number' ? parsed.formatVersion : 1
		if (formatVersion > SESSION_LOG_FORMAT_VERSION) {
			throw new SessionLogCorruptionError(
				`Unsupported session index format version ${formatVersion}`,
				0,
				text,
			)
		}
		// The writer records its own id in the index. An index carrying a different
		// id is a foreign sidecar (mis-synced/renamed directory): reject it instead
		// of materialising another session's content as this one (WS1-N2).
		if (typeof parsed.id === 'string' && parsed.id !== id) {
			return { formatVersion, ownerMismatch: true }
		}
		return {
			formatVersion,
			generation:
				typeof parsed.generation === 'number' ? parsed.generation : undefined,
			activeSegment:
				typeof parsed.activeSegment === 'string'
					? parsed.activeSegment
					: undefined,
		}
	}

	protected async writeIndexFile(
		id: string,
		generation: number,
		updatedAt: number,
		agents: SplitAgent[],
		activeSegment?: string,
	) {
		await atomicReplaceContent(
			this.vault,
			this.indexPath(id),
			JSON.stringify(
				{
					formatVersion: SESSION_LOG_FORMAT_VERSION,
					id,
					generation,
					updatedAt,
					...(activeSegment ? { activeSegment } : {}),
					agents: agents.map((agent) => ({
						pathKey: agentPathKey(agent.path),
						id: agent.id,
						messageCount: agent.messages.length,
					})),
				},
				null,
				2,
			),
			'text',
		)
	}

	async getLogSize(id: string): Promise<number> {
		try {
			const stat = await this.adapter.stat(this.logPath(id))
			return stat?.size ?? 0
		} catch {
			return 0
		}
	}

	protected async listSegmentEntries(
		id: string,
	): Promise<Array<{ file: string; name: string; generation: number }>> {
		try {
			const listed = await this.adapter.list(
				normalizePath(`${this.sessionDir(id)}/seg`),
			)
			return listed.files.flatMap((file) => {
				const name = normalizePath(file).split('/').pop() ?? ''
				const match = /^(\d+)-(\d+)\.json$/.exec(name)
				return match ? [{ file, name, generation: Number(match[1]) }] : []
			})
		} catch {
			return []
		}
	}

	protected async promoteSessionTemps(id: string): Promise<void> {
		await this.promoteTempsInDirectory(this.sessionDir(id))
		await this.promoteTempsInDirectory(
			normalizePath(`${this.sessionDir(id)}/seg`),
		)
	}

	protected async promoteTempsInDirectory(directory: string): Promise<void> {
		let listed: { files: string[] }
		try {
			listed = await this.adapter.list(directory)
		} catch {
			return
		}
		for (const file of listed.files) {
			const normalizedFile = normalizePath(file)
			const slash = normalizedFile.lastIndexOf('/')
			const parent = slash >= 0 ? normalizedFile.slice(0, slash) : ''
			if (parent !== directory) continue
			const name = normalizedFile.slice(slash + 1)
			const tempMarker = name.lastIndexOf(ATOMIC_TEMP_MARKER)
			const backupMarker = name.lastIndexOf(ATOMIC_BACKUP_MARKER)
			if (tempMarker > 0) {
				await this.recoverAtomicArtifact(directory, name, tempMarker)
			} else if (backupMarker > 0) {
				await this.recoverBackupArtifact(directory, name, backupMarker)
			}
		}
	}

	protected async recoverAtomicArtifact(
		directory: string,
		name: string,
		markerIndex: number,
	): Promise<void> {
		const targetName = name.slice(0, markerIndex)
		if (!targetName) return
		const file = normalizePath(`${directory}/${name}`)
		const targetPath = normalizePath(`${directory}/${targetName}`)
		try {
			const tempText = await readLocalText(this.vault, file)
			if (tempText.length === 0) {
				// Crash before the temp body was written; it can never be
				// installed and would otherwise accumulate forever, even when
				// the target is absent.
				await this.adapter.remove(file)
				return
			}
			const targetExists = await this.adapter.exists(targetPath)
			if (!targetExists) {
				// A complete temp that never made it to the target is the best
				// surviving copy; promote it.
				JSON.parse(tempText)
				await this.adapter.rename(file, targetPath)
				return
			}
			const targetText = await readLocalText(this.vault, targetPath)
			const targetValid = isParseableJson(targetText)
			const tempValid = isParseableJson(tempText)
			if (targetValid || !tempValid) {
				// Target is published/usable (or neither copy parses): keep the
				// target and drop the stale sibling.
				await this.adapter.remove(file)
				return
			}
			// Target exists but is corrupt while the temp parses: prefer the temp.
			await this.adapter.write(targetPath, tempText)
			await this.adapter.remove(file)
		} catch {
			/* Leave incomplete/corrupt artifacts for diagnostics. */
		}
	}

	protected async recoverBackupArtifact(
		directory: string,
		name: string,
		markerIndex: number,
	): Promise<void> {
		const targetName = name.slice(0, markerIndex)
		if (!targetName) return
		const file = normalizePath(`${directory}/${name}`)
		const targetPath = normalizePath(`${directory}/${targetName}`)
		try {
			const backupText = await readLocalText(this.vault, file)
			if (backupText.length === 0) {
				await this.adapter.remove(file)
				return
			}
			const targetExists = await this.adapter.exists(targetPath)
			if (!targetExists) {
				JSON.parse(backupText)
				await this.adapter.rename(file, targetPath)
				return
			}
			const targetText = await readLocalText(this.vault, targetPath)
			const targetValid = isParseableJson(targetText)
			const backupValid = isParseableJson(backupText)
			if (targetValid || !backupValid) {
				await this.adapter.remove(file)
				return
			}
			await this.adapter.write(targetPath, backupText)
			await this.adapter.remove(file)
		} catch {
			/* Leave incomplete/corrupt artifacts for diagnostics. */
		}
	}

	async recoverPendingTemps(): Promise<void> {
		let listed: { folders: string[] }
		try {
			listed = await this.adapter.list(this.options.sessionsDir)
		} catch {
			return
		}
		for (const folder of listed.folders) {
			const id = normalizePath(folder).split('/').pop() ?? ''
			if (!id) continue
			await this.promoteSessionTemps(id)
		}
	}

	protected async pruneOldSegments(id: string, activeSegment: string) {
		try {
			const entries = await this.listSegmentEntries(id)
			if (entries.length <= SESSION_SEGMENT_RETENTION_GENERATIONS + 1) return
			const sorted = entries.slice().sort((left, right) => {
				return (
					left.generation - right.generation ||
					left.name.localeCompare(right.name)
				)
			})
			const keep = new Set<string>()
			const activeIndex = sorted.findIndex(
				(entry) => entry.name === activeSegment,
			)
			if (activeIndex >= 0) {
				keep.add(sorted[activeIndex].name)
				for (
					let offset = 1;
					offset <= SESSION_SEGMENT_RETENTION_GENERATIONS;
					offset += 1
				) {
					const candidate = sorted[activeIndex - offset]
					if (candidate) keep.add(candidate.name)
				}
			} else {
				for (
					let index = Math.max(
						0,
						sorted.length - SESSION_SEGMENT_RETENTION_GENERATIONS - 1,
					);
					index < sorted.length;
					index += 1
				) {
					keep.add(sorted[index].name)
				}
			}
			for (const entry of sorted) {
				if (keep.has(entry.name)) continue
				try {
					await this.adapter.remove(entry.file)
				} catch (error) {
					console.warn('[session-log] failed to remove old segment', error)
				}
			}
		} catch (error) {
			console.warn('[session-log] failed to prune old segments', error)
		}
	}

	/**
	 * A segment whose generation is beyond `index.generation + 1` is either an
	 * orphan from an aborted compaction (stale, must be ignored) or an externally
	 * synced newer generation (index is stale, must be used). File mtimes
	 * disambiguate: only when the index is older than such a segment do we treat
	 * the index as stale and allow it (K16).
	 */
	private async indexIsOlderThanSegments(
		id: string,
		entries: Array<{ file: string }>,
	): Promise<boolean> {
		try {
			const indexStat = await this.adapter.stat(this.indexPath(id))
			const indexMtime = indexStat?.mtime
			if (typeof indexMtime !== 'number') return false
			for (const entry of entries) {
				const stat = await this.adapter.stat(entry.file)
				const mtime = stat?.mtime
				if (typeof mtime === 'number' && mtime > indexMtime) return true
			}
		} catch {
			/* Fall back to the conservative generation cap below. */
		}
		return false
	}

	protected async readLatestSegment(
		id: string,
		index: {
			generation?: number
			activeSegment?: string
			ownerMismatch?: boolean
		} = {},
	): Promise<{ record: JsonRecord; authoritative: boolean } | null> {
		// A foreign index means the directory holds another session's sidecars;
		// do not materialise its segments as this session (WS1-N2).
		if (index.ownerMismatch) return null
		try {
			const listed = await this.adapter.list(
				normalizePath(`${this.sessionDir(id)}/seg`),
			)
			const candidates = listed.files
				.map((file) => {
					const name = normalizePath(file).split('/').pop() ?? ''
					const match = /^(\d+)-(\d+)\.json$/.exec(name)
					return {
						file,
						name,
						generation: match ? Number(match[1]) : undefined,
					}
				})
				.filter(
					(
						entry,
					): entry is { file: string; name: string; generation: number } =>
						typeof entry.generation === 'number',
				)

			if (index.activeSegment) {
				const active = candidates.find(
					(entry) => entry.name === index.activeSegment,
				)
				if (active) {
					const record = await this.readSegment(active.file)
					return record ? { record, authoritative: true } : null
				}
			}

			let eligible = candidates
			const maxGeneration = index.generation
			if (typeof maxGeneration === 'number') {
				const capped = candidates.filter(
					(entry) => entry.generation <= maxGeneration + 1,
				)
				if (capped.length > 0) eligible = capped
				const beyond = candidates.filter(
					(entry) => entry.generation > maxGeneration + 1,
				)
				// The index may itself be stale (external sync wrote a newer
				// segment). Only trust the newer generation when the index file is
				// demonstrably older; otherwise keep the conservative cap so an
				// aborted-compaction orphan is still ignored (WS1-N3).
				if (
					capped.length > 0 &&
					beyond.length > 0 &&
					(await this.indexIsOlderThanSegments(id, beyond))
				) {
					eligible = candidates
				}
			}
			eligible.sort(
				(left, right) =>
					left.generation - right.generation ||
					left.name.localeCompare(right.name),
			)
			const selected = eligible.at(-1)
			if (selected) {
				const record = await this.readSegment(selected.file)
				return record ? { record, authoritative: false } : null
			}

			// Last-resort compatibility for unexpected segment filenames.
			const fallback = listed.files.slice().sort().at(-1)
			if (!fallback) return null
			const record = await this.readSegment(fallback)
			return record ? { record, authoritative: false } : null
		} catch {
			return null
		}
	}

	private async readSegment(file: string): Promise<JsonRecord | null> {
		try {
			const parsed: unknown = JSON.parse(await readLocalText(this.vault, file))
			return isJsonRecord(parsed) ? { type: 'snapshot', session: parsed } : null
		} catch {
			return null
		}
	}
}
