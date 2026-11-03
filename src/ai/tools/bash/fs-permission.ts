const SENSITIVE_INTERNAL_BASH_PATHS = [
	'/.git',
	'/.agents/nutstore-sync/sessions',
	'/.agents/nutstore-sync/ops',
	'/.agents/nutstore-sync/diagnostics',
	'/.agents/nutstore-sync/logs',
	'/.agents/nutstore-sync/spill',
]

function normalizePermissionPath(path: string) {
	const normalized = path.startsWith('/') ? path : `/${path}`
	return normalized.replace(/\/+$/, '') || '/'
}

export function isSensitivePermissionPath(path: string, configDir: string) {
	const normalized = normalizePermissionPath(path)
	const configPrefix = `/${configDir.replace(/^\/+/, '').replace(/\/+$/, '')}`
	const prefixes = [configPrefix, ...SENSITIVE_INTERNAL_BASH_PATHS]
	return prefixes.some(
		(prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
	)
}

/**
 * D-005: recorded reason for a vault filesystem that is deliberately built
 * without a permission guard. Every unguarded write path must declare one of
 * these; without a guard AND without a declaration writes fail closed.
 */
export type UnguardedWriteReason =
	| 'user-recall'
	| 'test-harness'
	| 'bash-command'
