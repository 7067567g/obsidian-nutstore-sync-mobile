/**
 * Data-retention policy for the six plugin-managed storage classes (#102).
 *
 * The defaults are deliberately conservative:
 * - `sessions` and `trash` are report-only: they contain user data and are
 *   never deleted by age. Session segments are bounded by the existing
 *   compaction policy (active + previous generation).
 * - `ops` is orphan-only: a sidecar is deletable only when no session
 *   references it, after the configured grace period. Referenced sidecars are
 *   never age-deleted.
 * - `spill`, `tmp` and `diagnostics` exports may be age-deleted, but only when
 *   a caller explicitly asks for deletion (`deleteExpired`); the startup scan
 *   and `runOpsGcReport()` stay report-only.
 *
 * `days: 0` means "never expire by age" and `generations: 0` means "this class
 * is not generation-managed in code". Generations that are enforced elsewhere
 * (session segments, rolling diagnostics logs) are documented here so the
 * settings defaults and the docs cannot drift.
 */

export const RETENTION_CATEGORIES = [
	'sessions',
	'ops',
	'spill',
	'trash',
	'tmp',
	'diagnostics',
] as const

export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number]

/**
 * How a category is cleaned:
 * - `age`: files older than `days` may be removed.
 * - `orphan`: only unreferenced files older than `days` may be removed.
 * - `report`: never remove automatically (user data / report only).
 */
export type RetentionMode = 'age' | 'orphan' | 'report'

export interface RetentionRule {
	/** Generation cap enforced by the owning subsystem; 0 = not managed here. */
	generations: number
	/** Age cap in days; 0 = never expire by age. */
	days: number
}

export type RetentionPolicy = Record<RetentionCategory, RetentionRule>

export const RETENTION_MODES: Readonly<
	Record<RetentionCategory, RetentionMode>
> = {
	sessions: 'report',
	ops: 'orphan',
	spill: 'age',
	trash: 'report',
	tmp: 'age',
	diagnostics: 'age',
}

/**
 * Accepted defaults (PD-3 option B): a fixed, conservative baseline that the
 * settings object can override. The table is mirrored in
 * `docs/25-项目收口规则与执行口径.md` §3.1 and must stay in sync.
 */
export const DEFAULT_RETENTION_POLICY: Readonly<RetentionPolicy> = {
	sessions: { generations: 2, days: 0 },
	ops: { generations: 0, days: 7 },
	spill: { generations: 0, days: 30 },
	trash: { generations: 0, days: 0 },
	tmp: { generations: 0, days: 7 },
	diagnostics: { generations: 3, days: 30 },
}

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_RETENTION_DAYS = 3650
const MAX_RETENTION_GENERATIONS = 100

function normalizeCount(value: unknown, fallback: number, max: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
	const truncated = Math.trunc(value)
	if (truncated < 0) return fallback
	return Math.min(truncated, max)
}

/** Merge a persisted/partial policy over the defaults without sharing objects. */
export function normalizeRetentionPolicy(input: unknown): RetentionPolicy {
	const source =
		input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
	const policy = {} as RetentionPolicy
	for (const category of RETENTION_CATEGORIES) {
		const defaults = DEFAULT_RETENTION_POLICY[category]
		const raw = source[category]
		const rule =
			raw && typeof raw === 'object'
				? (raw as Record<string, unknown>)
				: undefined
		policy[category] = {
			generations: rule
				? normalizeCount(
						rule.generations,
						defaults.generations,
						MAX_RETENTION_GENERATIONS,
					)
				: defaults.generations,
			days: rule
				? normalizeCount(rule.days, defaults.days, MAX_RETENTION_DAYS)
				: defaults.days,
		}
	}
	return policy
}

/** True when the file may be removed by age under this rule at `now`. */
export function isRetentionExpired(
	rule: RetentionRule,
	modifiedAt: number | undefined,
	now: number,
): boolean {
	if (rule.days <= 0) return false
	if (typeof modifiedAt !== 'number' || !Number.isFinite(modifiedAt)) {
		return false
	}
	if (modifiedAt <= 0) return false
	return now - modifiedAt >= rule.days * DAY_MS
}

/** Rolling diagnostics logs are rotated by generation, never age-deleted. */
export function isRetentionProtectedPath(
	category: RetentionCategory,
	path: string,
): boolean {
	if (category !== 'diagnostics') return false
	const name = path.split('/').pop() ?? ''
	return name.startsWith('plugin-log')
}

/** Human-readable policy table used by the docs test / diagnostics output. */
export function formatRetentionPolicyTable(policy: RetentionPolicy): string {
	const header = 'category\tgenerations\tdays\tmode'
	const rows = RETENTION_CATEGORIES.map((category) => {
		const rule = policy[category]
		return `${category}\t${rule.generations}\t${rule.days}\t${RETENTION_MODES[category]}`
	})
	return [header, ...rows].join('\n')
}
