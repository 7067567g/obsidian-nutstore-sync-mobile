import { describe, expect, it } from 'vitest'
import { ALL_CASES } from './gitignore-oracle-cases'

describe('Git-generated filter-rule oracle', () => {
	it('contains a broad compatibility corpus', () => {
		expect(ALL_CASES.length).toBeGreaterThanOrEqual(200)
	})
})
