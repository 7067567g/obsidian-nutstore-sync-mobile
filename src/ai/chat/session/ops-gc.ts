import {
	DEFAULT_RETENTION_POLICY,
	RETENTION_CATEGORIES,
	RETENTION_MODES,
	isRetentionExpired,
	isRetentionProtectedPath,
	normalizeRetentionPolicy,
	type RetentionCategory,
	type RetentionPolicy,
	type RetentionRule,
} from './retention-policy'

export interface OpsGcFile {
	path: string
	size: number
	/** Adapter mtime in epoch ms; undefined when the adapter cannot report it. */
	mtime?: number
}

/** One file discovered while scanning a retention class. */
export interface RetentionFile extends OpsGcFile {
	category: RetentionCategory
}

export interface RetentionScanResult {
	files: RetentionFile[]
	/** Categories whose scan hit the file cap and under-counts. */
	truncated?: RetentionCategory[]
}

export interface RetentionCategoryReport {
	category: RetentionCategory
	rule: RetentionRule
	mode: (typeof RETENTION_MODES)[RetentionCategory]
	files: number
	bytes: number
	expiredFiles: number
	expiredBytes: number
	deletedFiles: number
	deletedBytes: number
}

export interface RetentionReport {
	policy: RetentionPolicy
	categories: Record<RetentionCategory, RetentionCategoryReport>
	expiredFiles: string[]
	deletedFiles: string[]
	truncated: RetentionCategory[]
}

export interface OpsGcReport {
	mode: 'report' | 'delete'
	scannedSessions: number
	referencedFiles: number
	scannedFiles: number
	orphanFiles: string[]
	orphanBytes: number
	deletedFiles: string[]
	errors: string[]
	/** Present even when the backend cannot enumerate retention classes. */
	retention: RetentionReport
	/** Set when orphan deletion was intentionally skipped for safety. */
	deletionSkippedReason?: string
}

export interface OpsGcBackend {
	listSessionIds(): Promise<string[]>
	readSessionOperationRefPaths(id: string): Promise<string[]>
	listOperationFiles(): Promise<OpsGcFile[]>
	removeOperationFiles(paths: string[]): Promise<void>
	/** Optional six-class scan; backends without it get an empty report. */
	listRetentionFiles?(): Promise<RetentionScanResult>
	/** Optional deletion hook for the six-class retention report. */
	removeRetentionFiles?(paths: string[]): Promise<void>
}

export interface RetentionGcOptions {
	policy?: Partial<RetentionPolicy> | RetentionPolicy
	/** Default false: the startup scan and service report never delete. */
	deleteExpired?: boolean
	/** Injectable clock for tests. */
	now?: number
}

export interface OpsGcOptions {
	/** Delete orphan ops/ sidecars instead of only reporting them. */
	deleteOrphans?: boolean
	/** Extend the report to sessions/ops/spill/trash/tmp/diagnostics. */
	retention?: RetentionGcOptions
}

function emptyCategory(
	category: RetentionCategory,
	rule: RetentionRule,
): RetentionCategoryReport {
	return {
		category,
		rule,
		mode: RETENTION_MODES[category],
		files: 0,
		bytes: 0,
		expiredFiles: 0,
		expiredBytes: 0,
		deletedFiles: 0,
		deletedBytes: 0,
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

async function buildRetentionReport(
	backend: OpsGcBackend,
	options: RetentionGcOptions,
	errors: string[],
): Promise<RetentionReport> {
	const policy = normalizeRetentionPolicy(
		options.policy ?? DEFAULT_RETENTION_POLICY,
	)
	const categories = {} as Record<RetentionCategory, RetentionCategoryReport>
	for (const category of RETENTION_CATEGORIES) {
		categories[category] = emptyCategory(category, policy[category])
	}
	const expiredFiles: string[] = []
	const deletedFiles: string[] = []
	const truncated: RetentionCategory[] = []
	if (!backend.listRetentionFiles) {
		return { policy, categories, expiredFiles, deletedFiles, truncated }
	}

	let scan: RetentionScanResult
	try {
		scan = await backend.listRetentionFiles()
	} catch (error) {
		errors.push(`listRetentionFiles: ${errorMessage(error)}`)
		return { policy, categories, expiredFiles, deletedFiles, truncated }
	}
	truncated.push(...(scan.truncated ?? []))

	const expiredByPath = new Map<string, RetentionFile>()
	const now = options.now ?? Date.now()
	for (const file of scan.files) {
		const category = file.category
		if (!RETENTION_CATEGORIES.includes(category)) continue
		const report = categories[category]
		report.files += 1
		report.bytes += file.size
		if (RETENTION_MODES[category] !== 'age') continue
		if (isRetentionProtectedPath(category, file.path)) continue
		if (!isRetentionExpired(policy[category], file.mtime, now)) continue
		report.expiredFiles += 1
		report.expiredBytes += file.size
		expiredFiles.push(file.path)
		expiredByPath.set(file.path, file)
	}

	if (!options.deleteExpired || expiredByPath.size === 0) {
		return { policy, categories, expiredFiles, deletedFiles, truncated }
	}
	if (!backend.removeRetentionFiles) {
		errors.push('retention: backend does not support deletion')
		return { policy, categories, expiredFiles, deletedFiles, truncated }
	}
	try {
		await backend.removeRetentionFiles([...expiredByPath.keys()])
		for (const file of expiredByPath.values()) {
			const report = categories[file.category]
			report.deletedFiles += 1
			report.deletedBytes += file.size
			deletedFiles.push(file.path)
		}
	} catch (error) {
		errors.push(`removeRetentionFiles: ${errorMessage(error)}`)
	}
	return { policy, categories, expiredFiles, deletedFiles, truncated }
}

/**
 * Garbage-collect orphan `ops/` sidecars and report the six retention classes.
 *
 * Orphan deletion is opt-in and fails closed: if the session list cannot be
 * enumerated, or any session's operation refs cannot be read, deletion is
 * skipped entirely. A bug in reference collection must never destroy recovery
 * snapshots. Age-based retention deletion is likewise opt-in
 * (`deleteExpired`), and `sessions`/`trash` are report-only by policy.
 */
export async function runOpsGc(
	backend: OpsGcBackend,
	options: OpsGcOptions = {},
): Promise<OpsGcReport> {
	const mode: OpsGcReport['mode'] = options.deleteOrphans ? 'delete' : 'report'
	const errors: string[] = []
	const references = new Set<string>()
	let scannedSessions = 0
	let sessionsListed = true
	let referenceReadFailures = 0

	let ids: string[] = []
	try {
		ids = await backend.listSessionIds()
	} catch (error) {
		sessionsListed = false
		errors.push(`listSessionIds: ${errorMessage(error)}`)
	}

	for (const id of ids) {
		scannedSessions += 1
		try {
			for (const path of await backend.readSessionOperationRefPaths(id)) {
				references.add(path)
			}
		} catch (error) {
			referenceReadFailures += 1
			errors.push(`${id}: ${errorMessage(error)}`)
		}
	}

	let files: OpsGcFile[] = []
	try {
		files = await backend.listOperationFiles()
	} catch (error) {
		errors.push(`listOperationFiles: ${errorMessage(error)}`)
	}
	const orphans = files.filter((file) => !references.has(file.path))
	const deletedFiles: string[] = []
	let deletionSkippedReason: string | undefined
	// Orphans inside the grace window are reported but never deleted. This
	// applies to every delete call (default policy when no override is passed):
	// explicit deletion must not be able to erase a just-written sidecar.
	const opsRule = normalizeRetentionPolicy(
		options.retention?.policy ?? DEFAULT_RETENTION_POLICY,
	).ops
	const now = options.retention?.now ?? Date.now()
	const deletableOrphans = orphans.filter((file) =>
		isRetentionExpired(opsRule, file.mtime, now),
	)
	if (mode === 'delete' && orphans.length > 0) {
		if (!sessionsListed) {
			deletionSkippedReason =
				'session list unavailable; refusing to delete unreferenced ops sidecars'
		} else if (referenceReadFailures > 0) {
			deletionSkippedReason =
				'some session operation refs were unreadable; refusing to delete'
		} else if (deletableOrphans.length === 0) {
			deletionSkippedReason = `orphan sidecars are inside the ${opsRule.days}-day grace window`
		}
		if (deletionSkippedReason) {
			errors.push(`deleteOrphans: ${deletionSkippedReason}`)
		} else {
			try {
				await backend.removeOperationFiles(
					deletableOrphans.map((file) => file.path),
				)
				deletedFiles.push(...deletableOrphans.map((file) => file.path))
			} catch (error) {
				errors.push(`deleteOrphans: ${errorMessage(error)}`)
			}
		}
	}

	const retention = await buildRetentionReport(
		backend,
		options.retention ?? {},
		errors,
	)

	return {
		mode,
		scannedSessions,
		referencedFiles: references.size,
		scannedFiles: files.length,
		orphanFiles: orphans.map((file) => file.path),
		orphanBytes: orphans.reduce((total, file) => total + file.size, 0),
		deletedFiles,
		errors,
		retention,
		...(deletionSkippedReason ? { deletionSkippedReason } : {}),
	}
}

/** One-line-per-class report for logs; keeps the six byte counts readable. */
export function formatOpsGcReport(report: OpsGcReport): string {
	const mode = report.retention.policy
	const lines = [
		`ops-gc mode=${report.mode} sessions=${report.scannedSessions} refs=${report.referencedFiles} ops-files=${report.scannedFiles} orphans=${report.orphanFiles.length} (${report.orphanBytes} B)`,
	]
	for (const category of RETENTION_CATEGORIES) {
		const entry = report.retention.categories[category]
		const rule = mode[category]
		lines.push(
			`${category}: files=${entry.files} bytes=${entry.bytes} expired=${entry.expiredFiles}/${entry.expiredBytes}B deleted=${entry.deletedFiles} generations=${rule.generations} days=${rule.days} mode=${entry.mode}`,
		)
	}
	if (report.deletionSkippedReason) {
		lines.push(`delete skipped: ${report.deletionSkippedReason}`)
	}
	for (const error of report.errors) lines.push(`error: ${error}`)
	return lines.join('\n')
}
