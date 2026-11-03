import type NutstorePlugin from '~/index'
import { formatLocalTimestampForFilename } from '~/utils/local-date'
import logger from '~/utils/logger'
import { DIAGNOSTICS_EXPORT_DIR } from './log-file'
import { perfMetrics } from './perf-metrics'
import { runSelfCheck } from './self-check'
import { readStartupState } from './startup-state'

export const PERF_SNAPSHOT_FILE = `${DIAGNOSTICS_EXPORT_DIR}/perf-snapshot.json`

export interface ExportDiagnosticsOptions {
	reason?: 'startup' | 'manual'
	fileName?: string
}

/**
 * Collects a privacy-conscious diagnostics package and writes it into
 * `.agents/nutstore-sync/diagnostics/`. The package contains capability flags,
 * timings/counters and recent plugin logs; it never includes account
 * credentials, vault document bodies, or chat message content.
 */
/**
 * Lightweight runtime perf snapshot for long tasks and lifecycle exits. The
 * full diagnostics package is written only at startup; this file is rewritten
 * on pagehide/visibility-hidden/unload so heartbeat and bridge counters are
 * observable after the relevant work has already happened.
 */
export async function exportPerfSnapshot(
	plugin: NutstorePlugin,
	options: { reason: 'visibility' | 'pagehide' | 'unload' | 'manual' } = {
		reason: 'manual',
	},
): Promise<string> {
	const payload = {
		schemaVersion: 1,
		reason: options.reason,
		generatedAt: new Date().toISOString(),
		plugin: {
			id: plugin.manifest.id,
			version: plugin.manifest.version,
		},
		startupState: await readStartupState(plugin.app),
		perf: perfMetrics.snapshot(),
	}
	await plugin.diagnosticsLogFile.ensureDirectory(DIAGNOSTICS_EXPORT_DIR)
	await plugin.app.vault.adapter.write(
		PERF_SNAPSHOT_FILE,
		`${JSON.stringify(payload, null, 2)}\n`,
	)
	return PERF_SNAPSHOT_FILE
}

export async function exportDiagnosticsPackage(
	plugin: NutstorePlugin,
	options: ExportDiagnosticsOptions = {},
): Promise<string> {
	const reason = options.reason ?? 'manual'
	const now = new Date()
	const selfCheck = plugin.selfCheckReport ?? (await runSelfCheck(plugin))
	plugin.selfCheckReport = selfCheck
	await plugin.diagnosticsLogFile.flush()
	const [recentLog, logFiles] = await Promise.all([
		plugin.diagnosticsLogFile.readRecent(256 * 1024),
		plugin.diagnosticsLogFile.listLogFiles(),
	])
	const startupState = await readStartupState(plugin.app)
	const payload = {
		schemaVersion: 1,
		reason,
		generatedAt: now.toISOString(),
		plugin: {
			id: plugin.manifest.id,
			version: plugin.manifest.version,
		},
		selfCheck,
		startupState,
		perf: perfMetrics.snapshot(),
		logFiles,
		recentLog,
	}
	await plugin.diagnosticsLogFile.ensureDirectory(DIAGNOSTICS_EXPORT_DIR)
	const fileName =
		options.fileName ??
		(reason === 'startup'
			? 'startup-diagnostics.json'
			: `nutstore-diagnostics-${formatLocalTimestampForFilename(now)}.json`)
	const filePath = `${DIAGNOSTICS_EXPORT_DIR}/${fileName}`
	await plugin.app.vault.adapter.write(
		filePath,
		`${JSON.stringify(payload, null, 2)}\n`,
	)
	logger.info('Diagnostics package exported', { filePath, reason })
	return filePath
}
