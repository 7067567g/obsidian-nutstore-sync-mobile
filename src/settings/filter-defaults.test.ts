import { describe, expect, it } from 'vitest'
import { compileFilterRules, isPathIncluded } from '~/utils/glob-match'
import { DEFAULT_SETTINGS } from './index'

const defaultRules = compileFilterRules(DEFAULT_SETTINGS.filterRules.rules)

describe('default filter rules exclude atomic artifacts (A17)', () => {
	it('excludes orphan backup markers so they are not synced as user content', () => {
		expect(
			isPathIncluded(
				'.agents/nutstore-sync/x.json.nutstore-sync-backup-1-a',
				defaultRules,
			),
		).toBe(false)
		expect(
			isPathIncluded(
				'notes/deep/nested.md.nutstore-sync-backup-171234-xyz',
				defaultRules,
			),
		).toBe(false)
	})

	it('excludes atomic temp markers', () => {
		expect(
			isPathIncluded(
				'notes/deep/nested.md.nutstore-sync-temp-171234-xyz',
				defaultRules,
			),
		).toBe(false)
	})

	it('still includes ordinary user content', () => {
		expect(isPathIncluded('notes/deep/nested.md', defaultRules)).toBe(true)
	})
})
