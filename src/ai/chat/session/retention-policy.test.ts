import { describe, expect, it } from 'vitest'
import {
	DEFAULT_RETENTION_POLICY,
	RETENTION_CATEGORIES,
	RETENTION_MODES,
	formatRetentionPolicyTable,
	isRetentionExpired,
	isRetentionProtectedPath,
	normalizeRetentionPolicy,
} from './retention-policy'

const DAY = 24 * 60 * 60 * 1000

describe('retention policy', () => {
	it('freezes the conservative six-class defaults', () => {
		expect(DEFAULT_RETENTION_POLICY).toEqual({
			sessions: { generations: 2, days: 0 },
			ops: { generations: 0, days: 7 },
			spill: { generations: 0, days: 30 },
			trash: { generations: 0, days: 0 },
			tmp: { generations: 0, days: 7 },
			diagnostics: { generations: 3, days: 30 },
		})
		expect(RETENTION_CATEGORIES).toHaveLength(6)
		expect(RETENTION_MODES.sessions).toBe('report')
		expect(RETENTION_MODES.trash).toBe('report')
		expect(RETENTION_MODES.ops).toBe('orphan')
	})

	it('normalizes partial/invalid overrides over the defaults', () => {
		const policy = normalizeRetentionPolicy({
			spill: { days: 3.9 },
			tmp: { days: -5, generations: 2 },
			diagnostics: { days: 'forever' },
			bogus: { days: 1 },
		})
		expect(policy.spill).toEqual({ generations: 0, days: 3 })
		expect(policy.tmp).toEqual({ generations: 2, days: 7 })
		expect(policy.diagnostics).toEqual({ generations: 3, days: 30 })
		expect(policy.sessions).toEqual(DEFAULT_RETENTION_POLICY.sessions)
		expect(policy).not.toHaveProperty('bogus')
	})

	it('never expires days=0 or unknown mtimes', () => {
		const now = 100 * DAY
		expect(isRetentionExpired({ generations: 0, days: 0 }, 1, now)).toBe(false)
		expect(
			isRetentionExpired({ generations: 0, days: 7 }, undefined, now),
		).toBe(false)
		expect(isRetentionExpired({ generations: 0, days: 7 }, 0, now)).toBe(false)
		expect(
			isRetentionExpired({ generations: 0, days: 7 }, now - 7 * DAY, now),
		).toBe(true)
		expect(
			isRetentionExpired({ generations: 0, days: 7 }, now - 7 * DAY + 1, now),
		).toBe(false)
	})

	it('protects rolling diagnostics logs from age deletion', () => {
		expect(
			isRetentionProtectedPath('diagnostics', '.agents/logs/plugin-log.txt'),
		).toBe(true)
		expect(
			isRetentionProtectedPath('diagnostics', '.agents/logs/plugin-log.2.txt'),
		).toBe(true)
		expect(
			isRetentionProtectedPath(
				'diagnostics',
				'.agents/diagnostics/nutstore-diagnostics-x.json',
			),
		).toBe(false)
		expect(isRetentionProtectedPath('spill', 'plugin-log.txt')).toBe(false)
	})

	it('renders a readable six-row table', () => {
		const table = formatRetentionPolicyTable(
			normalizeRetentionPolicy(DEFAULT_RETENTION_POLICY),
		)
		const lines = table.split('\n')
		expect(lines).toHaveLength(7)
		expect(lines[0]).toBe('category\tgenerations\tdays\tmode')
		for (const category of RETENTION_CATEGORIES) {
			expect(table).toContain(category)
		}
		expect(table).toContain('sessions\t2\t0\treport')
		expect(table).toContain('ops\t0\t7\torphan')
	})
})
