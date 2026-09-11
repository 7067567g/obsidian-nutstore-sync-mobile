export interface OpsGcFile {
	path: string
	size: number
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
}

export interface OpsGcBackend {
	listSessionIds(): Promise<string[]>
	readSessionOperationRefPaths(id: string): Promise<string[]>
	listOperationFiles(): Promise<OpsGcFile[]>
	removeOperationFiles(paths: string[]): Promise<void>
}

export interface OpsGcOptions {
	/** Delete orphan sidecars instead of only reporting them. */
	deleteOrphans?: boolean
}

/**
 * Garbage-collect orphan `ops/` sidecars. The default is report-only; callers
 * must opt in to deletion so a bug in reference collection can never silently
 * destroy recovery snapshots.
 */
export async function runOpsGc(
	backend: OpsGcBackend,
	options: OpsGcOptions = {},
): Promise<OpsGcReport> {
	const mode: OpsGcReport['mode'] = options.deleteOrphans ? 'delete' : 'report'
	const errors: string[] = []
	const references = new Set<string>()
	let scannedSessions = 0

	let ids: string[] = []
	try {
		ids = await backend.listSessionIds()
	} catch (error) {
		errors.push(
			`listSessionIds: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	for (const id of ids) {
		scannedSessions += 1
		try {
			for (const path of await backend.readSessionOperationRefPaths(id)) {
				references.add(path)
			}
		} catch (error) {
			errors.push(
				`${id}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	let files: OpsGcFile[] = []
	try {
		files = await backend.listOperationFiles()
	} catch (error) {
		errors.push(
			`listOperationFiles: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const orphans = files.filter((file) => !references.has(file.path))
	const deletedFiles: string[] = []
	if (mode === 'delete' && orphans.length > 0) {
		try {
			await backend.removeOperationFiles(orphans.map((file) => file.path))
			deletedFiles.push(...orphans.map((file) => file.path))
		} catch (error) {
			errors.push(
				`deleteOrphans: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	return {
		mode,
		scannedSessions,
		referencedFiles: references.size,
		scannedFiles: files.length,
		orphanFiles: orphans.map((file) => file.path),
		orphanBytes: orphans.reduce((total, file) => total + file.size, 0),
		deletedFiles,
		errors,
	}
}
