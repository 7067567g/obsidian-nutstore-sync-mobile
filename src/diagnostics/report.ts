import type NutstorePlugin from '..'
import { formatLocalTimestampForFilename } from '~/utils/local-date'
import logger from '~/utils/logger'
import { DIAGNOSTICS_EXPORT_DIR } from './log-file'
import { perfMetrics } from './perf-metrics'
import { runSelfCheck } from './self-check'

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
	const payload = {
		schemaVersion: 1,
		reason,
		generatedAt: now.toISOString(),
		plugin: {
			id: plugin.manifest.id,
			version: plugin.manifest.version,
		},
		selfCheck,
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
